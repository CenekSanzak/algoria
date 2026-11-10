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
    const receipt = Receipt.deserialize(first.headers.get('Payment-Receipt')!);
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
