import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';
import type { PhoneConfig } from './config.ts';
import { HttpError } from './security.ts';
import type { Job, Store } from './store.ts';

/** Twilio's time limit; our bridge wraps up earlier. Free-plan Edge wall clock is 150s. */
export const CALL_TIME_LIMIT_SECONDS = 100;
const WRAP_UP_AFTER_MS = 75_000;
const HARD_STOP_AFTER_MS = 95_000;
const NOT_CONNECTED = ['busy', 'no-answer', 'failed', 'canceled'];

export type PhoneInput = { contact: string; goal: string; on_behalf_of: string };
export type TranscriptLine = { speaker: 'agent' | 'contact'; text: string };
export type CallRow = {
  job_id: string;
  call_sid: string | null;
  call_status: string;
  duration_seconds: number | null;
  transcript: TranscriptLine[];
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};
export type CallPatch = Partial<
  Pick<CallRow, 'call_sid' | 'call_status' | 'duration_seconds' | 'transcript' | 'ended_at'>
>;

export interface CallRepository {
  get(jobId: string): Promise<CallRow | null>;
  create(jobId: string): Promise<void>;
  update(jobId: string, patch: CallPatch): Promise<void>;
}

export class SupabaseCallRepository implements CallRepository {
  private readonly client: SupabaseClient;
  constructor(url: string, key: string) {
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  async get(jobId: string) {
    const { data, error } = await this.client.from('phone_calls').select('*').eq('job_id', jobId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data as CallRow | null;
  }
  async create(jobId: string) {
    const { error } = await this.client.from('phone_calls').upsert({ job_id: jobId }, {
      onConflict: 'job_id',
      ignoreDuplicates: true,
    });
    if (error) throw new Error(error.message);
  }
  async update(jobId: string, patch: CallPatch) {
    const { error } = await this.client.from('phone_calls')
      .update({ ...patch, updated_at: new Date().toISOString() }).eq('job_id', jobId);
    if (error) throw new Error(error.message);
  }
}

export class TwilioError extends Error {
  constructor(message: string, public rejected: boolean) {
    super(message);
  }
}

/** Minimal Twilio REST client: place a call and hang it up. */
export class Twilio {
  constructor(private config: PhoneConfig, private fetcher: typeof fetch = fetch) {}

  private async request(path: string, form: URLSearchParams) {
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}${path}`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${btoa(`${this.config.accountSid}:${this.config.authToken}`)}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new TwilioError('Twilio could not be reached.', false);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status >= 400 && response.status < 500) {
      // Twilio explains trial/geo-permission problems here; keep numbers out of job errors.
      const message = String(body?.message ?? 'Twilio rejected the call.').replace(/\+?\d{7,}/g, '[number]');
      throw new TwilioError(message.slice(0, 300), true);
    }
    if (!response.ok) throw new TwilioError('Twilio failed to place the call.', false);
    return body as { sid: string };
  }

  async placeCall(options: { to: string; twiml: string; statusCallback: string }) {
    const form = new URLSearchParams({
      To: options.to,
      From: this.config.from,
      Twiml: options.twiml,
      TimeLimit: String(CALL_TIME_LIMIT_SECONDS),
      Timeout: '30',
      StatusCallback: options.statusCallback,
      StatusCallbackMethod: 'POST',
    });
    for (const event of ['initiated', 'ringing', 'answered', 'completed']) {
      form.append('StatusCallbackEvent', event);
    }
    return (await this.request('/Calls.json', form)).sid;
  }

  async hangup(callSid: string) {
    await this.request(`/Calls/${callSid}.json`, new URLSearchParams({ Status: 'completed' }));
  }
}

export async function signJob(secret: string, jobId: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`phone.call:${jobId}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function tokenValid(secret: string, jobId: string, token: string) {
  const expected = await signJob(secret, jobId);
  let diff = expected.length ^ token.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (token.charCodeAt(i) || 0);
  return diff === 0;
}
const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type Summary = { summary: string; goal_achieved: boolean };
export type Summarizer = (input: PhoneInput, transcript: TranscriptLine[]) => Promise<Summary>;

/** One cheap text call after hang-up. */
export function openAiSummarizer(apiKey: string, fetcher: typeof fetch = fetch): Summarizer {
  return async (input, transcript) => {
    if (!transcript.length) {
      return { summary: 'The call connected but no conversation was captured.', goal_achieved: false };
    }
    const response = await fetcher('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You summarize a phone call made by an AI assistant. Reply with JSON: {"summary": string (1-3 sentences, what the contact said/agreed), "goal_achieved": boolean}.',
          },
          {
            role: 'user',
            content: `Goal: ${input.goal}\n\nTranscript:\n${
              transcript.map((line) => `${line.speaker === 'agent' ? 'AI' : 'Contact'}: ${line.text}`).join(
                '\n',
              )
            }`,
          },
        ],
      }),
    });
    if (!response.ok) throw new Error('summary-failed');
    const body = await response.json();
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}');
    return {
      summary: typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 1000)
        : 'Summary unavailable.',
      goal_achieved: parsed.goal_achieved === true,
    };
  };
}

