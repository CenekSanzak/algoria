import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import { MppGateway, TEMPO_TOKEN } from './mpp.ts';
import { Challenge, Credential, Receipt } from 'npm:mppx@0.13.1';
import { createClient, custom, encodeAbiParameters, encodeEventTopics } from 'npm:viem@2.57.3';
import { tempoModerato } from 'npm:viem@2.57.3/chains';
import { Abis } from 'npm:viem@2.57.3/tempo';
import { Attribution as BundledAttribution } from '../../../../agent-skills/plugins/algoria/lib/vendor/tempo-sdk.mjs';
import { createApp } from './app.ts';
import type { harness as testHarness } from './app_test.ts';
import { hash } from './security.ts';
import type { Job } from './store.ts';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';
import { type CallRow, PhoneCalls } from './phone.ts';
import { normalizeInput, PHONE_SERVICE } from './catalog.ts';
import { normalizeTempoInput } from '../../../../agent-skills/plugins/algoria/lib/services/tempo-services.mjs';
import { readConfig, tempoServicePayment } from './config.ts';

const recipient = '0x1111111111111111111111111111111111111111';
const payer = '0x2222222222222222222222222222222222222222';
const tx = `0x${'a'.repeat(64)}` as const;
const block = `0x${'b'.repeat(64)}` as const;
const config = { recipient, amount: '10000', secret: 'offline-test-secret'.repeat(3) };
const input = { prompt: 'An orange cat resting on a windowsill' };
const token = 'a'.repeat(43);
const Attribution = BundledAttribution as {
  encode: (params: { challengeId: string; serverId: string }) => `0x${string}`;
};

function paymentFixture() {
  let receipt: Record<string, unknown> | null = null;
  const calls: string[] = [];
  const client = createClient({
    chain: tempoModerato,
    transport: custom({
      request({ method }) {
        calls.push(method);
        if (method === 'eth_getTransactionReceipt') return Promise.resolve(receipt);
        throw new Error(`Unexpected RPC ${method}`);
      },
    }, { retryCount: 0 }),
  });
  const gateway = new MppGateway(config, client);
  function settled(
    challenge: Challenge.Challenge,
    patch: {
      amount?: bigint;
      memo?: `0x${string}`;
      to?: `0x${string}`;
      from?: `0x${string}`;
      token?: string;
      status?: string;
    } = {},
  ) {
    const memo = patch.memo ?? Attribution.encode({ challengeId: challenge.id, serverId: challenge.realm });
    receipt = {
      transactionHash: tx,
      blockHash: block,
      blockNumber: '0x10',
      transactionIndex: '0x0',
      from: payer,
      to: TEMPO_TOKEN,
      contractAddress: null,
      status: patch.status ?? '0x1',
      gasUsed: '0x10000',
      cumulativeGasUsed: '0x10000',
      effectiveGasPrice: '0x1',
      type: '0x76',
      logsBloom: `0x${'0'.repeat(512)}`,
      logs: [{
        address: patch.token ?? TEMPO_TOKEN,
        blockHash: block,
        blockNumber: '0x10',
        transactionHash: tx,
        transactionIndex: '0x0',
        logIndex: '0x0',
        removed: false,
        topics: encodeEventTopics({
          abi: Abis.tip20,
          eventName: 'TransferWithMemo',
          args: { from: patch.from ?? payer, to: patch.to ?? recipient, memo },
        }),
        data: encodeAbiParameters([{ type: 'uint256' }], [patch.amount ?? 10000n]),
      }],
    };
  }
  return {
    gateway,
    calls,
    settled,
    missing: () => {
      receipt = null;
    },
  };
}

function authorize(challenge: Challenge.Challenge, hash = tx) {
  return Credential.serialize({
    challenge,
    payload: { type: 'hash', hash },
    source: `did:pkh:eip155:42431:${payer}`,
  });
}

async function jobFixture(gateway: MppGateway): Promise<Job> {
  const id = crypto.randomUUID();
  const resource = 'https://api.example.test/functions/v1/api/v1/services/image.generate';
  const inputHash = await hash(JSON.stringify({ service: 'image.generate', input }));
  const expires = new Date(Date.now() + 600000).toISOString();
  return {
    id,
    requirements: gateway.quote(id, inputHash, resource, expires),
    resource_url: resource,
    expires_at: expires,
  } as unknown as Job;
}

