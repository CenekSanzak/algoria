import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { signedPermission } from './helpers/permission.mjs';

const home = await mkdtemp(join(tmpdir(), 'algoria-tempo-'));
process.env.ALGORIA_HOME = home;
const { API_BASE } = await import('../plugins/algoria/lib/services/api.mjs');
const { loadTempoSdk } = await import('../plugins/algoria/lib/services/tempo-sdk.mjs');
const sdk = await loadTempoSdk();
const signer = await import('../plugins/algoria/lib/services/tempo-signer.mjs');
const approval = await import('../plugins/algoria/lib/services/permission-approval.mjs');
const readiness = await import('../plugins/algoria/lib/services/tempo-readiness.mjs');
const { TempoFundingError } = await import('../plugins/algoria/lib/services/tempo-funding.mjs');
const { imageTask, tempoTask } = await import('../plugins/algoria/lib/services/task.mjs');
const { quoteTempo, validateMppQuote } = await import('../plugins/algoria/lib/services/tempo-client.mjs');
const { runJob, statusJob } = await import('../plugins/algoria/lib/services/client.mjs');
const { setBudget, getBudget, readJob, readLedger, ledgerPath, revokeBudget } = await import('../plugins/algoria/lib/services/state.mjs');
const fixture = JSON.parse(await readFile(new URL('../../platform/docs/skill-integration/image.generate.json', import.meta.url), 'utf8'));
const recipient = '0x1111111111111111111111111111111111111111';
const payer = '0x2222222222222222222222222222222222222222';
const transaction = `0x${'a'.repeat(64)}`;
/** @type {Map<string, any>} */ let remote;
/** @type {any} */ let contract;
let signatures = 0, paidPosts = 0, loseResponse = false, loseBroadcast = false;
/** @type {(c: any) => void} */ let mutate;

