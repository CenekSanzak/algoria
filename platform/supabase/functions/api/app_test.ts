import { deepEqual, equal, ok } from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from 'npm:@x402/core@2.22.0/http';
import { StrKey } from 'npm:@stellar/stellar-sdk@16.2.0';
import { createApp, type Dependencies } from './app.ts';
import { getService, LEGACY_COMPOSE_SERVICE } from './catalog.ts';
import { type FalPollResult, FalSubmissionError, type FalTarget } from './fal.ts';
import { ASSET, NETWORK, PaymentGateway, type PaymentPayload, type PaymentRequirements } from './payments.ts';
import { hash } from './security.ts';
import type { ClaimResult, CompletionClaim, Job, NewJob } from './store.ts';

const RECIPIENT = 'GCTVT52AAFK7KYO74JAO3QOLNT6BUYTCZYHTRD7C2VZG6C5CJNRVEV6Y';
const PAYER = 'GDSGS53IUWOSFIW7EWW5NJ4WJLUNVRSH3MYQ3YFGWEJI7VZCVE3C6JDT';
const MEDIA_RECIPIENTS = [1, 2, 3, 4].map((value) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, value)));
const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: ASSET,
  amount: '100000',
  payTo: RECIPIENT,
  maxTimeoutSeconds: 120,
  extra: { areFeesSponsored: true },
};
const RECEIPT = { success: true, network: NETWORK, transaction: 'b'.repeat(64), payer: PAYER };
const TOKEN = 'a'.repeat(43);
const INPUT = { prompt: 'An orange cat resting on a windowsill' };
const RESULT: FalPollResult = {
  status: 'succeeded',
  images: [{ url: 'https://fal.media/generated.png', width: 1024, height: 1024, content_type: 'image/png' }],
};
const copy = <T>(value: T): T => structuredClone(value);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type JobStore = Dependencies['store'];

/** Contract fake: each mutation is atomic and each returned row is a detached
 * snapshot, just as SQL RPCs return. No network, wallet, provider or storage I/O.
 */
class MemoryStore implements JobStore {
  jobs = new Map<string, Job>();
  fingerprints = new Map<string, string>();
  leases = new Map<string, string>();
  events = new Set<string>();
  completed = 0;