type PhoneStore = Pick<
  Store,
  | 'get'
  | 'claimSubmission'
  | 'setSubmitted'
  | 'failJob'
  | 'markRunning'
  | 'claimCompletion'
  | 'complete'
  | 'releaseCompletion'
>;
type Realtime = { new (url: string, protocols: string[]): WebSocket };

export interface PhoneDependencies {
  config: PhoneConfig;
  store: PhoneStore;
  calls: CallRepository;
  twilio: Pick<Twilio, 'placeCall' | 'hangup'>;
  baseUrl: string;
  summarize: Summarizer;
  realtime?: Realtime;
}

export class PhoneCalls {
  constructor(private d: PhoneDependencies) {}

  validate(input: PhoneInput) {
    if (!this.d.config.contacts[input.contact]) {
      throw new HttpError(
        400,
        'unknown-contact',
        `Choose one of the approved contacts: ${Object.keys(this.d.config.contacts).join(', ')}.`,
      );
    }
  }

  /** Paid -> Twilio dials. Mirrors fal submission: a lost request ID is never redialed. */
  async start(job: Job): Promise<Job> {
    const { store, calls, twilio, config, baseUrl } = this.d;
    const input = job.input as PhoneInput;
    const to = config.contacts[input.contact];
    if (!to) return store.failJob(job.id, 'unknown-contact', 'This contact is no longer approved.');
    await calls.create(job.id);
    const claim = await store.claimSubmission(job.id);
    if (!claim.claimed) return claim.job;
    const token = await signJob(config.authToken, job.id);
    const twiml =
      `<Response><Connect><Stream url="${xml(`${baseUrl.replace(/^http/, 'ws')}/phone/stream`)}">` +
      `<Parameter name="job" value="${job.id}"/><Parameter name="token" value="${token}"/>` +
      `</Stream></Connect></Response>`;
    try {
      const sid = await twilio.placeCall({
        to,
        twiml,
        statusCallback: `${baseUrl}/webhooks/twilio/${job.id}?token=${token}`,
      });
      await calls.update(job.id, { call_sid: sid, call_status: 'initiated' });
      return await store.setSubmitted(job.id, sid);
    } catch (e) {
      if (e instanceof TwilioError && e.rejected) return store.failJob(job.id, 'call-rejected', e.message);
      return (await store.get(job.id)) ?? claim.job;
    }
  }

  /** Called on every status read and Twilio callback. Finishes the job once the call is over. */
  async advance(job: Job): Promise<Job> {
    const { store, calls, summarize } = this.d;
    if (!['queued', 'running', 'saving'].includes(job.status)) return job;
    const row = await calls.get(job.id);
    if (!row) return job;
    if (NOT_CONNECTED.includes(row.call_status)) {
      return store.failJob(job.id, 'call-not-connected', `The call did not connect (${row.call_status}).`);
    }
    const age = (time: string) => Date.now() - Date.parse(time);
    const finished = row.ended_at !== null ||
      (row.call_status === 'completed' && age(row.updated_at) > 10_000) ||
      age(row.created_at) > 6 * 60_000;
    if (!finished) {
      if (job.status === 'queued' && (row.call_status === 'in-progress' || row.transcript.length)) {
        return store.markRunning(job.id);
      }
      return job;
    }
    const claim = await store.claimCompletion(job.id);
    if (!claim.claimed || !claim.leaseToken) return claim.job;
    try {
      const transcript = row.transcript.filter((line) => line.text.trim());
      const input = job.input as PhoneInput;
      const summary = await summarize(input, transcript).catch(() => ({
        summary: 'Summary unavailable; see the transcript.',
        goal_achieved: false,
      }));
      return await store.complete(job.id, claim.leaseToken, {
        call: {
          contact: input.contact,
          status: row.call_status,
          ...(row.duration_seconds !== null ? { duration_seconds: row.duration_seconds } : {}),
          ...summary,
          transcript,
        },
      });
    } catch {
      return store.releaseCompletion(job.id, claim.leaseToken);
    }
  }

