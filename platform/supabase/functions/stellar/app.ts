// HTTP routes of the Stellar provider (Fetch API). Provider Standard v1 (§5) under baseUrl:
//
//   GET  {baseUrl}/.well-known/stellar-agent-services.json  -> manifest
//   POST {baseUrl}/services/{name}/jobs                    -> create-job   (x402 USDC)
//   GET  {baseUrl}/jobs/{jobId}                            -> check-status (Job-Token)
//   GET  {baseUrl}/jobs/{jobId}/result                     -> get-result   (Job-Token)
//
// and the call's own routes: Twilio's TwiML and status callbacks, the voice bridge's WebSocket, and
// the minute sweep pg_cron calls.
//
// create-job follows the processing order of §5.4, ported from the kit's http/router.ts: headers and
// body, service, an existing job [J5]–[J7], input [P8], capacity [Q1], the 402, the payment checked
// locally and verified, then the job id and the payment claimed together [J4] [P9]. Settlement and the
// dial run in the background of that request (EdgeRuntime.waitUntil); the answer waits for them at
// most HOLD_MS [J9]. Errors are RFC 9457 problems that never echo headers, payloads or tokens [E2],
// and nothing answers 500: an unexpected failure is 503 with Retry-After, and nothing was charged
// unless the job says so.

import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from 'npm:@x402/core@2.22.0/http';
import type { StellarConfig } from './config.ts';
import { type ChainReader, EXPIRATION_TOLERANCE_LEDGERS, findPayment } from './onchain.ts';
import type { PhoneCallInput, PhoneCallService } from './phone.ts';
import {
  bindingHash,
  chargedFor,
  IDEMPOTENCY_KEY,
  IDEMPOTENCY_KEY_PATTERN,
  type InputError,
  JOB_TOKEN,
  JOB_TOKEN_PATTERN,
  jobError,
  jobStatusUrl,
  type JobView,
  type JsonObject,
  problem,
  PROBLEM_CONTENT_TYPE,
  type ProblemCode,
  PROBLEMS,
  type ProviderManifest,
  type ServiceDescriptor,
  sha256Hex,
} from './protocol.ts';
import { type Schema, validate } from './schema.ts';
import type { JobStore, Limits, StellarJob } from './store.ts';
import {
  checkFacilitator,
  checkPayment,
  type Facilitator,
  isRefused,
  type PaymentPayload,
  paymentRequired,
  type PaymentRequirements,
  paymentRequirements,
  readPayment,
  settle,
  type SettleResponse,
  settleTimeoutSeconds,
} from './x402.ts';
import type { CheckedPayment } from './x402.ts';

/** Longest create-job holds its answer before 202 or 409 [J9]. */
const HOLD_MS = 25_000;
const RETRY_AFTER_SECONDS = 2;
/** A 202 while the call is on: about when it changes next [Q6]. */
const RUNNING_RETRY_AFTER_SECONDS = 5;
const BUSY_RETRY_AFTER_SECONDS = 30;
const NUMBER_BUSY_RETRY_AFTER_SECONDS = 120;
const NUMBER_LIMITED_RETRY_AFTER_SECONDS = 3600;
/** A paid job whose call has not started this long after it was claimed fails instead of dialing late. */
const LATE_DIAL_MS = 30 * 60_000;
/** How often one uncertain job is looked up on chain. */
const RECONCILE_QUIET_SECONDS = 20;
const READY_RETRY_MS = 30_000;
const SWEEP_EVERY_MS = 60_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Location, Retry-After',
};

export interface ProviderDependencies {
  config: Pick<
    StellarConfig,
    | 'network'
    | 'asset'
    | 'baseUrl'
    | 'retentionSeconds'
    | 'maxTimeoutSeconds'
    | 'concurrency'
    | 'callsPerNumber'
    | 'sweepSecret'
  >;
  manifest: ProviderManifest;
  store: JobStore;
  facilitator: Facilitator;
  phone: Pick<PhoneCallService, 'check' | 'dial' | 'advance' | 'twiml' | 'statusCallback' | 'stream'>;
  /** Soroban RPC: reconciliation [J13] and the payment-expiration check. */
  chain?: ChainReader;
  /** Keeps background work alive after the answer (EdgeRuntime.waitUntil on Supabase). */
  waitUntil?: (work: Promise<unknown>) => void;
  holdMs?: number;
  /** Pause between the chain lookups right after an uncertain settlement. */
  reconcileRetryMs?: number;
}