  private row(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job-not-found');
    return job;
  }
  private patch(id: string, values: Partial<Job>): Job {
    const job = this.row(id);
    Object.assign(job, values, { updated_at: new Date().toISOString() });
    return copy(job);
  }
  get(id: string): Promise<Job | null> {
    return Promise.resolve(copy(this.jobs.get(id) ?? null));
  }
  getByProviderId(id: string): Promise<Job | null> {
    return Promise.resolve(
      copy([...this.jobs.values()].find((job) => job.provider_request_id === id) ?? null),
    );
  }
  create(candidate: NewJob): Promise<{ job: Job; created: boolean }> {
    const existing = this.jobs.get(candidate.id);
    if (existing) {
      if (
        existing.input_hash !== candidate.input_hash ||
        existing.recovery_token_hash !== candidate.recovery_token_hash ||
        existing.service_id !== candidate.service_id
      ) {
        return Promise.reject(new Error('job-snapshot-conflict'));
      }
      return Promise.resolve({ job: copy(existing), created: false });
    }
    const now = new Date().toISOString();
    const job: Job = {
      ...copy(candidate),
      status: 'awaiting_payment',
      payer: null,
      payment_receipt: null,
      provider_request_id: null,
      output: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(job.id, job);
    return Promise.resolve({ job: copy(job), created: true });
  }
  capacity() {
    return Promise.resolve({
      available: true,
      totalUsed: this.fingerprints.size,
      active: 0,
      maxTotal: 10,
      maxConcurrent: 2,
    });
  }
  claimPayment(
    id: string,
    fingerprint: string,
    payer: string,
    _payload: Record<string, unknown>,
  ): Promise<ClaimResult> {
    const job = this.row(id);
    if (job.status !== 'awaiting_payment') {
      return Promise.resolve({ claimed: false, reason: 'invalid-status', job: copy(job) });
    }
    if (this.fingerprints.has(fingerprint)) {
      return Promise.resolve({ claimed: false, reason: 'payment-replayed', job: copy(job) });
    }
    this.fingerprints.set(fingerprint, id);
    return Promise.resolve({ claimed: true, job: this.patch(id, { status: 'settling', payer }) });
  }
  finishPayment(
    id: string,
    outcome: 'success' | 'failed' | 'uncertain',
    receipt: Record<string, unknown>,
  ): Promise<Job> {
    return Promise.resolve(
      this.patch(id, {
        status: outcome === 'success'
          ? 'paid'
          : outcome === 'failed'
          ? 'awaiting_payment'
          : 'payment_uncertain',
        payment_receipt: receipt,
      }),
    );
  }
  claimSubmission(id: string): Promise<ClaimResult> {
    const job = this.row(id);
    if (job.status !== 'paid') return Promise.resolve({ claimed: false, job: copy(job) });
    return Promise.resolve({ claimed: true, job: this.patch(id, { status: 'submitting' }) });
  }
  setSubmitted(id: string, providerId: string): Promise<Job> {
    return Promise.resolve(this.patch(id, { status: 'queued', provider_request_id: providerId }));
  }
  failJob(id: string, code: string, message: string): Promise<Job> {
    const current = this.row(id);
    if (['succeeded', 'failed', 'settling', 'payment_uncertain'].includes(current.status)) {
      return Promise.resolve(copy(current));
    }
    this.leases.delete(id);
    return Promise.resolve(this.patch(id, { status: 'failed', error: { code, message } }));
  }
  claimCompletion(id: string): Promise<CompletionClaim> {
    const current = this.row(id);
    if (!['queued', 'running'].includes(current.status) || this.leases.has(id)) {
      return Promise.resolve({ claimed: false, job: copy(current) });
    }
    const leaseToken = crypto.randomUUID();
    this.leases.set(id, leaseToken);
    return Promise.resolve({ claimed: true, leaseToken, job: this.patch(id, { status: 'saving' }) });
  }
  complete(id: string, leaseToken: string, output: Record<string, unknown>): Promise<Job> {
    if (this.leases.get(id) !== leaseToken) return Promise.resolve(copy(this.row(id)));
    this.leases.delete(id);
    this.completed++;
    return Promise.resolve(this.patch(id, { status: 'succeeded', output }));
  }
  releaseCompletion(id: string, leaseToken: string): Promise<Job> {
    if (this.leases.get(id) !== leaseToken) return Promise.resolve(copy(this.row(id)));
    this.leases.delete(id);
    return Promise.resolve(this.patch(id, { status: 'queued' }));
  }
  markRunning(id: string): Promise<Job> {
    return Promise.resolve(
      this.row(id).status === 'queued' ? this.patch(id, { status: 'running' }) : copy(this.row(id)),
    );
  }
  recordWebhook(eventKey: string, _providerId: string): Promise<boolean> {
    const newEvent = !this.events.has(eventKey);
    this.events.add(eventKey);
    return Promise.resolve(newEvent);
  }
}

function harness(allServices = false) {
  const store = new MemoryStore();
  const downloadedUrls: string[] = [];
  const submissions: { input: Record<string, unknown>; target?: FalTarget }[] = [];
  const pollTargets: (FalTarget | undefined)[] = [];
  const calls = {
    requirements: 0,
    verify: 0,
    settle: 0,
    submit: 0,
    poll: 0,
    download: 0,
    put: 0,
    webhook: 0,
  };
  const state: {
    result: FalPollResult;
    settlement: 'success' | 'failed' | 'uncertain';
    submission: 'success' | 'uncertain' | 'rejected';
    settleGate?: Promise<void>;
    putGate?: Promise<void>;
    onSettle?: () => void;
    onPut?: () => void;
    putError?: boolean;
    pollError?: boolean;
    signingWaitsForAbort?: boolean;
  } = {
    result: copy(RESULT),
    settlement: 'success',
    submission: 'success',
  };
  const paymentGateway = new PaymentGateway();
  const dependencies: Dependencies = {
    config: {
      supabaseUrl: 'https://db.example.test',
      serviceRoleKey: 'fake',
      falKey: 'fake',
      imagePayTo: RECIPIENT,
      baseUrl: 'https://api.example.test/functions/v1/api',
      facilitatorUrl: 'https://facilitator.example.test',
      priceAtomic: '100000',
      servicePayments: allServices
        ? {
          'speech.generate': { payTo: MEDIA_RECIPIENTS[0], priceAtomic: '200000' },
          'video.slideshow': { payTo: MEDIA_RECIPIENTS[1], priceAtomic: '100000' },
          'video.compose': { payTo: MEDIA_RECIPIENTS[2], priceAtomic: '100000' },
          'video.caption': { payTo: MEDIA_RECIPIENTS[3], priceAtomic: '200000' },
        }
        : {},
    },
    store,
    payments: {
      requirements: (payTo, amount) => {
        calls.requirements++;
        return Promise.resolve({ ...copy(REQUIREMENTS), payTo, amount });
      },
      challenge: paymentGateway.challenge.bind(paymentGateway),
      parse: (signature) => {
        if (signature === 'invalid') throw new Error('invalid');
        return { x402Version: 2, accepted: copy(REQUIREMENTS), payload: { transaction: signature } };
      },
      fingerprint: (payload: PaymentPayload) => Promise.resolve(String(payload.payload.transaction)),
      verify: () => {
        calls.verify++;
        return Promise.resolve({ valid: true, payer: PAYER });
      },
      settle: async () => {
        calls.settle++;
        state.onSettle?.();
        if (state.settleGate) await state.settleGate;
        return {
          outcome: state.settlement,
          receipt: state.settlement === 'success'
            ? copy(RECEIPT)
            : { success: false, network: NETWORK, transaction: '', errorReason: 'unconfirmed' },
        };
      },
    },
    fal: {
      submit: (input, _webhookUrl, target) => {
        calls.submit++;
        submissions.push(copy({ input, target }));
        if (state.submission !== 'success') {
          return Promise.reject(new FalSubmissionError('submission test', state.submission));
        }
        return Promise.resolve({ requestId: `fal-request-${calls.submit}` });
      },
      poll: (_requestId, _signal, target) => {
        calls.poll++;
        pollTargets.push(copy(target));
        if (state.pollError) return Promise.reject(new Error('provider temporarily unavailable'));
        return Promise.resolve(copy(state.result));
      },
      verifyWebhook: (_body, headers) => {
        calls.webhook++;
        return Promise.resolve(headers.get('x-test-signature') === 'verified');
      },
    },
    artifacts: {
      put: async () => {
        calls.put++;
        state.onPut?.();
        if (state.putGate) await state.putGate;
        if (state.putError) throw new Error('storage unavailable');
      },
      signedUrl: (path, signal) => {
        if (!state.signingWaitsForAbort) {
          return Promise.resolve(`https://storage.example.test/${path}?signed=yes`);
        }
        if (!signal) return Promise.reject(new Error('sync signing must receive its deadline'));
        if (signal.aborted) return Promise.reject(signal.reason);
        return new Promise<string>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('signing deadline did not abort')), 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          }, { once: true });
        });
      },
    },
    download: (image) => {
      calls.download++;
      downloadedUrls.push(image.url);
      return Promise.resolve({ bytes: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' });
    },
    downloadAudio: () =>
      Promise.resolve({ bytes: new Uint8Array(44), contentType: 'audio/wav', duration: 15 }),
    downloadVideo: () =>
      Promise.resolve({ bytes: new Uint8Array(64), contentType: 'video/mp4', duration: 20 }),
  };
  const app = createApp(dependencies);
  async function post(
    id: string,
    options: {
      payment?: string | false;
      token?: string;
      input?: unknown;
      query?: string;
      contentType?: string;
      service?: string;
    } = {},
  ) {
    const headers: Record<string, string> = {
      'Idempotency-Key': id,
      'X-Recovery-Token': options.token ?? TOKEN,
      'Content-Type': options.contentType ?? 'application/json',
    };
    if (options.payment !== false) headers['PAYMENT-SIGNATURE'] = options.payment ?? `payment-${id}`;
    return await app.request(`/v1/services/${options.service ?? 'image.generate'}${options.query ?? ''}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.input ?? INPUT),
    });
  }
  async function status(id: string, token: string | null = TOKEN) {
    return await app.request(`/v1/jobs/${id}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
  }
  async function webhook(valid = true) {
    return await app.request('/webhooks/fal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-signature': valid ? 'verified' : 'invalid' },
      body: JSON.stringify({
        request_id: 'fal-request-1',
        status: 'OK',
        payload: { images: [{ url: 'https://attacker.example/forged' }] },
      }),
    });
  }
  return {
    app,
    store,
    calls,
    state,
    dependencies,
    downloadedUrls,
    submissions,
    pollTargets,
    post,
    status,
    webhook,
  };
}