/** @param {any} job @returns {any} */
function result(job) {
  const payment = job.paid ? { success: true, protocol: 'mpp', network: 'eip155:42431',
    token: contract.mpp.token, decimals: 6, payer, transaction, amount: contract.mpp.amount,
    mpp: { method: 'tempo', status: 'success', reference: transaction, timestamp: '2026-10-05T00:00:00.000Z' } } : null;
  return { job_id: job.id, service_id: contract.id, service_version: contract.version,
    status: job.paid ? 'succeeded' : 'awaiting_payment', status_url: `${API_BASE}/v1/jobs/${job.id}`,
    payment, output: job.paid ? (contract.id === 'phone.call' ? { call: { contact: 'berkin', status: 'completed', duration_seconds: 25,
      summary: 'Confirmed the demo.', goal_achieved: true, transcript: [{ speaker: 'contact', text: 'I am ready.' }] } }
      : { images: [{ url: 'https://media.example/image.png', content_type: 'image/png' }], url_expires_in: 3600 }) : null,
    error: null };
}
beforeEach(async () => {
  await rm(ledgerPath(), { force: true });
  remote = new Map(); signatures = 0; paidPosts = 0; loseResponse = false; loseBroadcast = false; mutate = () => {};
  contract = structuredClone(fixture);
  vi.spyOn(readiness, 'tempoReadiness').mockReturnValue({ ready: true, reason: 'ready', nextAction: 'Review purchase', fundingRequired: true,
    protocol: 'mpp', network: 'eip155:42431', unit: 'test PathUSD', walletMode: 'disposable', realFundsSupported: false, permissionsEnabled: true, permissionEnforcement: 'local-only', delegatedSigningEnabled: false });
  contract.mpp = { protocol: 'mpp', chain: 'eip155:42431', token: '0x20c0000000000000000000000000000000000000',
    decimals: 6, recipient, amount: '10000' };
  // Real backend publishes a schema accepting both supported networks.
  contract.output_schema.properties.payment.anyOf[0].properties.network = { enum: ['stellar:testnet', 'eip155:42431'] };
  vi.spyOn(signer, 'signAndPayTempo').mockImplementation(async (job, _options, save) => {
    signatures++;
    const credential = sdk.Credential.serialize({ challenge: job.challenge,
      payload: { type: 'hash', hash: transaction }, source: `did:pkh:eip155:42431:${payer}` });
    await save({ credential, transaction, payer });
    if (loseBroadcast) throw new Error('lost RPC reply');
    return { credential, transaction, payer };
  });
  vi.stubGlobal('fetch', vi.fn(async (/** @type {any} */ url, /** @type {RequestInit} */ options = {}) => {
    expect(options.redirect).toBe('error');
    const headers = new Headers(options.headers);
    if (options.method !== 'POST' && String(url).includes('/v1/services/')) return Response.json(contract);
    if (String(url).includes('/v1/jobs/')) {
      const id = String(url).split('/').at(-1) ?? '';
      const job = remote.get(id);
      const body = result(job);
      return Response.json(body, { headers: job.paid ? { 'Payment-Receipt': sdk.Receipt.serialize(body.payment.mpp) } : {} });
    }
    const id = headers.get('Idempotency-Key') ?? '';
    expect(headers.get('X-Payment-Protocol')).toBe('mpp');
    let job = remote.get(id);
    if (!job) {
      const input = JSON.parse(String(options.body));
      const challenge = sdk.Challenge.from({ secretKey: 'offline-secret'.repeat(3), method: 'tempo', intent: 'charge',
        realm: new URL(API_BASE).host, expires: new Date(Date.now() + 600000).toISOString(),
        meta: { job_id: id, resource: contract.resource,
          input_hash: createHash('sha256').update(JSON.stringify({ service: contract.id, input })).digest('hex') },
        request: { amount: contract.mpp.amount, recipient, currency: contract.mpp.token,
          methodDetails: { chainId: 42431, supportedModes: ['push'] } } });
      job = { id, challenge, paid: false }; remote.set(id, job);
    }
    if (headers.has('Authorization')) {
      paidPosts++;
      expect(sdk.Credential.deserialize(headers.get('Authorization')).payload.hash).toBe(transaction);
      job.paid = true;
      if (loseResponse) throw new Error('lost paid response');
    }
    if (job.paid) {
      const body = result(job);
      return Response.json(body, { headers: { 'Payment-Receipt': sdk.Receipt.serialize(body.payment.mpp) } });
    }
    const challenge = structuredClone(job.challenge); mutate(challenge);
    return Response.json({ protocol: 'mpp', challenge, job_id: id, expires_at: challenge.expires },
      { status: 402, headers: { 'WWW-Authenticate': sdk.Challenge.serialize(challenge) } });
  }));
  vi.spyOn(approval, 'approvePermission').mockImplementation(async policy => signedPermission(policy));
  await setBudget('tempo', '0.10', '0.02', 'mpp', { agent: 'codex', recipient, expires: new Date(Date.now() + 3600000).toISOString() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

const callInput = { contact: 'berkin', goal: 'Confirm the demo', on_behalf_of: 'Dogukan', language: 'tr' };
async function phoneSetup() {
  contract.id = 'phone.call'; contract.version = '1'; contract.resource = `${API_BASE}/v1/services/phone.call`;
  contract.mpp.amount = '100000';
  contract.preparation = { contacts: ['berkin'] };
  contract.input_schema = { type: 'object', required: ['contact', 'goal'], properties: {
    contact: { type: 'string' }, goal: { type: 'string' }, on_behalf_of: { type: 'string' }, language: { enum: ['en', 'tr'] }
  }, additionalProperties: false };
  contract.output_schema.properties.service_id = { const: 'phone.call' };
  contract.output_schema.properties.service_version = { const: '1' };
  contract.output_schema.properties.output.anyOf[0] = { type: 'object', required: ['call'], additionalProperties: false,
    properties: { call: { type: 'object', required: ['contact', 'status', 'summary', 'goal_achieved', 'transcript'],
      properties: { contact: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' },
        goal_achieved: { type: 'boolean' }, duration_seconds: { type: 'integer', minimum: 0 },
        transcript: { type: 'array', items: { type: 'object', required: ['speaker', 'text'],
          properties: { speaker: { enum: ['agent', 'contact'] }, text: { type: 'string' } }, additionalProperties: false } } }, additionalProperties: false } } };
  await setBudget('calls', '0.20', '0.10', 'mpp', { agent: 'codex', service: 'phone.call', recipient,
    expires: new Date(Date.now() + 3600000).toISOString() });
}

describe('Tempo phone-call payments', () => {
  it('normalizes call details, approves 0.10 PathUSD once and delivers summary/transcript', async () => {
    await phoneSetup();
    const q = await tempoTask({ service: 'phone.call', input: { ...callInput, contact: ' Berkin ', goal: ' Confirm the demo ' }, budget: 'calls' });
    expect(q.amount).toBe('0.1000000'); expect(signatures).toBe(0);
    expect(JSON.parse((await readJob(q.id)).body)).toEqual(callInput);
    const done = await tempoTask({ id: q.id, approve: true, fundTestnet: true, wait: true });
    expect(done.status).toBe('succeeded'); expect(done.delivery).toMatchObject({ kind: 'call', previewRequired: false, call: { goalAchieved: true } });
    expect(done.delivery?.call?.transcript).toHaveLength(1);
    expect(done.journey.message).toContain('do not redial');
    expect(done.payment.explorerUrl).toBe(`https://explore.testnet.tempo.xyz/tx/${transaction}`);
    await tempoTask({ id: q.id, approve: true, fundTestnet: true });
    expect(signatures).toBe(1); expect(paidPosts).toBe(1); expect(remote.size).toBe(1);
    expect((await getBudget('calls')).spent).toBe('0.1000000');
  });
  it('blocks image permissions and per-call limits before the signer', async () => {
    await phoneSetup();
    const q = await quoteTempo('phone.call', callInput, 'tempo');
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('outside');
    const guided = await tempoTask({ id: q.id, approve: true, fundTestnet: true });
    expect(guided.nextAction).toBe('review-spending-permission');
    expect('paymentAttempted' in guided && guided.paymentAttempted).toBe(false);
    await setBudget('calls', '0.20', '0.09', 'mpp', { agent: 'codex', service: 'phone.call', recipient,
      expires: new Date(Date.now() + 3600000).toISOString() });
    const limited = await quoteTempo('phone.call', callInput, 'calls');
    await expect(runJob(limited.id, { approve: true })).rejects.toThrow('outside');
    expect(signatures).toBe(0); expect(paidPosts).toBe(0);
  });
  it('rejects changed goal, language, caller, service or contact without a replacement call', async () => {
    await phoneSetup();
    const q = await tempoTask({ service: 'phone.call', input: callInput, budget: 'calls' });
    for (const patch of [{ goal: 'Different' }, { language: 'en' }, { on_behalf_of: 'Someone else' }, { contact: 'alice' }]) {
      await expect(tempoTask({ id: q.id, input: { ...callInput, ...patch } })).rejects.toThrow('changed');
    }
    await expect(tempoTask({ id: q.id, service: 'image.generate' })).rejects.toThrow('service changed');
    await expect(quoteTempo('phone.call', { ...callInput, contact: '+15550000000' }, 'calls')).rejects.toThrow('Invalid phone');
    await expect(quoteTempo('phone.call', { ...callInput, contact: 'alice' }, 'calls')).rejects.toThrow('approved');
    expect(signatures).toBe(0); expect(remote.size).toBe(1);
  });
  it('releases a cancelled call reservation, then recovers a lost paid response without resigning', async () => {
    await phoneSetup();
    const q = await quoteTempo('phone.call', callInput, 'calls');
    vi.mocked(signer.signAndPayTempo).mockRejectedValueOnce(new Error('cancelled'));
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('cancelled');
    expect((await getBudget('calls')).reserved).toBe('0.0000000');
    expect(paidPosts).toBe(0);
    loseResponse = true;
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('unconfirmed');
    await revokeBudget('calls');
    const done = await runJob(q.id);
    expect(done.status).toBe('succeeded'); expect(signatures).toBe(1); expect(paidPosts).toBe(1);
  });
  it('rejects quote price tampering and recovers an interrupted broadcast using only its saved credential', async () => {
    await phoneSetup(); mutate = c => { c.request.amount = '10000'; };
    await expect(quoteTempo('phone.call', callInput, 'calls')).rejects.toThrow('price or destination');
    expect(signatures).toBe(0);
    mutate = () => {}; const q = await quoteTempo('phone.call', callInput, 'calls');
    loseBroadcast = true;
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('uncertain');
    expect((await getBudget('calls')).reserved).toBe('0.1000000');
    const done = await runJob(q.id);
    expect(done.status).toBe('succeeded'); expect(signatures).toBe(1); expect(paidPosts).toBe(1);
  });
});

describe('Tempo plugin payments', () => {
  it('blocks new purchases after revoke but recovers a saved payment without signing again', async () => {
    const q = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' });
    loseBroadcast = true;
    await imageTask({ id: q.id, approve: true, fundTestnet: true });
    expect(signatures).toBe(1);
    await revokeBudget('tempo');
    const recovered = await runJob(q.id, { approve: true });
    expect(recovered.status).toBe('succeeded');
    expect(signatures).toBe(1);
    const next = await imageTask({ input: { prompt: 'Dog' }, budget: 'tempo', approve: true, fundTestnet: true });
    expect('paymentAttempted' in next && next.paymentAttempted).toBe(false); expect(next.nextAction).toBe('review-spending-permission'); expect(signatures).toBe(1);
  });
  it('serializes burst ledger updates across separate tasks without losing reservations', async () => {
    const tasks = await Promise.all([
      imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' }),
      imageTask({ input: { prompt: 'Dog' }, budget: 'tempo' })
    ]);
    const results = await Promise.all(tasks.map(q => imageTask({ id: q.id, approve: true, fundTestnet: true })));
    expect(results.every(r => r.status === 'succeeded')).toBe(true);
    expect((await getBudget('tempo')).spent).toBe('0.0200000');
    expect(remote.size).toBe(2);
  });
  it('coordinates quote, approval and reopen around one saved task', async () => {
    const q = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' });
    expect(q.journey.stage).toBe('awaiting-approval'); expect(signatures).toBe(0);
    const done = await imageTask({ id: q.id, approve: true, fundTestnet: true });
    expect(done.journey.stage).toBe('ready'); expect(done.delivery?.previewRequired).toBe(true);
    const reopen = await imageTask({ id: q.id });
    expect(reopen.payment.transaction).toBe(transaction);
    expect(reopen.transactionUrl).toBe(`https://explore.testnet.tempo.xyz/tx/${transaction}`);
    expect(remote.size).toBe(1); expect(signatures).toBe(1); expect(paidPosts).toBe(1);
  });
  it('automatically enables testnet funding for an approved task and still blocks missing setup', async () => {
    const q = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo', approve: true });
    expect(q.status).toBe('succeeded'); expect(signatures).toBe(1);
    vi.spyOn(readiness, 'tempoReadiness').mockReturnValue({ ready: false, reason: 'companion-missing', nextAction: 'Build companion',
      protocol: 'mpp', network: 'eip155:42431', unit: 'test PathUSD', walletMode: 'disposable', realFundsSupported: false, permissionsEnabled: true, permissionEnforcement: 'local-only', delegatedSigningEnabled: false });
    const blocked = await imageTask({ input: { prompt: 'Dog' }, budget: 'tempo', approve: true });
    expect(blocked.nextAction).toBe('Build companion');
    expect(signatures).toBe(1); expect(remote.size).toBe(2);
  });
  it('releases an unfunded reservation and returns an actionable same-task retry, not a stale address', async () => {
    const q = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' });
    vi.mocked(signer.signAndPayTempo).mockRejectedValueOnce(new TempoFundingError('funding-cancelled'));
    const stopped = await imageTask({ id: q.id, approve: true });
    expect(stopped.nextAction).toBe('retry-wallet-funding'); expect(stopped.interrupted).toBe(true);
    expect('paymentAttempted' in stopped && stopped.paymentAttempted).toBe(false);
    expect(stopped.fundingIssue).toBe('funding-cancelled');
    expect((await getBudget('tempo')).reserved).toBe('0.0000000'); expect(signatures).toBe(0); expect(paidPosts).toBe(0);
    const done = await imageTask({ id: q.id, approve: true });
    expect(done.status).toBe('succeeded'); expect(done.fundingIssue).toBeUndefined(); expect(signatures).toBe(1); expect(remote.size).toBe(1);
  });
  it('returns a recoverable task card on a lost paid response', async () => {
    const q = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' });
    loseResponse = true;
    const failed = await imageTask({ id: q.id, approve: true, fundTestnet: true });
    expect(failed.interrupted).toBe(true); expect(failed.journey.stage).toBe('needs-attention');
    expect((await imageTask({ id: q.id })).status).toBe('succeeded');
    expect(signatures).toBe(1);
    expect(JSON.stringify(failed)).not.toContain((await readJob(q.id)).token);
    expect(JSON.stringify(failed)).not.toContain((await readJob(q.id)).credential);
  });
  it('does not treat saved input edits or failed validation as a new task', async () => {
    const q = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' });
    await expect(imageTask({ id: q.id, input: { prompt: 'Dog' }, approve: true })).rejects.toThrow('changed');
    await expect(imageTask({ id: q.id, input: { prompt: 'Cat', hidden: 'extra' } })).rejects.toThrow('one prompt');
    await expect(imageTask({ input: { prompt: 'Cat' }, budget: 'missing' })).rejects.toThrow('unknown budget');
    expect(signatures).toBe(0);
  });
  it('preserves the task identity when the initial quote response is lost', async () => {
    const original = globalThis.fetch;
    let lost = false;
    vi.stubGlobal('fetch', async (/** @type {Parameters<typeof fetch>[0]} */ url, /** @type {RequestInit} */ options) => {
      const response = await original(url, options);
      if (options?.method === 'POST' && !lost) { lost = true; throw new Error('lost initial response'); }
      return response;
    });
    const task = await imageTask({ input: { prompt: 'Cat' }, budget: 'tempo' });
    expect(task.interrupted).toBe(true); expect(task.phase).toBe('prepared');
    const recovered = await imageTask({ id: task.id });
    expect(recovered.phase).toBe('quoted'); expect(remote.size).toBe(1); expect(signatures).toBe(0);
  });
  it('quotes, reserves six-decimal token spend, pays once and returns an image', async () => {
    const q = await quoteTempo('image.generate', { prompt: '  An orange cat  ' }, 'tempo');
    expect(q.unit).toBe('test PathUSD'); expect(q.amount).toBe('0.0100000');
    const result = await runJob(q.id, { approve: true, fundTestnet: true });
    expect(result.status).toBe('succeeded'); expect(result.output.images).toHaveLength(1);
    await runJob(q.id, { approve: true }); await statusJob(q.id);
    expect(signatures).toBe(1); expect(paidPosts).toBe(1);
    expect((await getBudget('tempo')).spent).toBe('0.0100000');
    expect(JSON.stringify(result)).not.toContain((await readJob(q.id)).token);
    expect(JSON.stringify(result)).not.toContain((await readJob(q.id)).credential);
  });
  it('recovers a lost paid HTTP response with status without another signature', async () => {
    const q = await quoteTempo('image.generate', { prompt: 'Cat' }, 'tempo');
    loseResponse = true;
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('payment unconfirmed');
    const result = await statusJob(q.id);
    expect(result.status).toBe('succeeded'); expect(signatures).toBe(1); expect(paidPosts).toBe(1);
  });
  it('saves transaction before broadcast and resends only its hash credential after RPC interruption', async () => {
    const q = await quoteTempo('image.generate', { prompt: 'Cat' }, 'tempo');
    loseBroadcast = true;
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('submission uncertain');
    expect((await readJob(q.id)).transaction).toBe(transaction);
    expect((await getBudget('tempo')).reserved).toBe('0.0100000');
    expect((await statusJob(q.id)).requiresAttention).toBe(true);
    const result = await runJob(q.id);
    expect(result.status).toBe('succeeded'); expect(signatures).toBe(1);
  });
  it('rejects changed prices before calling the native signer', async () => {
    mutate = c => { c.request.amount = '20000'; };
    await expect(quoteTempo('image.generate', { prompt: 'Cat' }, 'tempo')).rejects.toThrow('price or destination');
    expect(signatures).toBe(0);
  });
  it('requires approval, keeps legacy budgets Stellar, and rejects cross-protocol reuse', async () => {
    const q = await quoteTempo('image.generate', { prompt: 'Cat' }, 'tempo');
    await expect(runJob(q.id)).rejects.toThrow('--approve');
    await setBudget('stellar', '1', '0.1');
    expect((await getBudget('stellar')).unit).toBe('test USDC');
    await expect(setBudget('stellar', '1', '0.1', 'mpp')).rejects.toThrow('separate budget');
    await expect(quoteTempo('image.generate', { prompt: 'Cat' }, 'stellar')).rejects.toThrow('separate');
    await expect(quoteTempo('image.generate', { prompt: 'Different' }, 'tempo', q.id)).rejects.toThrow('identity conflict');
  });
  it('releases reservation after cancellation before broadcast', async () => {
    vi.spyOn(signer, 'signAndPayTempo').mockRejectedValue(new Error('cancelled'));
    const q = await quoteTempo('image.generate', { prompt: 'Cat' }, 'tempo');
    await expect(runJob(q.id, { approve: true })).rejects.toThrow('cancelled or unavailable');
    expect((await getBudget('tempo')).reserved).toBe('0.0000000');
    expect((await readJob(q.id)).transaction).toBeUndefined();
  });
  it('rejects header/body and task substitutions even when price matches', async () => {
    const q = await quoteTempo('image.generate', { prompt: 'Cat' }, 'tempo');
    const job = await readJob(q.id);
    const challenge = structuredClone(job.challenge);
    challenge.meta.job_id = randomUUID();
    await expect(validateMppQuote(job, new Response(null, { status: 402,
      headers: { 'WWW-Authenticate': sdk.Challenge.serialize(challenge) } }),
      { protocol: 'mpp', job_id: job.id, challenge, expires_at: challenge.expires })).rejects.toThrow('mismatch');
    expect((await readLedger()).version).toBe(1);
  });
});
