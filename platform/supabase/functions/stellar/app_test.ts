import assert from 'node:assert/strict';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from 'npm:@x402/core@2.22.0/http';
import type { PaymentRequirements, SettleResponse } from 'npm:@x402/core@2.22.0/types';
import { signJob } from '../api/phone.ts';
import { createProvider, type ProviderDependencies } from './app.ts';
import { buildManifest, EXAMPLE_NUMBER, PHONE_OUTPUT_SCHEMA } from './manifest.ts';
import { PhoneCallService } from './phone.ts';
import { checkChallenge } from './protocol.ts';
import { validate } from './schema.ts';
import {
  BASE_URL,
  chain,
  CONFIG,
  database,
  directory,
  facilitator,
  PAYER,
  payment,
  twilio,
  TX_HASH,
} from './testing.ts';

const MANIFEST = buildManifest(CONFIG);
const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:pubnet',
  asset: CONFIG.asset,
  amount: '10000000',
  payTo: CONFIG.payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const INPUT = {
  to: '+14155550142',
  goal: 'Ask whether the store is open on Sunday.',
  on_behalf_of: 'Sam',
  callee_name: 'Corner Store',
};
const ID = '0192d3a4-7c1e-7b2a-9f00-3c5e8a1b2c3d';
const TOKEN = 'A'.repeat(43);

async function harness(
  options: {
    settle?: () => Promise<SettleResponse>;
    chain?: ProviderDependencies['chain'];
    directory?: Parameters<typeof directory>[0];
    concurrency?: number;
  } = {},
) {
  const { db, store, calls, age } = await database();
  const fac = facilitator(options.settle);
  const tw = twilio();
  const background: Promise<unknown>[] = [];
  const summaries: unknown[] = [];
  const phone = new PhoneCallService({
    config: CONFIG.phone,
    store,
    calls,
    twilio: tw,
    directory: directory(options.directory),
    summarize: (input, transcript) => {
      summaries.push({ input, transcript });
      return Promise.resolve({ summary: 'They are open on Sunday.', goal_achieved: true });
    },
    baseUrl: BASE_URL,
  });
  const config = { ...CONFIG, concurrency: options.concurrency ?? CONFIG.concurrency };
  const provider = createProvider({
    config,
    manifest: buildManifest(config),
    store,
    facilitator: fac,
    phone,
    chain: options.chain,
    waitUntil: (work) => background.push(work),
    holdMs: 500,
    reconcileRetryMs: 10,
  });
  const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    provider.fetch(new Request(`${BASE_URL}${path}`, init));
  const createJob = (
    body: unknown = INPUT,
    headers: Record<string, string> = { 'Idempotency-Key': ID, 'Job-Token': TOKEN },
  ) =>
    request('/services/phone-call/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const pay = (
    body: unknown = INPUT,
    headers: Record<string, string> = { 'Idempotency-Key': ID, 'Job-Token': TOKEN },
    nonce = '424242',
  ) => createJob(body, { ...headers, 'PAYMENT-SIGNATURE': payment(REQUIREMENTS, { nonce }).header });
  const status = (id = ID, token = TOKEN, result = false) =>
    request(`/jobs/${id}${result ? '/result' : ''}`, { headers: { 'Job-Token': token } });
  const settled = () => Promise.all(background);
  return { db, store, calls, age, fac, tw, provider, request, createJob, pay, status, settled, summaries };
}