/** A durable paid snapshot from a prior request, with no external source or payment I/O. */
async function paidMediaJob(h: ReturnType<typeof harness>, kind: 'audio' | 'video') {
  const id = crypto.randomUUID();
  const service = kind === 'audio' ? 'speech.generate' : 'video.compose';
  const source = (file: string) =>
    `https://db.example.test/storage/v1/object/sign/outputs/${crypto.randomUUID()}/${file}?token=admitted`;
  const input = kind === 'audio' ? { text: 'A short narration.', voice: 'Craig (en)' } : {
    video_url: source('video.mp4'),
    audio_url: source('audio.wav'),
  };
  const payment = h.dependencies.config.servicePayments![service];
  await h.store.create({
    id,
    service_id: service,
    service_version: getService(service)!.version,
    input,
    input_hash: await hash(JSON.stringify({ service, input })),
    recovery_token_hash: await hash(TOKEN),
    requirements: { ...REQUIREMENTS, payTo: payment.payTo, amount: payment.priceAtomic },
    resource_url: `${h.dependencies.config.baseUrl}/v1/services/${service}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await h.store.claimPayment(id, `payment-${id}`, PAYER, {});
  await h.store.finishPayment(id, 'success', RECEIPT);
  h.state.result = kind === 'audio'
    ? { status: 'succeeded', audio: { url: 'https://fal.media/audio.wav' } }
    : { status: 'succeeded', video: { url: 'https://fal.media/video.mp4' } };
  return { id, service, input };
}

Deno.test('unpaid request returns standard 402 without settlement or fal work', async () => {
  const h = harness();
  const response = await h.post(crypto.randomUUID(), { payment: false });
  equal(response.status, 402);
  const challenge = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED')!);
  deepEqual(challenge.accepts, [REQUIREMENTS]);
  ok(challenge.extensions?.bazaar);
  deepEqual({ verify: h.calls.verify, settle: h.calls.settle, submit: h.calls.submit, poll: h.calls.poll }, {
    verify: 0,
    settle: 0,
    submit: 0,
    poll: 0,
  });
});

Deno.test('sync success returns stored output and a standard settlement receipt', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  const response = await h.post(id);
  equal(response.status, 200);
  const body = await response.json();
  equal(body.job_id, id);
  equal(body.status, 'succeeded');
  equal(body.output.images[0].url, `https://storage.example.test/${id}/image.png?signed=yes`);
  deepEqual(decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!), RECEIPT);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
  equal(h.calls.put, 1);
});

