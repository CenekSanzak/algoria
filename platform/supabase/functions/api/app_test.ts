import { deepEqual, equal, ok } from 'node:assert/strict';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from 'npm:@x402/core@2.22.0/http';
import { createApp, type Dependencies } from './app.ts';
import { type FalPollResult, FalSubmissionError } from './fal.ts';
import { ASSET, NETWORK, PaymentGateway, type PaymentPayload, type PaymentRequirements } from './payments.ts';
import type { ClaimResult, CompletionClaim, Job, NewJob } from './store.ts';

const RECIPIENT = 'GCTVT52AAFK7KYO74JAO3QOLNT6BUYTCZYHTRD7C2VZG6C5CJNRVEV6Y';
const PAYER = 'GDSGS53IUWOSFIW7EWW5NJ4WJLUNVRSH3MYQ3YFGWEJI7VZCVE3C6JDT';
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

function harness() {
  const store = new MemoryStore();
  const downloadedUrls: string[] = [];
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
    },
    store,
    payments: {
      requirements: () => {
        calls.requirements++;
        return Promise.resolve(copy(REQUIREMENTS));
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
      submit: () => {
        calls.submit++;
        if (state.submission !== 'success') {
          return Promise.reject(new FalSubmissionError('submission test', state.submission));
        }
        return Promise.resolve({ requestId: `fal-request-${calls.submit}` });
      },
      poll: () => {
        calls.poll++;
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
    } = {},
  ) {
    const headers: Record<string, string> = {
      'Idempotency-Key': id,
      'X-Recovery-Token': options.token ?? TOKEN,
      'Content-Type': options.contentType ?? 'application/json',
    };
    if (options.payment !== false) headers['PAYMENT-SIGNATURE'] = options.payment ?? `payment-${id}`;
    return await app.request(`/v1/services/image.generate${options.query ?? ''}`, {
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
  return { app, store, calls, state, downloadedUrls, post, status, webhook };
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