  /** Twilio status callback. Authenticated by the per-job token we put in its URL. */
  async statusCallback(jobId: string, token: string, params: URLSearchParams): Promise<Job | null> {
    if (!(await tokenValid(this.d.config.authToken, jobId, token))) {
      throw new HttpError(401, 'invalid-webhook');
    }
    const status = params.get('CallStatus');
    if (!status || !/^[a-z-]{1,32}$/.test(status)) return null;
    const duration = Number(params.get('CallDuration'));
    await this.d.calls.update(jobId, {
      call_status: status,
      ...(Number.isInteger(duration) && duration >= 0 ? { duration_seconds: duration } : {}),
    });
    const job = await this.d.store.get(jobId);
    return job ? this.advance(job) : null;
  }

  /** Twilio Media Stream <-> OpenAI Realtime. Both speak 8 kHz mu-law, so audio passes through. */
  stream(request: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(request);
    const session = new CallSession(socket, this.d);
    // Keep the Edge worker alive until the call ends and its transcript is saved.
    (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime?.waitUntil(
      session.done,
    );
    session.listen();
    return response;
  }
}

function instructions(input: PhoneInput) {
  return [
    `You are Algoria's AI phone assistant, speaking on a real phone call on behalf of ${input.on_behalf_of}.`,
    `You are calling ${input.contact}. Your goal: ${input.goal}`,
    'Speak English only. At the start, say you are an AI assistant calling on behalf of ' +
    `${input.on_behalf_of}, then state the reason for the call.`,
    'Be warm, natural and brief: one or two short sentences per turn. Listen and respond to what they say.',
    'Do not invent facts, promises or details beyond the goal. If asked something you do not know, say you will pass it on.',
    'When the goal is done, or the person declines or wants to stop, say a short goodbye and then call the end_call tool.',
    'The call is limited to about 90 seconds.',
  ].join('\n');
}

export class CallSession {
  private streamSid = '';
  private callSid = '';
  private jobId = '';
  private openai?: WebSocket;
  private lines: (TranscriptLine & { id?: string })[] = [];
  private ending = false;
  private finished = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private saving = Promise.resolve();
  private resolveDone!: () => void;
  readonly done = new Promise<void>((resolve) => this.resolveDone = resolve);

  constructor(private twilio: WebSocket, private d: PhoneDependencies) {}

  listen() {
    this.twilio.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.onTwilio(message).catch((e) => {
        console.error('phone stream error', e instanceof Error ? e.name : 'unknown');
        this.finish();
      });
    };
    this.twilio.onclose = () => this.finish(false);
  }

  private sendTwilio(message: Record<string, unknown>) {
    if (this.twilio.readyState === WebSocket.OPEN) {
      this.twilio.send(JSON.stringify({ ...message, streamSid: this.streamSid }));
    }
  }
  private sendOpenAi(message: Record<string, unknown>) {
    if (this.openai?.readyState === WebSocket.OPEN) this.openai.send(JSON.stringify(message));
  }

