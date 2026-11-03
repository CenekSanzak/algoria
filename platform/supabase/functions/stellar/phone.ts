// The `phone-call` service: one real outbound call to any number, held by a realtime AI voice.
//
// The voice bridge (Twilio Media Streams <-> OpenAI Realtime) is the demo API's, in ../api/phone.ts.
// This file adds what a paid, call-anyone service needs on top of it:
//
// - Checks before any payment [P8], so nobody pays for a call that can't be placed: the number is a
//   real number (libphonenumber, offline) and not premium-rate; its owner did not opt out; the Twilio
//   account may call that country; and a trial Twilio account only calls its verified numbers. The
//   Twilio lookups are cached and fail open: a definite "no" refuses, an outage does not.
// - The job lifecycle on Supabase's request model. Nothing runs between requests, so the job moves
//   on whatever reaches it first: a Twilio status callback, the voice bridge, a client's status
//   request or the minute sweep. A dial is claimed once and never repeated, even when Twilio's answer
//   was lost: the phone may already be ringing.

import { parsePhoneNumberFromString } from 'npm:libphonenumber-js@1.13.15/max';
import {
  type CallRepository,
  CallSession,
  type PhoneLanguage,
  type SessionDependencies,
  signJob,
  type Summarizer,
  tokenValid,
  type TranscriptLine,
  Twilio,
  TwilioError,
  xml,
} from '../api/phone.ts';
import type { PhoneConfig } from '../api/config.ts';
import { CALL_STATUSES, PHONE_OUTPUT_SCHEMA } from './manifest.ts';
import { type InputError, jobError, type JsonObject, sha256Hex } from './protocol.ts';
import { validate } from './schema.ts';
import type { JobStore, StellarJob } from './store.ts';

export type PhoneCallInput = {
  to: string;
  goal: string;
  on_behalf_of: string;
  callee_name?: string;
  language?: PhoneLanguage;
};

const NOT_CONNECTED = ['busy', 'no-answer', 'failed', 'canceled'];
/** A call nobody reported the end of is finished this long after it was placed. */
const CALL_DEADLINE_MS = 6 * 60_000;
const CACHE_MS = 10 * 60_000;
const TWILIO_TIMEOUT_MS = 5000;

/** The number's key for limits and opt-outs: a hash, so neither table keeps the number. */
export function numberHash(e164: string): Promise<string> {
  return sha256Hex(`algoria-phone:${e164}`);
}

/** Read-only Twilio lookups behind the pre-payment checks. */
export interface Directory {
  /** 'Trial' or 'Full'; undefined when Twilio could not say. */
  accountType(): Promise<string | undefined>;
  /** Whether the account may call low-risk numbers in a country; undefined when unknown. */
  countryEnabled(isoCode: string): Promise<boolean | undefined>;
  /** Whether a trial account verified this number; undefined when unknown. */
  verified(e164: string): Promise<boolean | undefined>;
}

/** Twilio's REST API, with answers cached per isolate. Errors count as "unknown". */
export function twilioDirectory(config: PhoneConfig, fetcher: typeof fetch = fetch): Directory {
  const cache = new Map<string, { at: number; value: unknown }>();
  const auth = `Basic ${btoa(`${config.accountSid}:${config.authToken}`)}`;
  async function get<T>(
    key: string,
    url: string,
    read: (body: Record<string, unknown>) => T,
  ): Promise<T | undefined> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    try {
      const response = await fetcher(url, {
        headers: { authorization: auth, accept: 'application/json' },
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const value = read(await response.json());
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      return undefined;
    }
  }
  const account = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`;
  return {
    accountType: () =>
      get('account', `${account}.json`, (body) => typeof body.type === 'string' ? body.type : undefined),
    countryEnabled: (iso) =>
      get(
        `country:${iso}`,
        `https://voice.twilio.com/v1/DialingPermissions/Countries/${encodeURIComponent(iso)}`,
        (body) =>
          typeof body.low_risk_numbers_enabled === 'boolean' ? body.low_risk_numbers_enabled : undefined,
      ),
    verified: (e164) =>
      get(
        `verified:${e164}`,
        `${account}/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(e164)}`,
        (body) => Array.isArray(body.outgoing_caller_ids) ? body.outgoing_caller_ids.length > 0 : undefined,
      ),
  };
}