for (const query of ['?mode=async', '?mode=sync&wait_ms=0']) {
  Deno.test(`${query} returns 202 then authenticated status completes the same job`, async () => {
    const h = harness();
    const id = crypto.randomUUID();
    const initial = await h.post(id, { query });
    equal(initial.status, 202);
    equal(initial.headers.get('Retry-After'), '3');
    equal((await initial.json()).status, 'queued');
    equal(h.calls.poll, 0);
    const later = await h.status(id);
    equal(later.status, 200);
    equal((await later.json()).status, 'succeeded');
    equal(h.calls.settle, 1);
    equal(h.calls.submit, 1);
  });
}

Deno.test('missing or wrong recovery token returns 404 and never polls a provider', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  await h.post(id, { query: '?mode=async' });
  for (const token of [null, '', 'b'.repeat(43)]) equal((await h.status(id, token)).status, 404);
  equal((await h.post(id, { token: 'b'.repeat(43) })).status, 404);
  equal(h.calls.poll, 0);
  equal(h.calls.settle, 1);
});

Deno.test('changed input conflicts with the stored request before payment or generation', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  await h.post(id, { payment: false });
  const response = await h.post(id, { input: { prompt: 'Changed prompt' } });
  equal(response.status, 409);
  equal((await response.json()).code, 'request-conflict');
  equal(h.calls.settle, 0);
  equal(h.calls.submit, 0);
});

Deno.test('concurrent same-identity requests and later retries settle and submit exactly once', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  const entered = deferred();
  const release = deferred();
  h.state.onSettle = entered.resolve;
  h.state.settleGate = release.promise;
  const first = h.post(id, { query: '?mode=async' });
  await entered.promise;
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => h.post(id, { query: '?mode=async' })));
  for (const response of concurrent) equal(response.status, 202);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 0);
  release.resolve();
  equal((await first).status, 202);
  for (let retry = 0; retry < 3; retry++) equal((await h.post(id)).status, 200);
  equal(h.store.jobs.size, 1);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
  equal(h.calls.put, 1);
});

Deno.test('switching async to sync waits for the existing job without a new payment', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  equal((await h.post(id, { query: '?mode=async' })).status, 202);
  const switched = await h.post(id, { payment: false, query: '?mode=sync' });
  equal(switched.status, 200);
  equal((await switched.json()).job_id, id);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
});

Deno.test('simultaneous first requests converge on one durable job and one submission', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.post(id, { query: '?mode=async' })));
  for (const response of responses) equal(response.status, 202);
  equal(h.store.jobs.size, 1);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
  equal((await (await h.status(id)).json()).status, 'succeeded');
});

Deno.test('a payment fingerprint cannot be spent on a second job', async () => {
  const h = harness();
  await h.post(crypto.randomUUID(), { payment: 'same-payment', query: '?mode=async' });
  const second = await h.post(crypto.randomUUID(), { payment: 'same-payment', query: '?mode=async' });
  equal(second.status, 409);
  equal((await second.json()).code, 'payment-already-used');
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
});

Deno.test('uncertain settlement remains recoverable and never submits fal or resettles', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  h.state.settlement = 'uncertain';
  const first = await h.post(id);
  equal(first.status, 202);
  equal((await first.json()).status, 'payment-uncertain');
  equal((await h.post(id)).status, 202);
  equal((await (await h.status(id)).json()).status, 'payment-uncertain');
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 0);
  equal(h.calls.poll, 0);
});

Deno.test('unknown fal submission remains submitting and is never automatically repeated', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  h.state.submission = 'uncertain';
  const first = await h.post(id);
  equal(first.status, 202);
  equal((await first.json()).status, 'submitting');
  h.store.jobs.get(id)!.updated_at = new Date(Date.now() - 31_000).toISOString();
  equal((await (await h.status(id)).json()).status, 'submission-uncertain');
  equal((await h.post(id)).status, 202);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
  equal(h.calls.poll, 0);
});

Deno.test('invalid input, unsupported mode and malformed identity cause no payment or provider effects', async () => {
  const h = harness();
  for (
    const input of [{ prompt: '' }, { prompt: 'x', model: 'other' }, { prompt: 'x'.repeat(4001) }, [], {}]
  ) {
    equal((await h.post(crypto.randomUUID(), { input })).status, 400);
  }
  equal((await h.post('bad-id')).status, 400);
  equal((await h.post(crypto.randomUUID(), { token: 'short' })).status, 400);
  equal((await h.post(crypto.randomUUID(), { query: '?mode=invalid' })).status, 400);
  equal((await h.post(crypto.randomUUID(), { query: '?wait_ms=60001' })).status, 400);
  equal((await h.post(crypto.randomUUID(), { contentType: 'text/plain' })).status, 415);
  equal(h.store.jobs.size, 0);
  equal(h.calls.settle, 0);
  equal(h.calls.submit, 0);
});

Deno.test('invalid webhook cannot trigger provider retrieval or event recording', async () => {
  const h = harness();
  await h.post(crypto.randomUUID(), { query: '?mode=async' });
  equal((await h.webhook(false)).status, 401);
  equal(h.calls.poll, 0);
  equal(h.calls.put, 0);
  equal(h.store.events.size, 0);
});