Deno.test('the manifest is served as the standard asks, with CORS', async () => {
  const h = await harness();
  try {
    const response = await h.request('/.well-known/stellar-agent-services.json');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('cache-control'), 'max-age=300');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await response.json(), MANIFEST);
    const preflight = await h.request('/services/phone-call/jobs', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(
      preflight.headers.get('access-control-allow-headers')!,
      /Idempotency-Key, Job-Token, PAYMENT-SIGNATURE/,
    );
    // The function's path as Supabase hands it over works too.
    const short = await h.provider.fetch(
      new Request('https://ref.supabase.co/stellar/.well-known/stellar-agent-services.json'),
    );
    assert.equal(short.status, 200);
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('bad requests and bad input never reach a 402 [P8]', async () => {
  const h = await harness();
  try {
    const problem = async (response: Response, status: number, code: string) => {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('content-type'), 'application/problem+json');
      const body = await response.json();
      assert.equal(body.code, code);
      return body;
    };
    await problem(await h.createJob(INPUT, { 'Idempotency-Key': ID }), 400, 'invalid_request');
    await problem(
      await h.createJob(INPUT, { 'Idempotency-Key': ID.toUpperCase(), 'Job-Token': TOKEN }),
      400,
      'invalid_request',
    );
    await problem(await h.createJob('{not json'), 400, 'invalid_request');
    await problem(await h.createJob('[]'), 400, 'invalid_input');
    await problem(
      await h.request('/services/phone-call/jobs', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'text/plain' },
      }),
      400,
      'invalid_request',
    );
    await problem(await h.createJob({ ...INPUT, goal: 'x'.repeat(5000) }), 413, 'payload_too_large');
    await problem(
      await h.request('/services/sms/jobs', {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      }),
      404,
      'service_not_found',
    );
    const missing = await problem(await h.createJob({ to: INPUT.to }), 400, 'invalid_input');
    assert.deepEqual(missing.errors.map((e: { pointer: string }) => e.pointer), ['', '']);
    const format = await problem(await h.createJob({ ...INPUT, to: '0555 111 22 33' }), 400, 'invalid_input');
    assert.equal(format.errors[0].pointer, '/to');
    // Valid by pattern, but not a real number.
    const fake = await problem(await h.createJob({ ...INPUT, to: '+15550000000' }), 400, 'invalid_input');
    assert.deepEqual(fake.errors, [{ pointer: '/to', message: 'is not a valid phone number' }]);
    // A premium-rate number is never called.
    const premium = await problem(await h.createJob({ ...INPUT, to: '+19005551234' }), 400, 'invalid_input');
    assert.match(premium.errors[0].message, /premium/);
    assert.equal(h.fac.calls.verify, 0);
  } finally {
    await h.db.close();
  }
});

Deno.test('Twilio limits are checked before payment, and an outage does not block', async () => {
  const blocked = await harness({ directory: { countryEnabled: (iso) => Promise.resolve(iso !== 'TR') } });
  try {
    const response = await blocked.createJob({ ...INPUT, to: '+905321112233' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).errors[0].message, /TR numbers are not enabled/);
    assert.equal((await blocked.createJob()).status, 402);
  } finally {
    await blocked.db.close();
  }
  const trial = await harness({
    directory: {
      accountType: () => Promise.resolve('Trial'),
      verified: (n) => Promise.resolve(n === EXAMPLE_NUMBER),
    },
  });
  try {
    assert.equal((await trial.createJob()).status, 400, 'a trial account calls verified numbers only');
    assert.equal((await trial.createJob({ ...INPUT, to: EXAMPLE_NUMBER })).status, 402);
  } finally {
    await trial.db.close();
  }
  const down = await harness({
    directory: {
      accountType: () => Promise.resolve(undefined),
      countryEnabled: () => Promise.resolve(undefined),
    },
  });
  try {
    assert.equal((await down.createJob()).status, 402);
  } finally {
    await down.db.close();
  }
});

Deno.test('an unpaid request gets a challenge that matches the manifest [P3]–[P6]', async () => {
  const h = await harness();
  try {
    const response = await h.createJob();
    assert.equal(response.status, 402);
    assert.equal(response.headers.get('access-control-expose-headers')?.includes('PAYMENT-REQUIRED'), true);
    const challenge = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED')!);
    assert.deepEqual(checkChallenge(MANIFEST, 'phone-call', challenge), []);
    assert.equal(challenge.accepts[0].amount, '10000000');
    assert.equal(challenge.resource.url, `${BASE_URL}/services/phone-call/jobs`);
    assert.ok((challenge.extensions as Record<string, unknown>).bazaar);
    assert.deepEqual(await response.json(), challenge);
    assert.equal(h.fac.calls.verify, 0);
    // A burst of unpaid requests only ever gets 402, 429 or 503, never 500 [Q1].
    const burst = await Promise.all(Array.from({ length: 20 }, () => h.createJob()));
    assert.deepEqual([...new Set(burst.map((r) => r.status))], [402]);
    await Promise.all(burst.map((r) => r.body?.cancel()));
  } finally {
    await h.db.close();
  }
});