  // deno-lint-ignore no-explicit-any -- untyped socket JSON
  private async onTwilio(message: Record<string, any>) {
    if (message.event === 'start') {
      const params = message.start?.customParameters ?? {};
      const jobId = String(params.job ?? '');
      if (!(await tokenValid(this.d.config.authToken, jobId, String(params.token ?? '')))) {
        return this.twilio.close();
      }
      const job = await this.d.store.get(jobId);
      if (!job || job.service_id !== 'phone.call' || !['queued', 'running'].includes(job.status)) {
        return this.twilio.close();
      }
      this.jobId = jobId;
      this.streamSid = message.start.streamSid;
      this.callSid = message.start.callSid;
      await this.d.calls.update(jobId, { call_status: 'in-progress' });
      await this.d.store.markRunning(jobId);
      this.connectOpenAi(job.input as PhoneInput);
      this.timers.push(
        setTimeout(() => {
          this.sendOpenAi({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{
                type: 'input_text',
                text: 'Time is almost up. Politely wrap up in one sentence, say goodbye and call end_call.',
              }],
            },
          });
          this.sendOpenAi({ type: 'response.create' });
        }, WRAP_UP_AFTER_MS),
        setTimeout(() => this.finish(), HARD_STOP_AFTER_MS),
      );
    } else if (message.event === 'media') {
      this.sendOpenAi({ type: 'input_audio_buffer.append', audio: message.media.payload });
    } else if (message.event === 'mark' && message.mark?.name === 'goodbye') {
      this.finish();
    } else if (message.event === 'stop') {
      this.finish(false);
    }
  }

  private connectOpenAi(input: PhoneInput) {
    const Realtime = this.d.realtime ?? WebSocket;
    const openai = new Realtime(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.d.config.realtimeModel)}`,
      ['realtime', `openai-insecure-api-key.${this.d.config.openaiKey}`],
    );
    this.openai = openai;
    openai.onopen = () => {
      this.sendOpenAi({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: this.d.config.realtimeModel,
          output_modalities: ['audio'],
          instructions: instructions(input),
          audio: {
            input: {
              format: { type: 'audio/pcmu' },
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
              turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
            },
            output: { format: { type: 'audio/pcmu' }, voice: this.d.config.voice },
          },
          tools: [{
            type: 'function',
            name: 'end_call',
            description: 'Hang up the phone. Call only after saying goodbye.',
            parameters: { type: 'object', properties: {}, required: [] },
          }],
          tool_choice: 'auto',
        },
      });
      // The callee just picked up: the assistant speaks first.
      this.sendOpenAi({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{
            type: 'input_text',
            text: 'The call was just answered. Greet them and introduce yourself now.',
          }],
        },
      });
      this.sendOpenAi({ type: 'response.create' });
    };
    openai.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.onOpenAi(message);
    };
    openai.onerror = () => console.error('openai realtime socket error');
    openai.onclose = () => this.finish();
  }

  // deno-lint-ignore no-explicit-any -- untyped socket JSON
  private onOpenAi(message: Record<string, any>) {
    switch (message.type) {
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        this.sendTwilio({ event: 'media', media: { payload: message.delta } });
        break;
      case 'input_audio_buffer.speech_started':
        // Barge-in: stop playing the assistant's audio when the person talks.
        this.sendTwilio({ event: 'clear' });
        break;
      case 'input_audio_buffer.committed':
        // Reserve the slot now so the callee's words stay before the assistant's reply.
        this.lines.push({ speaker: 'contact', text: '', id: message.item_id });
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const line = this.lines.find((item) => item.id === message.item_id);
        if (line) line.text = String(message.transcript ?? '').trim();
        else this.lines.push({ speaker: 'contact', text: String(message.transcript ?? '').trim() });
        this.save();
        break;
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        this.lines.push({ speaker: 'agent', text: String(message.transcript ?? '').trim() });
        this.save();
        break;
      case 'response.function_call_arguments.done':
        if (message.name === 'end_call') this.ending = true;
        break;
      case 'response.done':
        if (this.ending) {
          // Hang up once Twilio has played the goodbye (it echoes the mark back).
          this.sendTwilio({ event: 'mark', mark: { name: 'goodbye' } });
          this.timers.push(setTimeout(() => this.finish(), 8000));
        }
        break;
      case 'error':
        console.error('openai realtime error', message.error?.code ?? message.error?.type);
        break;
    }
  }

  private transcript(): TranscriptLine[] {
    return this.lines.filter((line) => line.text).map(({ speaker, text }) => ({ speaker, text }));
  }

  private save(ended = false) {
    if (!this.jobId) return this.saving;
    const patch: CallPatch = {
      transcript: this.transcript(),
      ...(ended ? { ended_at: new Date().toISOString() } : {}),
    };
    this.saving = this.saving.then(() => this.d.calls.update(this.jobId, patch)).catch(() => {
      console.error('phone transcript save failed');
    });
    return this.saving;
  }

  private finish(hangup = true) {
    if (this.finished) return;
    this.finished = true;
    for (const timer of this.timers) clearTimeout(timer);
    if (hangup && this.callSid) this.d.twilio.hangup(this.callSid).catch(() => {});
    try {
      this.openai?.close();
    } catch { /* already closed */ }
    this.save(true).finally(() => {
      try {
        this.twilio.close();
      } catch { /* already closed */ }
      this.resolveDone();
    });
  }
}