export interface PhoneServiceDependencies {
  config: PhoneConfig;
  store: JobStore;
  calls: CallRepository;
  twilio: Pick<Twilio, 'placeCall' | 'hangup'>;
  directory: Directory;
  summarize: Summarizer;
  baseUrl: string;
  realtime?: SessionDependencies['realtime'];
}

export class PhoneCallService {
  constructor(private d: PhoneServiceDependencies) {}

  /**
   * Checks that need more than the schema, before any 402. Returns input errors (400 invalid_input),
   * or the number's E.164 form and hash.
   */
  async check(input: PhoneCallInput): Promise<{ errors: InputError[] } | { to: string; hash: string }> {
    const refuse = (message: string) => ({ errors: [{ pointer: '/to', message }] });
    const parsed = parsePhoneNumberFromString(input.to);
    if (!parsed || !parsed.isValid()) return refuse('is not a valid phone number');
    const type = parsed.getType();
    if (type === 'PREMIUM_RATE' || type === 'SHARED_COST') {
      return refuse('premium-rate numbers are not called');
    }
    const to = parsed.number;
    if (to === this.d.config.from) return refuse("is this provider's own number");
    if (parsed.country !== undefined && (await this.d.directory.countryEnabled(parsed.country)) === false) {
      return refuse(`calls to ${parsed.country} numbers are not enabled for this provider`);
    }
    if (
      (await this.d.directory.accountType()) === 'Trial' && (await this.d.directory.verified(to)) === false
    ) {
      return refuse('this provider can only call numbers it has verified for now');
    }
    return { to, hash: await numberHash(to) };
  }

  /**
   * Starts a paid job's call: queued -> running, then one dial. A rejected dial fails the job; a dial
   * whose answer was lost is never repeated.
   */
  async dial(job: StellarJob): Promise<StellarJob> {
    const { store, calls, twilio, config, baseUrl } = this.d;
    // The call's row first: if this fails, the job is still queued and the next request dials it.
    await calls.create(job.job_id);
    const claim = await store.startDial(job.job_id);
    if (!claim.claimed) return claim.job;
    const input = claim.job.input as PhoneCallInput;
    const token = await signJob(config.authToken, job.job_id);
    try {
      const sid = await twilio.placeCall({
        to: input.to,
        url: `${baseUrl}/phone/twiml/${job.job_id}?token=${token}`,
        statusCallback: `${baseUrl}/webhooks/twilio/${job.job_id}?token=${token}`,
      });
      await calls.update(job.job_id, { call_sid: sid, call_status: 'initiated' });
      return await store.dialed(job.job_id, sid);
    } catch (error) {
      if (error instanceof TwilioError && error.rejected) {
        const code = error.code === undefined ? '' : ` (Twilio error ${error.code})`;
        return store.fail(
          job.job_id,
          jobError('service_failed', `The phone network refused the call${code}.`),
        );
      }
      // Twilio may have placed it. Its callbacks and the voice bridge still find the job.
      return store.dialed(job.job_id, null);
    }
  }

  /** Finishes a running job once its call is over: the outcome, a summary and the transcript. */
  async advance(job: StellarJob): Promise<StellarJob> {
    const { store, calls, summarize } = this.d;
    // A dial still `dialing` may belong to a worker that died mid-request: its call, if Twilio placed it,
    // still reports here, and the call's deadline ends it either way. Only the row's state decides.
    if (job.status !== 'running' || job.dial_state === 'none') return job;
    const row = await calls.get(job.job_id);
    if (!row) return job;
    const age = (time: string) => Date.now() - Date.parse(time);
    const finished = row.ended_at !== null || NOT_CONNECTED.includes(row.call_status) ||
      (row.call_status === 'completed' && age(row.updated_at) > 10_000) ||
      age(row.created_at) > CALL_DEADLINE_MS;
    if (!finished) return job;
    const claim = await store.claimCompletion(job.job_id);
    if (!claim.claimed || !claim.lease) return claim.job;
    try {
      const input = job.input as PhoneCallInput;
      const transcript = row.transcript.filter((line) => line.text.trim()).slice(0, 200);
      const status = finalStatus(row.call_status, transcript);
      const connected = status === 'completed';
      const summary = connected
        ? await summarize(
          { contact: input.callee_name ?? 'the callee', goal: input.goal, on_behalf_of: input.on_behalf_of },
          transcript,
        ).catch(() => ({ summary: 'Summary unavailable; see the transcript.', goal_achieved: false }))
        : { summary: NOT_CONNECTED_SUMMARY[status] ?? 'The call did not connect.', goal_achieved: false };
      const output: JsonObject = {
        call: {
          status,
          connected,
          ...(row.duration_seconds !== null ? { duration_seconds: row.duration_seconds } : {}),
          summary: summary.summary,
          goal_achieved: summary.goal_achieved,
          transcript: transcript.map(({ speaker, text }) => ({ speaker, text })),
        },
      };
      // Output is checked before it is stored [§12].
      if (validate(PHONE_OUTPUT_SCHEMA, output).length) {
        return await store.fail(job.job_id, jobError('output_invalid'));
      }
      return await store.complete(job.job_id, claim.lease, output);
    } catch {
      return store.releaseCompletion(job.job_id, claim.lease);
    }
  }