Deno.test('a paid call settles once, dials once and is recovered by id and token [J5] [J10]', async () => {
  const h = await harness();
  try {
    const response = await h.pay();
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('location'), `${BASE_URL}/jobs/${ID}`);
    assert.equal(response.headers.get('retry-after'), '5');
    const settledHeader = decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE')!);
    assert.equal(settledHeader.transaction, TX_HASH);
    const view = await response.json();
    assert.equal(view.status, 'running');
    assert.equal(view.charge, 'upfront');
    assert.equal(view.charged, true);
    assert.equal(view.payment.transaction, TX_HASH);
    assert.equal(view.payment.payer, PAYER.publicKey());
    assert.equal(view.payment.amount, '10000000');
    assert.equal(view.output, undefined);
    assert.equal(h.fac.calls.settle, 1);
    assert.equal(h.tw.placed.length, 1);
    const token = await signJob(CONFIG.phone.authToken, ID);
    assert.deepEqual(h.tw.placed[0], {
      to: INPUT.to,
      url: `${BASE_URL}/phone/twiml/${ID}?token=${token}`,
      statusCallback: `${BASE_URL}/webhooks/twilio/${ID}?token=${token}`,
    });

    // The same paid request again: the same job, nothing settled or dialed again [J5].
    const again = await h.pay();
    assert.equal(again.status, 202);
    assert.equal((await again.json()).jobId, ID);
    assert.equal(h.fac.calls.settle, 1);
    assert.equal(h.tw.placed.length, 1);
    // Another input under the same id [J6]; the same payment for another job [P9].
    assert.equal((await h.pay({ ...INPUT, goal: 'Something else entirely.' })).status, 422);
    const reused = await h.pay({ ...INPUT, to: '+14155550177' }, {
      'Idempotency-Key': ID.replace('d3a4', 'aaaa'),
      'Job-Token': TOKEN,
    });
    assert.equal(reused.status, 402);
    assert.equal((await reused.json()).error, 'payment_already_used');
    // One call to a number at a time, with Retry-After [Q1].
    const busy = await h.createJob(INPUT, {
      'Idempotency-Key': ID.replace('d3a4', 'bbbb'),
      'Job-Token': TOKEN,
    });
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get('retry-after'), '120');

    // Unknown job, wrong token: the same 404 [J10].
    const wrong = await h.status(ID, 'B'.repeat(43));
    const unknown = await h.status(ID.replace('d3a4', 'cccc'));
    assert.equal(wrong.status, 404);
    assert.deepEqual(await wrong.json(), await unknown.json());

    // Twilio fetches TwiML with the signed URL, and the voice bridge is told which job it serves.
    const twiml = await h.request(`/phone/twiml/${ID}?token=${token}`, { method: 'POST' });
    assert.match(
      await twiml.text(),
      /<Stream url="wss:\/\/ref\.supabase\.co\/functions\/v1\/stellar\/phone\/stream">/,
    );
    assert.equal((await h.request(`/phone/twiml/${ID}?token=forged`, { method: 'POST' })).status, 401);

    // The call is answered and ends; the bridge saved the transcript; Twilio reports completion.
    await h.calls.update(ID, {
      transcript: [
        { speaker: 'agent', text: "Hi, I'm an AI assistant calling for Sam." },
        { speaker: 'contact', text: 'We are open on Sunday.' },
      ],
      ended_at: new Date().toISOString(),
    });
    const callback = await h.request(`/webhooks/twilio/${ID}?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallStatus: 'completed',
        CallDuration: '37',
        CallSid: `CA${'1'.repeat(32)}`,
      }),
    });
    assert.equal(callback.status, 200);
    const done = await h.status();
    assert.equal(done.status, 200);
    const finished = await done.json();
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.output, undefined, 'check-status has no output');
    const result = await (await h.status(ID, TOKEN, true)).json();
    assert.deepEqual(result.output, {
      call: {
        status: 'completed',
        connected: true,
        duration_seconds: 37,
        summary: 'They are open on Sunday.',
        goal_achieved: true,
        transcript: [
          { speaker: 'agent', text: "Hi, I'm an AI assistant calling for Sam." },
          { speaker: 'contact', text: 'We are open on Sunday.' },
        ],
      },
    });
    assert.deepEqual(validate(PHONE_OUTPUT_SCHEMA, result.output), []);
    assert.equal(result.payment.transaction, TX_HASH);
    // A finished job is final: a late callback changes nothing.
    await h.request(`/webhooks/twilio/${ID}?token=${token}`, {
      method: 'POST',
      body: new URLSearchParams({ CallStatus: 'failed' }),
    });
    assert.equal((await (await h.status(ID, TOKEN, true)).json()).output.call.status, 'completed');
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('a job without ids gets generated ones, returned once [J2]', async () => {
  const h = await harness();
  try {
    const response = await h.pay(INPUT, {});
    assert.equal(response.status, 202);
    const view = await response.json();
    assert.match(view.jobId, /^[0-9a-f-]{36}$/);
    assert.match(view.jobToken, /^[A-Za-z0-9_-]{43}$/);
    const read = await (await h.status(view.jobId, view.jobToken)).json();
    assert.equal(read.status, 'running');
    assert.equal(read.jobToken, undefined);
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('an unanswered call is a finished call with connected false', async () => {
  const h = await harness();
  try {
    await h.pay();
    const token = await signJob(CONFIG.phone.authToken, ID);
    await h.request(`/webhooks/twilio/${ID}?token=${token}`, {
      method: 'POST',
      body: new URLSearchParams({ CallStatus: 'no-answer', CallDuration: '0' }),
    });
    const result = await (await h.status(ID, TOKEN, true)).json();
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.output.call, {
      status: 'no-answer',
      connected: false,
      duration_seconds: 0,
      summary: 'Nobody answered the call.',
      goal_achieved: false,
      transcript: [],
    });
    assert.equal(h.summaries.length, 0, 'nothing to summarize');
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('a call the phone network refuses fails the paid job', async () => {
  const h = await harness();
  try {
    h.tw.rejectNext(21215);
    const view = await (await h.pay()).json();
    assert.equal(view.status, 'failed');
    assert.equal(view.charged, true);
    assert.equal(view.error.code, 'service_failed');
    assert.equal(view.error.detail, 'The phone network refused the call (Twilio error 21215).');
    assert.equal(view.error.status, undefined);
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('a refused settlement fails the job uncharged', async () => {
  const h = await harness({
    settle: () =>
      Promise.resolve({
        success: false,
        transaction: '',
        network: 'stellar:pubnet',
        errorReason: 'invalid_exact_stellar_payload_insufficient_balance',
      }),
  });
  try {
    const view = await (await h.pay()).json();
    assert.equal(view.status, 'failed');
    assert.equal(view.charged, false);
    assert.equal(view.error.code, 'payment_failed');
    assert.equal(view.payment, undefined);
    assert.equal(h.tw.placed.length, 0);
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('an uncertain settlement is never charged again and is decided from the chain [J13]', async () => {
  const { transaction } = payment(REQUIREMENTS, { nonce: '424242' });
  // The facilitator times out; the chain shows the payment landed.
  const landed = await harness({
    settle: () => Promise.reject(new Error('timeout')),
    chain: chain({ latest: 1200, transaction }),
  });
  try {
    assert.equal((await landed.pay()).status, 202);
    await landed.settled();
    const after = await (await landed.status()).json();
    assert.equal(after.status, 'running', 'paid after all: the call is placed');
    assert.equal(after.payment.transaction, TX_HASH);
    assert.equal(landed.tw.placed.length, 1);
    assert.equal(landed.fac.calls.settle, 1, 'never settled twice');
  } finally {
    await landed.db.close();
  }
  // The payment expired at ledger 1000 and never landed: failed, uncharged.
  const lost = await harness({
    settle: () => Promise.reject(new Error('timeout')),
    chain: chain({ latest: 1200 }),
  });
  try {
    await lost.pay();
    await lost.settled();
    const view = await (await lost.status()).json();
    assert.equal(view.status, 'failed');
    assert.equal(view.charged, false);
    assert.equal(view.error.code, 'payment_failed');
    assert.equal(lost.tw.placed.length, 0);
  } finally {
    await lost.db.close();
  }
  // The payment can still land: it stays uncertain.
  const open = await harness({
    settle: () => Promise.reject(new Error('timeout')),
    chain: chain({ latest: 960 }),
  });
  try {
    const view = await (await open.pay()).json();
    assert.equal(view.status, 'payment_uncertain');
    assert.equal(view.charged, 'unknown');
    assert.equal(view.payment, undefined);
    await open.settled();
    const later = await open.status();
    assert.equal(later.status, 202);
    assert.equal((await later.json()).status, 'payment_uncertain');
    assert.equal(open.tw.placed.length, 0);
    assert.equal(open.fac.calls.settle, 1);
  } finally {
    await open.db.close();
  }
});

Deno.test('capacity is checked before the 402 and again on the paid request [Q1] [Q3]', async () => {
  const h = await harness({ concurrency: 1 });
  try {
    assert.equal((await h.pay()).status, 202);
    const other = { ...INPUT, to: '+14155550177' };
    const full = await h.createJob(other, {
      'Idempotency-Key': ID.replace('d3a4', 'dddd'),
      'Job-Token': TOKEN,
    });
    assert.equal(full.status, 503);
    assert.equal(full.headers.get('retry-after'), '30');
    assert.equal((await full.json()).code, 'unavailable');
    assert.equal(h.fac.calls.verify, 1);
    // check-status still works at capacity [Q7].
    assert.equal((await h.status()).status, 202);
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('payments that pay someone else, or too little, are refused before the facilitator', async () => {
  const h = await harness();
  try {
    for (const options of [{ amount: '1' }, { payTo: PAYER.publicKey() }]) {
      const bad = payment(
        { ...REQUIREMENTS, ...(options.amount ? { amount: options.amount } : {}) },
        options,
      );
      const response = await h.createJob(INPUT, {
        'Idempotency-Key': ID,
        'Job-Token': TOKEN,
        'PAYMENT-SIGNATURE': bad.header,
      });
      assert.equal(response.status, 402);
    }
    // Signed to expire far beyond maxTimeoutSeconds: refused, as reconciliation relies on it.
    const far = await harness({ chain: chain({ latest: 100 }) });
    try {
      const signed = payment(REQUIREMENTS, { expiration: 100_000 });
      const response = await far.createJob(INPUT, {
        'Idempotency-Key': ID,
        'Job-Token': TOKEN,
        'PAYMENT-SIGNATURE': signed.header,
      });
      assert.equal(response.status, 402);
      assert.equal(
        (await response.json()).error,
        'invalid_exact_stellar_payload_signature_expiration_too_far',
      );
    } finally {
      await far.db.close();
    }
    assert.equal(h.fac.calls.verify, 0);
  } finally {
    await h.db.close();
  }
});

Deno.test('opted-out numbers are refused; the sweep needs its secret', async () => {
  const h = await harness();
  try {
    await h.pay();
    assert.equal(await h.store.optOut(ID), true);
    const refused = await h.createJob(INPUT, {
      'Idempotency-Key': ID.replace('d3a4', 'eeee'),
      'Job-Token': TOKEN,
    });
    assert.equal(refused.status, 400);
    assert.deepEqual((await refused.json()).errors, [{
      pointer: '/to',
      message: 'asked not to be called again',
    }]);
    assert.equal((await h.request('/internal/sweep', { method: 'POST' })).status, 401);
    const sweep = await h.request('/internal/sweep', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.sweepSecret}` },
    });
    assert.equal(sweep.status, 200);
    assert.deepEqual(await sweep.json(), { uncertain: 0, deleted: 0, reconciled: 0, advanced: 0 });
    await h.settled();
  } finally {
    await h.db.close();
  }
});