Deno.test('concurrent verified callbacks share a completion lease and ignore callback result URLs', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  await h.post(id, { query: '?mode=async' });
  const entered = deferred();
  const release = deferred();
  h.state.onPut = entered.resolve;
  h.state.putGate = release.promise;
  const first = h.webhook();
  await entered.promise;
  equal((await h.webhook()).status, 503);
  equal(h.calls.put, 1);
  equal(h.calls.download, 1);
  release.resolve();
  equal((await first).status, 200);
  equal((await h.webhook()).status, 200);
  equal(h.store.events.size, 1);
  equal(h.store.completed, 1);
  equal(h.calls.put, 1);
  deepEqual(h.downloadedUrls, ['https://fal.media/generated.png']);
  const output = await (await h.status(id)).json();
  equal(output.status, 'succeeded');
  ok(output.output.images[0].url.startsWith(`https://storage.example.test/${id}/`));
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
});

Deno.test('storage failure releases completion lease so recovery retries storage without regeneration', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  await h.post(id, { query: '?mode=async' });
  h.state.putError = true;
  equal((await (await h.status(id)).json()).status, 'queued');
  equal(h.store.leases.size, 0);
  h.state.putError = false;
  equal((await (await h.status(id)).json()).status, 'succeeded');
  equal(h.calls.put, 2);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
});

for (const failure of ['putError', 'pollError'] as const) {
  Deno.test(`webhook ${failure} returns 503 and identical retry completes without new generation`, async () => {
    const h = harness();
    const id = crypto.randomUUID();
    await h.post(id, { query: '?mode=async' });
    h.state[failure] = true;
    const failedDelivery = await h.webhook();
    equal(failedDelivery.status, 503);
    equal(h.store.jobs.get(id)!.status, 'queued');
    equal(h.store.leases.size, 0);
    h.state[failure] = false;
    equal((await h.webhook()).status, 200);
    equal(h.store.jobs.get(id)!.status, 'succeeded');
    equal(h.store.events.size, 1);
    equal(h.store.completed, 1);
    equal(h.calls.settle, 1);
    equal(h.calls.submit, 1);
  });
}

Deno.test('sync URL-signing deadline returns 202 result-ready and status later delivers the same output', async () => {
  const h = harness();
  const id = crypto.randomUUID();
  equal((await h.post(id)).status, 200);
  h.state.signingWaitsForAbort = true;
  const response = await h.post(id, { payment: false, query: '?mode=sync&wait_ms=10' });
  equal(response.status, 202);
  const body = await response.json();
  equal(body.job_id, id);
  equal(body.status, 'result-ready');
  equal(body.output, null);
  ok(body.status_url.endsWith(`/v1/jobs/${id}`));
  deepEqual(decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!), RECEIPT);
  equal(h.store.jobs.get(id)!.status, 'succeeded');
  h.state.signingWaitsForAbort = false;
  const recovered = await h.status(id);
  equal(recovered.status, 200);
  const result = await recovered.json();
  equal(result.status, 'succeeded');
  ok(result.output.images[0].url.includes(id));
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
  equal(h.calls.put, 1);
});

Deno.test('speech has its own quote and recovers the same audio without another payment', async () => {
  const h = harness(true);
  const id = crypto.randomUUID();
  const options = { service: 'speech.generate', input: { text: 'Meet your next adventure.' } };
  const unpaid = await h.post(id, { ...options, payment: false });
  equal(unpaid.status, 402);
  const quote = await unpaid.json();
  equal(quote.accepts[0].payTo, MEDIA_RECIPIENTS[0]);
  equal(quote.accepts[0].amount, '200000');
  equal(quote.extensions.bazaar.info.input.body.voice, 'Craig (en)');
  h.state.result = { status: 'succeeded', audio: { url: 'https://fal.media/speech.wav' } };
  equal((await h.post(id, { ...options, query: '?mode=async' })).status, 202);
  const complete = await (await h.status(id)).json();
  equal(complete.output.audio.content_type, 'audio/wav');
  equal(complete.output.audio.duration, 15);
  equal(complete.output.images, undefined);
  equal((await h.post(id, { ...options, payment: false })).status, 200);
  equal(h.calls.settle, 1);
  equal(h.calls.submit, 1);
  equal((await h.post(id, { ...options, input: { text: 'Changed text' } })).status, 409);
  equal((await h.post(id, { input: INPUT })).status, 409);
});

Deno.test('invalid speech input never creates a quote or spends money', async () => {
  const h = harness(true);
  for (
    const input of [{ text: '' }, { text: 'x'.repeat(1001) }, { text: 'Hello', voice: 'invented' }, {
      text: 'Hello',
      audio_url: 'https://example.com/clone.wav',
    }]
  ) {
    equal((await h.post(crypto.randomUUID(), { service: 'speech.generate', input })).status, 400);
  }
  equal(h.store.jobs.size, 0);
  equal(h.calls.settle, 0);
  equal(h.calls.submit, 0);
});