export function registerMppTests(harness: typeof testHarness) {
  Deno.test('Tempo phone environment defaults and overrides stay separate from Stellar and image amounts', () => {
    const h = harness();
    const names = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'FAL_KEY',
      'IMAGE_GENERATE_PAY_TO',
      'TEMPO_IMAGE_RECIPIENT',
      'TEMPO_IMAGE_PRICE_ATOMIC',
      'MPP_SECRET_KEY',
      'TEMPO_PHONE_RECIPIENT',
      'TEMPO_PHONE_PRICE_ATOMIC',
    ];
    const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
    try {
      for (const name of names) Deno.env.delete(name);
      Deno.env.set('SUPABASE_URL', h.dependencies.config.supabaseUrl);
      Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'offline');
      Deno.env.set('FAL_KEY', 'offline');
      Deno.env.set('IMAGE_GENERATE_PAY_TO', h.dependencies.config.imagePayTo);
      equal(tempoServicePayment(readConfig(), 'phone.call'), undefined);
      Deno.env.set('TEMPO_IMAGE_RECIPIENT', recipient);
      Deno.env.set('MPP_SECRET_KEY', config.secret);
      deepEqual(tempoServicePayment(readConfig(), 'image.generate'), { recipient, amount: '10000' });
      deepEqual(tempoServicePayment(readConfig(), 'phone.call'), { recipient, amount: '100000' });
      Deno.env.set('TEMPO_PHONE_RECIPIENT', payer);
      Deno.env.set('TEMPO_PHONE_PRICE_ATOMIC', '120000');
      deepEqual(tempoServicePayment(readConfig(), 'phone.call'), { recipient: payer, amount: '120000' });
      deepEqual(tempoServicePayment(readConfig(), 'image.generate'), { recipient, amount: '10000' });
      equal(tempoServicePayment(readConfig(), 'speech.generate'), undefined);
      const invalid = {
        ...h.dependencies.config,
        mpp: { ...config, phone: { recipient: 'bad', amount: '100000' } },
        servicePayments: {
          'phone.call': { payTo: h.dependencies.config.imagePayTo, priceAtomic: '1000000' },
        },
      };
      throws(() => createApp({ ...h.dependencies, config: invalid }), /Invalid Tempo/);
      invalid.mpp.phone = { recipient, amount: '0' };
      throws(() => createApp({ ...h.dependencies, config: invalid }), /Invalid Tempo/);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  });
  Deno.test('phone input hashes use the same normalization in backend, plugin and native builder', () => {
    for (
      const value of [
        { contact: ' Berkin ', goal: ' Confirm the demo ' },
        { language: 'tr', on_behalf_of: ' Dogukan ', goal: 'İstanbul 🚀', contact: 'BERKIN' },
      ]
    ) {
      equal(
        JSON.stringify(normalizeInput(PHONE_SERVICE, value)),
        JSON.stringify(normalizeTempoInput('phone.call', value)),
      );
    }
    for (
      const value of [null, [], {}, { contact: '+15550000000', goal: 'Call' }, {
        contact: 'berkin',
        goal: 'Call',
        language: 'de',
      }, { contact: 'berkin', goal: 'Call', hidden: true }]
    ) {
      throws(() => normalizeInput(PHONE_SERVICE, value));
      throws(() => normalizeTempoInput('phone.call', value));
    }
  });
  function phoneHarness(uncertainDial = false) {
    const h = harness();
    const f = paymentFixture();
    h.dependencies.config.mpp = { ...config, phone: { recipient: payer, amount: '100000' } };
    h.dependencies.config.servicePayments!['phone.call'] = {
      payTo: h.dependencies.config.imagePayTo,
      priceAtomic: '1000000',
    };
    const phoneConfig = {
      accountSid: 'offline',
      authToken: 'offline-secret',
      from: '+15550000000',
      openaiKey: 'offline',
      realtimeModel: 'offline',
      voice: 'marin',
      contacts: { berkin: '+15550000001' },
    };
    h.dependencies.config.phone = phoneConfig;
    const rows = new Map<string, CallRow>();
    let dials = 0;
    const phone = new PhoneCalls({
      config: phoneConfig,
      store: h.store,
      baseUrl: h.dependencies.config.baseUrl,
      calls: {
        note: () => Promise.resolve(),
        get: (id) => Promise.resolve(rows.get(id) ?? null),
        create: (id) => {
          if (!rows.has(id)) {
            rows.set(id, {
              job_id: id,
              call_sid: null,
              call_status: 'new',
              duration_seconds: null,
              transcript: [],
              ended_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
          }
          return Promise.resolve();
        },
        update: (id, patch) => {
          Object.assign(rows.get(id)!, patch);
          return Promise.resolve();
        },
      },
      twilio: {
        placeCall: () => {
          dials++;
          return uncertainDial
            ? Promise.reject(new Error('lost Twilio reply'))
            : Promise.resolve('CA-offline');
        },
        hangup: () => Promise.resolve(),
      },
      summarize: () => Promise.resolve({ summary: 'Ready for the demo.', goal_achieved: true }),
    });
    h.dependencies.phone = phone;
    h.dependencies.mpp = f.gateway;
    const app = createApp(h.dependencies);
    const callInput = {
      contact: 'berkin',
      goal: 'Confirm the demo',
      on_behalf_of: 'Dogukan',
      language: 'tr',
    };
    function post(id: string, credential?: string, body = callInput, recovery = token) {
      return app.request('/v1/services/phone.call?mode=async', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Payment-Protocol': 'mpp',
          'Idempotency-Key': id,
          'X-Recovery-Token': recovery,
          ...(credential ? { Authorization: credential } : {}),
        },
        body: JSON.stringify(body),
      });
    }
    return { ...h, f, app, post, rows, callInput, dials: () => dials };
  }

  Deno.test('MPP phone metadata uses its own six-decimal price and receiver and preserves Stellar support', async () => {
    const h = phoneHarness();
    const doc =
      await (await h.app.request('/v1/services/phone.call', { headers: { 'X-Payment-Protocol': 'mpp' } }))
        .json();
    equal(doc.mpp.amount, '100000');
    equal(doc.mpp.recipient, payer);
    equal(doc.protocol, 'mpp');
    deepEqual(doc.preparation.contacts, ['berkin']);
    equal(h.calls.requirements, 0);
    const stellar = await (await h.app.request('/v1/services/phone.call')).json();
    equal(stellar.accepts[0].network, 'stellar:testnet');
    equal(stellar.accepts[0].amount, '1000000');
    const openapi = await (await h.app.request('/openapi.json')).json();
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    equal(
      ajv.compile(
        openapi.paths['/v1/services/phone.call'].get.responses['200'].content['application/json'].schema,
      )(doc),
      true,
    );
    h.dependencies.config.mpp = config;
    const fallback = createApp(h.dependencies);
    const inherited =
      await (await fallback.request('/v1/services/phone.call', { headers: { 'X-Payment-Protocol': 'mpp' } }))
        .json();
    equal(inherited.mpp.recipient, recipient);
    equal(inherited.mpp.amount, '100000');
    equal(h.dials(), 0);
  });

  Deno.test('MPP phone payment dials once under duplicate POSTs and recovers summary with the original receipt', async () => {
    const h = phoneHarness();
    const id = crypto.randomUUID();
    const quoted = await h.post(id);
    equal(quoted.status, 402);
    equal(h.dials(), 0);
    const c = Challenge.deserialize(quoted.headers.get('WWW-Authenticate')!);
    equal(c.request.amount, '100000');
    equal(c.request.recipient, payer);
    h.f.settled(c, { amount: 100000n, to: payer });
    const credential = authorize(c);
    const responses = await Promise.all([h.post(id, credential), h.post(id, credential)]);
    equal(h.dials(), 1);
    equal(h.calls.submit, 0);
    equal(h.calls.settle, 0);
    for (const response of responses) equal(response.status, 202);
    const paidResponse = responses.find((response) => response.headers.has('Payment-Receipt'))!;
    equal(Receipt.deserialize(paidResponse.headers.get('Payment-Receipt')!).reference, tx);
    equal((await h.post(id, credential, { ...h.callInput, goal: 'Changed' })).status, 409);
    equal((await h.post(id, credential, h.callInput, 'b'.repeat(43))).status, 404);
    Object.assign(h.rows.get(id)!, {
      call_status: 'completed',
      duration_seconds: 25,
      ended_at: new Date().toISOString(),
      transcript: [{ speaker: 'contact', text: 'Hazırım.' }],
    });
    const done = await h.app.request(`/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await done.json();
    equal(body.status, 'succeeded');
    equal(body.output.call.goal_achieved, true);
    equal(body.output.call.transcript[0].text, 'Hazırım.');
    equal(body.payment.amount, '100000');
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const doc = await (await h.app.request('/v1/services/phone.call')).json();
    equal(ajv.compile(doc.output_schema)(body), true);
    equal((await h.post(id, credential)).status, 200);
    equal(h.dials(), 1);
    equal(h.store.fingerprints.size, 1);
  });

  Deno.test('MPP phone rejects underpayment, unapproved contact and credentials from another job before dialing', async () => {
    const h = phoneHarness();
    const id = crypto.randomUUID();
    equal((await h.post(crypto.randomUUID(), undefined, { ...h.callInput, contact: 'alice' })).status, 400);
    equal((await h.post(crypto.randomUUID(), undefined, { ...h.callInput, language: 'de' })).status, 400);
    const c = Challenge.deserialize((await h.post(id)).headers.get('WWW-Authenticate')!);
    h.f.settled(c, { amount: 10000n, to: payer });
    equal((await h.post(id, authorize(c))).status, 503);
    equal(h.dials(), 0);
    const other = crypto.randomUUID();
    await h.post(other);
    equal((await h.post(other, authorize(c))).status, 400);
    equal(h.dials(), 0);
    h.f.settled(c, { amount: 100000n, to: payer });
    equal((await h.post(id, authorize(c))).status, 202);
    equal(h.dials(), 1);
  });

  Deno.test('MPP phone ambiguous dialing remains recoverable without another call or payment', async () => {
    const h = phoneHarness(true);
    const id = crypto.randomUUID();
    const c = Challenge.deserialize((await h.post(id)).headers.get('WWW-Authenticate')!);
    h.f.settled(c, { amount: 100000n, to: payer });
    equal((await h.post(id, authorize(c))).status, 202);
    equal((await h.post(id, authorize(c))).status, 202);
    equal(h.dials(), 1);
    const row = h.store.jobs.get(id)!;
    row.updated_at = new Date(Date.now() - 60000).toISOString();
    const response = await h.app.request(`/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    equal(body.status, 'submission-uncertain');
    equal(body.payment.transaction, tx);
    equal(h.dials(), 1);
    equal(h.store.fingerprints.size, 1);
  });

  Deno.test('MPP phone never dials a second job reusing a claimed transaction hash', async () => {
    const h = phoneHarness();
    const first = crypto.randomUUID();
    const c1 = Challenge.deserialize((await h.post(first)).headers.get('WWW-Authenticate')!);
    h.f.settled(c1, { amount: 100000n, to: payer });
    equal((await h.post(first, authorize(c1))).status, 202);
    const second = crypto.randomUUID();
    const c2 = Challenge.deserialize((await h.post(second)).headers.get('WWW-Authenticate')!);
    // Even an RPC returning a second matching log for the same hash must not
    // bypass the durable transaction claim. Real memo substitution also fails.
    h.f.settled(c2, { amount: 100000n, to: payer });
    equal((await h.post(second, authorize(c2))).status, 409);
    equal(h.dials(), 1);
    equal(h.store.fingerprints.size, 1);
  });

  Deno.test('MPP SDK verifies the exact settled token transfer with challenge-bound memo', async () => {
    const f = paymentFixture();
    const job = await jobFixture(f.gateway);
    const c = job.requirements.challenge as Challenge.Challenge;
    f.settled(c);
    const result = await f.gateway.verify(f.gateway.parse(authorize(c), job));
    equal(result.payer.toLowerCase(), payer);
    equal(result.fingerprint, `mpp:eip155:42431:${tx}`);
    equal(result.receipt.amount, '10000');
    deepEqual(f.calls, ['eth_getTransactionReceipt']);
  });

  for (
    const [name, patch] of Object.entries({
      amount: { amount: 9999n },
      recipient: { to: payer },
      payer: { from: recipient },
      token: { token: recipient },
      reverted: { status: '0x0' },
      memo: { memo: `0x${'0'.repeat(64)}` },
    })
  ) {
    Deno.test(`MPP rejects a receipt with wrong ${name}`, async () => {
      const f = paymentFixture();
      const job = await jobFixture(f.gateway);
      const c = job.requirements.challenge as Challenge.Challenge;
      f.settled(c, patch as Parameters<typeof f.settled>[1]);
      await rejects(() => f.gateway.verify(f.gateway.parse(authorize(c), job)));
    });
  }

  Deno.test('MPP rejects substituted challenge, cross-job reuse, pull credentials and missing settlement', async () => {
    const f = paymentFixture();
    const job = await jobFixture(f.gateway);
    const c = job.requirements.challenge as Challenge.Challenge;
    const changed = structuredClone(c);
    changed.request.amount = '1';
    throws(() => f.gateway.parse(authorize(changed), job));
    throws(() =>
      f.gateway.parse(authorize(c), {
        ...job,
        requirements: f.gateway.quote(crypto.randomUUID(), 'different', job.resource_url, job.expires_at),
      })
    );
    throws(() =>
      f.gateway.parse(
        Credential.serialize({ challenge: c, payload: { type: 'transaction', signature: '0x00' } }),
        job,
      )
    );
    await rejects(() => f.gateway.verify(f.gateway.parse(authorize(c), job)));
  });

  Deno.test('MPP image endpoint settles once, generates once, and refreshes delivery without repayment', async () => {
    const h = harness();
    const f = paymentFixture();
    h.dependencies.config.mpp = config;
    h.dependencies.mpp = f.gateway;
    const app = createApp(h.dependencies);
    const metadata = await app.request('/v1/services/image.generate', {
      headers: { 'X-Payment-Protocol': 'mpp' },
    });
    const doc = await metadata.json();
    equal(doc.mpp.amount, '10000');
    equal(h.calls.requirements, 0);
    const openapi = await (await app.request('/openapi.json')).json();
    const ajv = new Ajv2020({ strict: false });
    ajv.addFormat('uri', (value: string) => URL.canParse(value));
    ajv.addFormat('uuid', /^[0-9a-f-]{36}$/i);
    ajv.addFormat('date-time', (value: string) => Number.isFinite(Date.parse(value)));
    equal(
      ajv.compile(
        openapi.paths['/v1/services/image.generate'].get.responses['200'].content['application/json'].schema,
      )(doc),
      true,
    );
    const id = crypto.randomUUID();
    const post = (credential?: string, body = input, protocol = 'mpp') =>
      app.request(
        '/v1/services/image.generate?mode=async',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Payment-Protocol': protocol,
            'Idempotency-Key': id,
            'X-Recovery-Token': token,
            ...(credential ? { Authorization: credential } : {}),
          },
          body: JSON.stringify(body),
        },
      );
    const quote = await post();
    equal(quote.status, 402);
    const c = Challenge.deserialize(quote.headers.get('WWW-Authenticate')!);
    f.settled(c);
    const credential = authorize(c);
    const [first, duplicate] = await Promise.all([post(credential), post(credential)]);
    equal(first.status, 202);
    equal(duplicate.status, 202);
    equal(h.calls.submit, 1);
    equal(h.calls.settle, 0);
    // Either racing POST can observe the other writer's settling snapshot.
    // The completed payment response carries the receipt; the loser recovers.
    const paidResponse = [first, duplicate].find((response) => response.headers.has('Payment-Receipt'))!;
    const receipt = Receipt.deserialize(paidResponse.headers.get('Payment-Receipt')!);
    equal(receipt.reference, tx);
    equal((await post(credential, { prompt: 'Substituted prompt' })).status, 409);
    equal((await post(undefined, input, 'x402')).status, 409);
    const done = await app.request(`/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const output = await done.json();
    equal(output.status, 'succeeded');
    equal(output.output.images.length, 1);
    equal((await post(credential)).status, 200);
    equal(h.calls.submit, 1);
    equal(h.store.fingerprints.size, 1);
  });

  Deno.test('MPP delayed settlement keeps generation unpaid and permits the same hash to be verified later', async () => {
    const h = harness();
    const f = paymentFixture();
    h.dependencies.config.mpp = config;
    h.dependencies.mpp = f.gateway;
    const app = createApp(h.dependencies);
    const id = crypto.randomUUID();
    const post = (credential?: string) =>
      app.request('/v1/services/image.generate?mode=async', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Payment-Protocol': 'mpp',
          'Idempotency-Key': id,
          'X-Recovery-Token': token,
          ...(credential ? { Authorization: credential } : {}),
        },
        body: JSON.stringify(input),
      });
    const c = Challenge.deserialize((await post()).headers.get('WWW-Authenticate')!);
    const credential = authorize(c);
    equal((await post(credential)).status, 503);
    equal(h.calls.submit, 0);
    f.settled(c);
    equal((await post(credential)).status, 202);
    equal(h.calls.submit, 1);
  });
}