Deno.test('a facilitator that cannot settle this network stops payments before the 402', async () => {
  const h = await harness();
  try {
    h.fac.supported = () =>
      Promise.resolve({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet' }] });
    const response = await h.createJob();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'unavailable');
  } finally {
    await h.db.close();
  }
});

Deno.test('a dial whose worker died mid-request still finishes from Twilio callbacks', async () => {
  const h = await harness();
  try {
    // Claimed and settled, the dial claimed, then the worker died before recording Twilio's answer.
    const claim = await h.store.claim({
      job_id: ID,
      service: 'phone-call',
      charge: 'upfront',
      binding_hash: 'a'.repeat(64),
      token_hash: 'b'.repeat(64),
      network: 'stellar:pubnet',
      payer: PAYER.publicKey(),
      nonce: '1',
      expiration_ledger: 1000,
      fingerprint: 'c'.repeat(64),
      destination_hash: 'd'.repeat(64),
      input: INPUT,
    }, { maxActive: 2, maxPerNumber: 3 });
    assert.equal(claim.outcome, 'created');
    await h.store.settlement(ID, {
      outcome: 'settled',
      receipt: {
        network: 'stellar:pubnet',
        asset: CONFIG.asset,
        amount: '10000000',
        payTo: CONFIG.payTo,
        payer: PAYER.publicKey(),
        transaction: TX_HASH,
        settledAt: new Date().toISOString(),
      },
    });
    await h.calls.create(ID);
    assert.equal((await h.store.startDial(ID)).job.dial_state, 'dialing');
    const token = await signJob(CONFIG.phone.authToken, ID);
    await h.request(`/webhooks/twilio/${ID}?token=${token}`, {
      method: 'POST',
      body: new URLSearchParams({ CallStatus: 'busy', CallDuration: '0' }),
    });
    const job = (await h.store.get(ID))!;
    assert.equal(job.status, 'succeeded');
    assert.equal((job.output as { call: { status: string } }).call.status, 'busy');
    assert.equal(h.tw.placed.length, 0, 'never dialed again');
  } finally {
    await h.db.close();
  }
});