  /** TwiML Twilio fetches when the call is answered: its audio goes to the voice bridge. */
  async twiml(jobId: string, token: string): Promise<string | undefined> {
    if (!(await tokenValid(this.d.config.authToken, jobId, token))) return undefined;
    const job = await this.d.store.get(jobId);
    if (!job || job.status !== 'running') {
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>` +
      `<Stream url="${xml(`${this.d.baseUrl.replace(/^http/, 'ws')}/phone/stream`)}">` +
      `<Parameter name="job" value="${jobId}"/><Parameter name="token" value="${token}"/>` +
      `</Stream></Connect></Response>`;
  }

  /** Twilio status callback, authenticated by the per-job token in its URL. False on a bad token. */
  async statusCallback(jobId: string, token: string, params: URLSearchParams): Promise<boolean> {
    if (!(await tokenValid(this.d.config.authToken, jobId, token))) return false;
    const status = params.get('CallStatus');
    if (!status || !/^[a-z-]{1,32}$/.test(status)) return true;
    const sid = params.get('CallSid');
    const duration = Number(params.get('CallDuration'));
    await this.d.calls.update(jobId, {
      call_status: status,
      ...(sid && /^CA[0-9a-f]{32}$/i.test(sid) ? { call_sid: sid } : {}),
      ...(Number.isInteger(duration) && duration >= 0 ? { duration_seconds: duration } : {}),
    });
    const job = await this.d.store.get(jobId);
    if (job) await this.advance(job);
    return true;
  }

  /** The voice bridge for one answered call. */
  stream(request: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(request);
    const { store } = this.d;
    const session = new CallSession(socket, {
      config: this.d.config,
      calls: this.d.calls,
      twilio: this.d.twilio,
      realtime: this.d.realtime,
      async callable(jobId) {
        const job = await store.get(jobId);
        if (!job || job.status !== 'running' || job.dial_state === 'none' || !job.input) return null;
        const input = job.input as PhoneCallInput;
        return {
          callee: input.callee_name ?? 'the person who answers',
          goal: input.goal,
          on_behalf_of: input.on_behalf_of,
          language: input.language,
        };
      },
      started: () => Promise.resolve(),
      async optOut(jobId) {
        await store.optOut(jobId);
      },
    });
    // Keep the Edge worker alive until the call ends and its transcript is saved.
    (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(
      session.done,
    );
    session.listen();
    return response;
  }
}

const NOT_CONNECTED_SUMMARY: Record<string, string> = {
  'busy': 'The line was busy; nobody answered.',
  'no-answer': 'Nobody answered the call.',
  'failed': 'The call could not be connected.',
  'canceled': 'The call was canceled before it connected.',
};

/**
 * How the call ended, in the output's terms. A call nobody reported the end of: completed if anyone
 * talked or the voice bridge answered it, failed if Twilio never said anything about it, else no-answer.
 */
function finalStatus(callStatus: string, transcript: TranscriptLine[]): (typeof CALL_STATUSES)[number] {
  if ((CALL_STATUSES as readonly string[]).includes(callStatus)) {
    return callStatus as (typeof CALL_STATUSES)[number];
  }
  if (transcript.length || callStatus === 'in-progress') return 'completed';
  return callStatus === 'queued' ? 'failed' : 'no-answer';
}