export interface Provider {
  fetch(request: Request): Promise<Response>;
  /** Recovery and retention: pg_cron runs it every minute through /internal/sweep. */
  sweep(): Promise<{ uncertain: number; deleted: number; reconciled: number; advanced: number }>;
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
  type = 'application/json',
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function error(
  code: ProblemCode,
  detail?: string,
  errors?: InputError[],
  headers: Record<string, string> = {},
): Response {
  const retry: Record<string, string> = 'retryAfter' in PROBLEMS[code]
    ? { 'Retry-After': String(RETRY_AFTER_SECONDS) }
    : {};
  return json(
    problem(code, {
      ...(detail === undefined ? {} : { detail }),
      ...(errors === undefined ? {} : { errors }),
    }),
    PROBLEMS[code].status,
    { 'Cache-Control': 'no-store', ...retry, ...headers },
    PROBLEM_CONTENT_TYPE,
  );
}

function sameHash(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readBounded(request: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function createProvider(d: ProviderDependencies): Provider {
  const { config, manifest, store, facilitator, phone } = d;
  const services = new Map<string, ServiceDescriptor>(
    manifest.services.map((service) => [service.name, service]),
  );
  const basePath = new URL(config.baseUrl).pathname.replace(/\/$/, '');
  const limits: Limits = { maxActive: config.concurrency, maxPerNumber: config.callsPerNumber };
  const holdMs = d.holdMs ?? HOLD_MS;
  const reconcileRetryMs = d.reconcileRetryMs ?? 10_000;
  const settleTimeout = settleTimeoutSeconds(config.maxTimeoutSeconds);
  const background = (work: Promise<unknown>) => {
    const guarded = work.catch((cause) => console.error('stellar background work failed', errorName(cause)));
    d.waitUntil?.(guarded);
    return guarded;
  };

  // The facilitator must settle this network with sponsored fees before anyone is asked to pay.
  let readyUntil = 0;
  let readying: Promise<void> | undefined;
  function ready(): Promise<void> {
    if (Date.now() < readyUntil) return Promise.resolve();
    readying ??= checkFacilitator(facilitator, config.network).then(
      () => {
        readyUntil = Date.now() + 10 * 60_000;
      },
    ).finally(() => {
      readying = undefined;
    });
    return readying;
  }
  let notReadyUntil = 0;

  // ---------------------------------------------------------------------------------------------
  // The job view (§5.5)

  function expiresAt(job: StellarJob): number {
    return Date.parse(job.finished_at ?? job.created_at) + config.retentionSeconds * 1000;
  }
  /** A final job past its retention is gone, even before the sweep deletes it [J15]. */
  function expired(job: StellarJob): boolean {
    return (job.status === 'succeeded' || job.status === 'failed') && expiresAt(job) <= Date.now();
  }

  function jobResponse(
    job: StellarJob,
    options: { withOutput: boolean; create?: boolean; jobToken?: string; headers?: Record<string, string> },
  ): Response {
    if (job.status === 'pending') return error('request_in_progress');
    const charged = chargedFor(job.status, job.charge, job.error?.code);
    const view: JobView = {
      jobId: job.job_id,
      service: job.service,
      status: job.status,
      charge: job.charge,
      charged,
      createdAt: new Date(job.created_at).toISOString(),
      updatedAt: new Date(job.updated_at).toISOString(),
      expiresAt: new Date(expiresAt(job)).toISOString(),
    };
    // Output is withheld unless succeeded, so never while payment_uncertain [J14].
    if (options.withOutput && job.status === 'succeeded' && job.output) view.output = job.output;
    if (job.status === 'failed' && job.error) view.error = job.error;
    if (charged === true && job.payment) view.payment = job.payment;
    // A queued job starts next: this provider admits a job only when a line is free.
    if (job.status === 'queued') view.queue = { position: 1, estimatedStartAt: new Date().toISOString() };
    if (options.jobToken !== undefined) view.jobToken = options.jobToken;
    const finished = job.status === 'succeeded' || job.status === 'failed';
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...options.headers };
    if (!finished) {
      headers['Retry-After'] = String(
        job.status === 'running' ? RUNNING_RETRY_AFTER_SECONDS : RETRY_AFTER_SECONDS,
      );
      if (options.create) headers['Location'] = jobStatusUrl(config.baseUrl, job.job_id);
    }
    return json(view, finished ? 200 : 202, headers);
  }

  function challenge(service: ServiceDescriptor, reason?: string): Response {
    const body = paymentRequired(manifest, service, reason);
    return json(body, 402, {
      'Cache-Control': 'no-store',
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Moving a job on. Nothing runs between requests, so every request that reaches a job moves it.

  async function reconcile(job: StellarJob): Promise<StellarJob> {
    if (!d.chain) return job;
    const lookup = await findPayment(
      { payer: job.payer, nonce: job.nonce, expirationLedger: Number(job.expiration_ledger) },
      job.settlement?.transaction,
      { chain: d.chain, network: config.network, asset: config.asset },
    );
    if (lookup.outcome === 'settled') {
      const settled = await store.settlement(job.job_id, { outcome: 'settled', receipt: lookup.receipt });
      return settled ? await progress(settled) : (await store.get(job.job_id)) ?? job;
    }
    if (lookup.outcome === 'not_settled') {
      const failed = await store.settlement(job.job_id, {
        outcome: 'failed',
        error: jobError('payment_failed', 'The payment never reached the chain; nothing was charged.'),
        reason: lookup.reason,
      });
      return failed ?? (await store.get(job.job_id)) ?? job;
    }
    await store.checked(job.job_id, lookup.reason);
    return job;
  }

  /** One step for a job that isn't final; never takes a payment or charges [J11]. */
  async function progress(job: StellarJob): Promise<StellarJob> {
    switch (job.status) {
      case 'running':
        return await phone.advance(job);
      case 'queued': {
        if (Date.now() - Date.parse(job.created_at) <= LATE_DIAL_MS) return await phone.dial(job);
        // Paid, but its payment was confirmed too late for the call to make sense now.
        const claim = await store.startDial(job.job_id);
        if (!claim.claimed) return claim.job;
        return await store.fail(
          job.job_id,
          jobError('service_failed', 'The call was not placed: its payment was confirmed too late.'),
        );
      }
      case 'payment_uncertain': {
        const quiet = job.checked_at === null ||
          Date.now() - Date.parse(job.checked_at) > RECONCILE_QUIET_SECONDS * 1000;
        return quiet ? await reconcile(job) : job;
      }
      case 'pending': {
        if (job.settling_since && Date.now() - Date.parse(job.settling_since) > (settleTimeout + 60) * 1000) {
          await store.sweep(config.retentionSeconds, settleTimeout + 60);
          return (await store.get(job.job_id)) ?? job;
        }
        return job;
      }
      default:
        return job;
    }
  }

  /** Settles a claimed job and, once paid, dials. Resolves with the facilitator's answer if it settled. */
  async function settleAndStart(
    job: StellarJob,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payment: CheckedPayment,
  ): Promise<SettleResponse | undefined> {
    const started = Date.now();
    const settlement = await settle(facilitator, payload, requirements, payment.payer);
    if (settlement.outcome === 'settled') {
      const paid = await store.settlement(job.job_id, { outcome: 'settled', receipt: settlement.receipt });
      if (paid) await phone.dial(paid);
      return settlement.response;
    }
    if (settlement.outcome === 'failed') {
      await store.settlement(job.job_id, {
        outcome: 'failed',
        error: jobError('payment_failed', 'The payment did not go through; nothing was charged.'),
        reason: settlement.reason,
      });
      return undefined;
    }
    const uncertain = await store.settlement(job.job_id, {
      outcome: 'uncertain',
      reason: settlement.reason,
      ...(settlement.transaction ? { transaction: settlement.transaction } : {}),
    });
    // Most uncertain answers are decided by the chain within seconds: look a few times while alive.
    let current = uncertain;
    for (let attempt = 0; current?.status === 'payment_uncertain' && attempt < 3; attempt++) {
      if (Date.now() - started > 100_000) break;
      await sleep(reconcileRetryMs);
      current = await reconcile(current);
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // create-job (§5.4)

  async function createJob(request: Request, serviceName: string): Promise<Response> {
    // 1. Headers and body.
    const jobIdHeader = request.headers.get(IDEMPOTENCY_KEY);
    const tokenHeader = request.headers.get(JOB_TOKEN);
    if ((jobIdHeader === null) !== (tokenHeader === null)) {
      return error('invalid_request', `send both ${IDEMPOTENCY_KEY} and ${JOB_TOKEN}, or neither`);
    }
    if (jobIdHeader !== null && !IDEMPOTENCY_KEY_PATTERN.test(jobIdHeader)) {
      return error('invalid_request', `${IDEMPOTENCY_KEY} must be a lowercase UUID`);
    }
    if (tokenHeader !== null && !JOB_TOKEN_PATTERN.test(tokenHeader)) {
      return error('invalid_request', `${JOB_TOKEN} must be 43 base64url characters`);
    }
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
      return error('invalid_request', 'the body must be application/json');
    }

    // 2. Service.
    const service = services.get(serviceName);
    if (service === undefined) return error('service_not_found');

    const limit = service.maxInputBytes ?? 1_048_576;
    const declared = Number(request.headers.get('Content-Length') ?? '0');
    const body = declared > limit ? undefined : await readBounded(request, limit);
    if (body === undefined) return error('payload_too_large', `the body is larger than ${limit} bytes`);
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return error('invalid_request', 'the body is not valid JSON');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return error('invalid_input', 'the input must be a JSON object');
    }

    const binding = await bindingHash(service.name, input);
    const tokenHash = tokenHeader === null ? undefined : await sha256Hex(tokenHeader);

    // 3. An existing job [J5]–[J7].
    if (jobIdHeader !== null) {
      const existing = await store.get(jobIdHeader);
      if (existing) return await existingJob(existing, binding, tokenHash!);
    }

    // 4. Input [P8]: the schema, then what only the call can tell.
    const invalid = validate(service.inputSchema as Schema, input);
    if (invalid.length) return error('invalid_input', undefined, invalid);
    const number = await phone.check(input as PhoneCallInput);
    if ('errors' in number) return error('invalid_input', undefined, number.errors);

    // 5. Capacity [P8] [Q1], once the provider can take payments at all.
    if (Date.now() < notReadyUntil) {
      return error('unavailable', 'the provider cannot take payments right now; nothing was charged');
    }
    try {
      await ready();
    } catch (cause) {
      notReadyUntil = Date.now() + READY_RETRY_MS;
      console.error('stellar provider not ready to take payments', errorName(cause));
      return error('unavailable', 'the provider cannot take payments right now; nothing was charged');
    }
    const admission = await store.admission(service.name, number.hash, limits);
    if (admission !== 'ok') return refusedAdmission(admission);

    // 6. No payment: the challenge.
    const requirements = paymentRequirements(manifest, service);
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (header === null) return challenge(service);

    // 7. Check the payment locally, then verify it with the facilitator.
    const payload = readPayment(header, requirements);
    if (payload === undefined) return challenge(service, 'invalid_payment');
    const payment = await checkPayment(payload, requirements);
    if (isRefused(payment)) return challenge(service, payment.reason);
    // A ledger takes at least a second, so maxTimeoutSeconds is also the most ledgers a payment may live.
    const latest = await latestLedger();
    if (
      latest !== undefined &&
      payment.expirationLedger > latest + requirements.maxTimeoutSeconds + EXPIRATION_TOLERANCE_LEDGERS
    ) {
      return challenge(service, 'invalid_exact_stellar_payload_signature_expiration_too_far');
    }
    try {
      const verified = await facilitator.verify(payload, requirements);
      if (!verified.isValid) return challenge(service, verified.invalidReason ?? 'invalid_payment');
      if (verified.payer !== undefined && verified.payer !== payment.payer) {
        console.error('stellar facilitator verified another payer');
        return error('unavailable', 'the payment could not be verified; nothing was charged');
      }
    } catch (cause) {
      console.error('stellar facilitator could not verify a payment', errorName(cause));
      return error('unavailable', 'the payment could not be verified; nothing was charged');
    }

    // 8. Claim the job id and the payment together [J4] [P9], with admission checked again [Q3].
    const generated = jobIdHeader === null;
    const jobId = jobIdHeader ?? crypto.randomUUID();
    const jobToken = tokenHeader ?? randomToken();
    const claim = await store.claim({
      job_id: jobId,
      service: service.name,
      charge: 'upfront',
      binding_hash: binding,
      token_hash: tokenHash ?? await sha256Hex(jobToken),
      network: config.network,
      payer: payment.payer,
      nonce: payment.nonce,
      expiration_ledger: payment.expirationLedger,
      fingerprint: payment.fingerprint,
      destination_hash: number.hash,
      input: { ...(input as JsonObject), to: number.to },
    }, limits);
    if (claim.outcome === 'payment_used') return challenge(service, 'payment_already_used');
    if (claim.outcome === 'conflict') return error('idempotency_key_reused');
    // Raced with an identical request: that request owns the payment; this one must not settle it [J5].
    if (claim.outcome === 'existing') return await existingJob(claim.job, binding, tokenHash!);
    if (claim.outcome !== 'created') return refusedAdmission(claim.outcome);

    // 9. Settle, then dial, holding the answer for at most holdMs [J9].
    let settled: SettleResponse | undefined;
    const work = background(
      settleAndStart(claim.job, payload, requirements, payment).then((response) => {
        settled = response;
      }),
    );
    await Promise.race([work, sleep(holdMs)]);

    // 10. Respond.
    const stored = (await store.get(jobId))!;
    // Settlement outlasted the hold: the client asks again with the same request [J7].
    if (stored.status === 'pending') return error('request_in_progress');
    return jobResponse(stored, {
      withOutput: true,
      create: true,
      ...(generated ? { jobToken } : {}),
      headers: settled === undefined ? {} : { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) },
    });
  }

  function refusedAdmission(admission: 'busy' | 'opted_out' | 'number_busy' | 'number_limited'): Response {
    switch (admission) {
      case 'opted_out':
        return error('invalid_input', undefined, [{
          pointer: '/to',
          message: 'asked not to be called again',
        }]);
      case 'number_busy':
        return error(
          'rate_limited',
          'a call to this number is already in progress; nothing was charged',
          undefined,
          {
            'Retry-After': String(NUMBER_BUSY_RETRY_AFTER_SECONDS),
          },
        );
      case 'number_limited':
        return error(
          'rate_limited',
          'this number was called too often today; nothing was charged',
          undefined,
          {
            'Retry-After': String(NUMBER_LIMITED_RETRY_AFTER_SECONDS),
          },
        );
      default:
        return error('unavailable', 'every line is busy; nothing was charged', undefined, {
          'Retry-After': String(BUSY_RETRY_AFTER_SECONDS),
        });
    }
  }

  async function latestLedger(): Promise<number | undefined> {
    if (!d.chain) return undefined;
    try {
      const latest = await Promise.race([
        d.chain.getLatestLedger(),
        sleep(3000).then(() => undefined),
      ]);
      return latest?.sequence;
    } catch {
      return undefined;
    }
  }

  async function existingJob(job: StellarJob, binding: string, tokenHash: string): Promise<Response> {
    if (job.binding_hash !== binding || !sameHash(job.token_hash, tokenHash)) {
      return error('idempotency_key_reused');
    }
    if (expired(job)) {
      return error('idempotency_key_reused', 'this job id was used for a job that has expired');
    }
    if (job.status === 'pending') return error('request_in_progress');
    // A repeated request never settles again, but it may move the job on [J5].
    return jobResponse(await progress(job), { withOutput: true, create: true });
  }

  // ---------------------------------------------------------------------------------------------
  // check-status and get-result (§5.5)

  async function getJob(request: Request, jobId: string, withOutput: boolean): Promise<Response> {
    const token = request.headers.get(JOB_TOKEN);
    const job = IDEMPOTENCY_KEY_PATTERN.test(jobId) ? await store.get(jobId) : null;
    // Unknown job, missing or wrong token, and an expired job all look the same [J10].
    if (!job || token === null || !sameHash(job.token_hash, await sha256Hex(token)) || expired(job)) {
      return error('job_not_found');
    }
    const current = await progress(job);
    if (current.status === 'pending') return error('request_in_progress');
    return jobResponse(current, { withOutput });
  }

  // ---------------------------------------------------------------------------------------------
  // The sweep

  let lastSweep = 0;
  async function sweep() {
    lastSweep = Date.now();
    const counts = await store.sweep(config.retentionSeconds, settleTimeout + 60);
    let reconciled = 0;
    for (const job of await store.uncertain(5, RECONCILE_QUIET_SECONDS)) {
      const after = await reconcile(job);
      if (after.status !== 'payment_uncertain') reconciled++;
    }
    let advanced = 0;
    for (const job of await store.stale(10, 60)) {
      const after = await progress(job);
      if (after.status !== job.status) advanced++;
    }
    return { ...counts, reconciled, advanced };
  }
  /** Without the cron tick, requests still move things on, at most once a minute per isolate. */
  function maybeSweep() {
    if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = Date.now();
    background(sweep());
  }

  // ---------------------------------------------------------------------------------------------
  // Routing

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${basePath}/`) || url.pathname === basePath
      ? url.pathname.slice(basePath.length) || '/'
      : url.pathname.replace(/^\/stellar(?=\/|$)/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': `Content-Type, ${IDEMPOTENCY_KEY}, ${JOB_TOKEN}, PAYMENT-SIGNATURE`,
          'Access-Control-Max-Age': '600',
        },
      });
    }
    if (path === '/.well-known/stellar-agent-services.json' && request.method === 'GET') {
      maybeSweep();
      return json(manifest, 200, { 'Cache-Control': 'max-age=300' });
    }
    if (path === '/health' && request.method === 'GET') {
      return json({ ok: true, network: config.network, services: [...services.keys()] }, 200, {
        'Cache-Control': 'no-store',
      });
    }

    const createJobPath = /^\/services\/([^/]+)\/jobs$/.exec(path);
    if (createJobPath && request.method === 'POST') {
      maybeSweep();
      let name: string;
      try {
        name = decodeURIComponent(createJobPath[1]);
      } catch {
        return error('service_not_found');
      }
      return await createJob(request, name);
    }
    const jobPath = /^\/jobs\/([^/]+?)(\/result)?$/.exec(path);
    if (jobPath && request.method === 'GET') {
      return await getJob(request, jobPath[1], jobPath[2] !== undefined);
    }

    // The call's own routes, authenticated by the per-job token Twilio got in its URLs.
    if (path === '/phone/stream' && request.method === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response(null, { status: 426 });
      }
      return phone.stream(request);
    }
    const twimlPath = /^\/phone\/twiml\/([0-9a-f-]{36})$/.exec(path);
    if (twimlPath && (request.method === 'GET' || request.method === 'POST')) {
      const twiml = await phone.twiml(twimlPath[1], url.searchParams.get('token') ?? '');
      if (twiml === undefined) return new Response(null, { status: 401 });
      return new Response(twiml, { headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' } });
    }
    const callbackPath = /^\/webhooks\/twilio\/([0-9a-f-]{36})$/.exec(path);
    if (callbackPath && request.method === 'POST') {
      const declared = Number(request.headers.get('Content-Length') ?? '0');
      const body = declared > 64 * 1024 ? undefined : await readBounded(request, 64 * 1024);
      if (body === undefined) return new Response(null, { status: 413 });
      const accepted = await phone.statusCallback(
        callbackPath[1],
        url.searchParams.get('token') ?? '',
        new URLSearchParams(new TextDecoder().decode(body)),
      );
      if (!accepted) return new Response(null, { status: 401 });
      return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
    }
    if (path === '/internal/sweep' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /i, '') ?? '';
      if (!config.sweepSecret || !sameHash(await sha256Hex(token), await sha256Hex(config.sweepSecret))) {
        return new Response(null, { status: 401 });
      }
      return json(await sweep(), 200, { 'Cache-Control': 'no-store' });
    }
    return error('service_not_found');
  }

  return {
    async fetch(request) {
      try {
        return await route(request);
      } catch (cause) {
        // Never a 500 [Q1]: a dependency is down. Nothing was charged unless the job says so.
        console.error('stellar request failed', errorName(cause));
        return error('unavailable', 'a dependency is unavailable; retry the same request later');
      }
    },
    sweep,
  };
}

function errorName(cause: unknown): string {
  const code = (cause as { code?: unknown })?.code;
  return `${cause instanceof Error ? cause.name : 'unknown'}${
    typeof code === 'string' ? ` ${code.slice(0, 40)}` : ''
  }`;
}