Deno.test('five-stage video chain accepts authorized outputs and completes each purchase once', async () => {
  const h = harness(true);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    ok(url.startsWith('https://db.example.test/storage/v1/object/sign/outputs/'));
    equal(init?.method, 'HEAD');
    const type = url.includes('.wav?') ? 'audio/wav' : url.includes('.mp4?') ? 'video/mp4' : 'image/png';
    return Promise.resolve(
      new Response(null, { headers: { 'content-type': type, 'content-length': '1000' } }),
    );
  };
  try {
    const imageId = crypto.randomUUID();
    equal((await h.post(imageId)).status, 200);
    const audioId = crypto.randomUUID();
    h.state.result = { status: 'succeeded', audio: { url: 'https://fal.media/speech.wav' } };
    equal(
      (await h.post(audioId, { service: 'speech.generate', input: { text: 'A short product story.' } }))
        .status,
      200,
    );
    const source = (id: string, file: string) =>
      `https://db.example.test/storage/v1/object/sign/outputs/${id}/${file}?token=test`;
    h.state.result = { status: 'succeeded', video: { url: 'https://fal.media/video.mp4' } };
    const slideshowId = crypto.randomUUID();
    const slideshowInput = { images: [{ url: source(imageId, 'image.png'), duration_seconds: 20 }] };
    const slideshow = await h.post(slideshowId, { service: 'video.slideshow', input: slideshowInput });
    equal(slideshow.status, 200);
    equal((await slideshow.json()).output.video.duration, 20);
    equal(h.submissions.at(-1)!.target!.model, 'fal-ai/ffmpeg-api/images-to-video');
    equal(h.submissions.at(-1)!.input.fps, 24);
    const input = { video_url: source(slideshowId, 'video.mp4'), audio_url: source(audioId, 'audio.wav') };
    const composedId = crypto.randomUUID();
    const composed = await h.post(composedId, { service: 'video.compose', input });
    equal(composed.status, 200);
    const body = await composed.json();
    equal(body.output.video.duration, 20);
    equal(body.service_version, '2');
    equal(h.store.jobs.get(composedId)!.service_version, '2');
    equal(h.submissions.at(-1)!.target!.model, 'fal-ai/ffmpeg-api/merge-audio-video');
    equal(h.submissions.at(-1)!.target!.output, 'video');
    const captionId = crypto.randomUUID();
    const captionInput = { video_url: source(composedId, 'video.mp4') };
    equal(
      (await h.post(captionId, { service: 'video.caption', input: captionInput, query: '?mode=async' }))
        .status,
      202,
    );
    equal((await (await h.status(captionId)).json()).status, 'succeeded');
    equal(
      (await h.post(captionId, { service: 'video.caption', input: captionInput, payment: false })).status,
      200,
    );
    equal(h.calls.settle, 5);
    equal(h.calls.submit, 5);
    h.store.jobs.get(audioId)!.output!.duration = 25;
    const bad = await h.post(crypto.randomUUID(), {
      service: 'video.compose',
      input,
    });
    equal(bad.status, 400);
    equal((await bad.json()).code, 'narration-too-long');
    h.store.jobs.get(audioId)!.output!.duration = 15;
    const long = await h.post(crypto.randomUUID(), {
      service: 'video.slideshow',
      input: { images: [{ ...slideshowInput.images[0], duration_seconds: 31 }] },
    });
    equal(long.status, 400);
    const external = await h.post(crypto.randomUUID(), {
      service: 'video.caption',
      input: { video_url: 'https://attacker.example/video.mp4' },
    });
    equal(external.status, 400);
    equal(h.calls.settle, 5);
    equal(h.store.jobs.size, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('legacy paid composition authenticates before parsing and resumes its original schema and provider', async () => {
  const h = harness(true);
  const imageId = crypto.randomUUID();
  equal((await h.post(imageId)).status, 200);
  h.state.result = { status: 'succeeded', audio: { url: 'https://fal.media/speech.wav' } };
  const audioId = crypto.randomUUID();
  equal(
    (await h.post(audioId, { service: 'speech.generate', input: { text: 'An existing narration.' } })).status,
    200,
  );
  const source = (id: string, file: string) =>
    `https://db.example.test/storage/v1/object/sign/outputs/${id}/${file}?token=expired-but-admitted`;
  const input = {
    images: [{ url: source(imageId, 'image.png'), duration_seconds: 20 }],
    audio_url: source(audioId, 'audio.wav'),
  };
  const { id, service } = await paidMediaJob(h, 'video');
  const stored = h.store.jobs.get(id)!;
  stored.service_version = '1';
  stored.input = input;
  stored.input_hash = await hash(JSON.stringify({ service, input }));
  const before = { ...h.calls };

  equal((await h.post(id, { service, input: { invalid: true }, token: 'b'.repeat(43) })).status, 404);
  equal((await h.post(id, { service: 'speech.generate', input: { invalid: true } })).status, 409);
  equal((await h.post(crypto.randomUUID(), { service, input, payment: false })).status, 400);
  equal((await h.post(id, { service, input, payment: false, query: '?mode=async' })).status, 202);
  const legacyTarget = {
    model: LEGACY_COMPOSE_SERVICE.model,
    queuePath: LEGACY_COMPOSE_SERVICE.queuePath,
    output: LEGACY_COMPOSE_SERVICE.providerOutput,
  };
  deepEqual(h.submissions.at(-1)!.target, legacyTarget);
  ok(Array.isArray(h.submissions.at(-1)!.input.tracks));
  const recovered = await (await h.status(id)).json();
  equal(recovered.status, 'succeeded');
  equal(recovered.service_version, '1');
  equal(recovered.output.video.duration, 20);
  deepEqual(h.pollTargets.at(-1), legacyTarget);
  equal((await h.post(id, { service, input, payment: false })).status, 200);
  equal(h.calls.submit, before.submit + 1);
  equal(h.calls.poll, before.poll + 1);
  equal(h.calls.settle, before.settle);
  equal(h.calls.verify, before.verify);
  equal(h.calls.requirements, before.requirements);
});

for (const kind of ['audio', 'video'] as const) {
  Deno.test(`unverifiable ${kind} duration terminates the job and later recovery never retries completion`, async () => {
    for (const duration of [undefined, 0, -1, NaN, Infinity]) {
      const h = harness(true);
      const { id, service, input } = await paidMediaJob(h, kind);
      await h.store.claimSubmission(id);
      await h.store.setSubmitted(id, 'fal-request-1');
      const download = () => {
        h.calls.download++;
        return Promise.resolve({
          bytes: new Uint8Array(64),
          contentType: kind === 'audio' ? 'audio/wav' : 'video/mp4',
          duration,
        });
      };
      if (kind === 'audio') h.dependencies.downloadAudio = download;
      else h.dependencies.downloadVideo = download;

      const result = await (await h.status(id)).json();
      equal(result.status, 'failed');
      equal(result.error.code, 'invalid-media-duration');
      equal(result.output, null);
      deepEqual(result.payment, RECEIPT);
      equal(h.store.jobs.get(id)!.status, 'failed');
      equal(h.store.leases.size, 0);
      equal((await h.webhook()).status, 200);
      equal((await (await h.status(id)).json()).status, 'failed');
      equal((await h.post(id, { service, input, payment: false })).status, 502);
      deepEqual(
        {
          poll: h.calls.poll,
          download: h.calls.download,
          put: h.calls.put,
          submit: h.calls.submit,
          settle: h.calls.settle,
        },
        { poll: 1, download: 1, put: 0, submit: 0, settle: 0 },
      );
      equal(h.store.completed, 0);
    }
  });
}

Deno.test('video completion accepts the duration boundary and permanently fails outputs above it', async () => {
  for (const duration of [30.05, 30.051, 31]) {
    const h = harness(true);
    const { id, service, input } = await paidMediaJob(h, 'video');
    await h.store.claimSubmission(id);
    await h.store.setSubmitted(id, 'fal-request-1');
    h.dependencies.downloadVideo = () => {
      h.calls.download++;
      return Promise.resolve({ bytes: new Uint8Array(64), contentType: 'video/mp4', duration });
    };
    const result = await (await h.status(id)).json();
    const expected = duration === 30.05 ? 'succeeded' : 'failed';
    equal(result.status, expected);
    equal(h.store.leases.size, 0);
    if (expected === 'failed') {
      equal(result.error.code, 'output-duration-limit');
      equal(result.output, null);
    } else equal(result.output.video.duration, duration);
    equal((await h.webhook()).status, 200);
    equal((await (await h.status(id)).json()).status, expected);
    equal((await h.post(id, { service, input, payment: false })).status, expected === 'failed' ? 502 : 200);
    equal(h.calls.poll, 1);
    equal(h.calls.download, 1);
    equal(h.calls.put, expected === 'failed' ? 0 : 1);
    equal(h.store.completed, expected === 'failed' ? 0 : 1);
    equal(h.calls.submit, 0);
    equal(h.calls.settle, 0);
  }
});

Deno.test('slideshow completion permits two frames of timing drift and permanently rejects a wrong duration', async () => {
  for (const duration of [15 + 2 / 24, 479 / 24, 14.9]) {
    const h = harness(true);
    const id = crypto.randomUUID();
    const service = 'video.slideshow';
    const input = {
      images: [1, 2, 3].map(() => ({
        url:
          `https://db.example.test/storage/v1/object/sign/outputs/${crypto.randomUUID()}/image.png?token=admitted`,
        duration_seconds: 5,
      })),
    };
    const payment = h.dependencies.config.servicePayments![service];
    await h.store.create({
      id,
      service_id: service,
      service_version: '1',
      input,
      input_hash: await hash(JSON.stringify({ service, input })),
      recovery_token_hash: await hash(TOKEN),
      requirements: { ...REQUIREMENTS, payTo: payment.payTo, amount: payment.priceAtomic },
      resource_url: `${h.dependencies.config.baseUrl}/v1/services/${service}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.store.claimPayment(id, `payment-${id}`, PAYER, {});
    await h.store.finishPayment(id, 'success', RECEIPT);
    await h.store.claimSubmission(id);
    await h.store.setSubmitted(id, 'fal-request-1');
    h.state.result = { status: 'succeeded', video: { url: 'https://fal.media/slideshow.mp4', duration: 15 } };
    h.dependencies.downloadVideo = () => {
      h.calls.download++;
      return Promise.resolve({ bytes: new Uint8Array(64), contentType: 'video/mp4', duration });
    };
    const result = await (await h.status(id)).json();
    const expected = duration === 15 + 2 / 24 ? 'succeeded' : 'failed';
    equal(result.status, expected);
    equal(h.store.leases.size, 0);
    deepEqual(result.payment, RECEIPT);
    if (expected === 'failed') {
      equal(result.error.code, 'unexpected-video-duration');
      equal(result.output, null);
    } else equal(result.output.video.duration, duration);
    equal((await h.webhook()).status, 200);
    equal((await (await h.status(id)).json()).status, expected);
    equal((await h.post(id, { service, input, payment: false })).status, expected === 'failed' ? 502 : 200);
    equal(h.calls.poll, 1);
    equal(h.calls.download, 1);
    equal(h.calls.put, expected === 'failed' ? 0 : 1);
    equal(h.calls.submit, 0);
    equal(h.calls.settle, 0);
  }
});

Deno.test('a disabled service recovers existing paid and finished jobs but rejects fresh purchases', async () => {
  const h = harness(true);
  const { id, service, input } = await paidMediaJob(h, 'audio');
  const disabled = createApp({
    ...h.dependencies,
    config: { ...h.dependencies.config, servicePayments: {} },
  });
  const post = (jobId: string, token = TOKEN) =>
    disabled.request(`/v1/services/${service}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': jobId,
        'X-Recovery-Token': token,
      },
      body: JSON.stringify(input),
    });
  equal((await disabled.request(`/v1/services/${service}`)).status, 404);
  equal((await post(crypto.randomUUID())).status, 404);
  equal((await post(id, 'b'.repeat(43))).status, 404);
  const paid = await (await disabled.request(`/v1/jobs/${id}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json();
  equal(paid.status, 'paid');
  ok(paid.message.includes('Retry the original POST'));
  equal(h.calls.submit, 0);

  const recovered = await post(id);
  equal(recovered.status, 200);
  const first = await recovered.json();
  equal(first.status, 'succeeded');
  equal(first.output.audio.duration, 15);
  deepEqual(decodePaymentResponseHeader(recovered.headers.get('PAYMENT-RESPONSE')!), RECEIPT);
  const finished = await post(id);
  equal(finished.status, 200);
  deepEqual((await finished.json()).output, first.output);
  equal(h.calls.submit, 1);
  equal(h.calls.poll, 1);
  equal(h.calls.put, 1);
  equal(h.calls.requirements, 0);
  equal(h.calls.verify, 0);
  equal(h.calls.settle, 0);
  equal(h.store.jobs.size, 1);
});

Deno.test('social HTTP service quotes and settles once, delegates composite work, and protects scheduler', async () => {
  const h = harness(true);
  h.dependencies.config.servicePayments!['video.social'] = { payTo: RECIPIENT, priceAtomic: '1100000' };
  let starts = 0;
  let ticks = 0;
  h.dependencies.workflowSecret = 'z'.repeat(43);
  h.dependencies.social = {
    validateReferences: () => Promise.resolve([]),
    start: async (job) => {
      starts++;
      await h.store.claimSubmission(job.id);
      return await h.store.setSubmitted(job.id, `social-${job.id}`);
    },
    advance: async (job) => {
      const lease = await h.store.claimCompletion(job.id);
      return lease.claimed
        ? await h.store.complete(job.id, lease.leaseToken!, {
          path: `${job.id}/compose.mp4`,
          content_type: 'video/mp4',
          width: 576,
          height: 1024,
          duration: 12,
        })
        : lease.job;
    },
    progress: () => Promise.resolve({ completed: 9, total: 9, steps: [], needs_reconciliation: false }),
    parent: () => Promise.resolve(null),
    sweep: () => {
      ticks++;
      return Promise.resolve([]);
    },
  };
  const app = createApp(h.dependencies);
  const id = crypto.randomUUID();
  const request = (payment = false) =>
    app.request('/v1/services/video.social?mode=async', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': id,
        'X-Recovery-Token': TOKEN,
        ...(payment ? { 'PAYMENT-SIGNATURE': 'social-payment' } : {}),
      },
      body: JSON.stringify(getService('video.social')!.exampleInput),
    });
  const quote = await request();
  equal(quote.status, 402);
  equal((await quote.json()).accepts[0].amount, '1100000');
  equal(starts, 0);
  equal(h.calls.settle, 0);
  equal((await request(true)).status, 202);
  equal(starts, 1);
  equal(h.calls.submit, 0);
  equal(h.calls.settle, 1);
  const done = await app.request(`/v1/jobs/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  equal((await done.json()).status, 'succeeded');
  equal((await request()).status, 200);
  equal(starts, 1);
  equal(h.calls.settle, 1);
  equal((await app.request('/internal/social/tick', { method: 'POST' })).status, 401);
  equal(ticks, 0);
  equal(
    (await app.request('/internal/social/tick', {
      method: 'POST',
      headers: { authorization: `Bearer ${'z'.repeat(43)}` },
    })).status,
    200,
  );
  equal(ticks, 1);
});
