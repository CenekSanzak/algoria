import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'algoria-services-'));
process.env.ALGORIA_HOME = home;
const { API_BASE } = await import('../plugins/algoria/lib/services/api.mjs');
const sdkModule = await import('../plugins/algoria/lib/services/sdk.mjs');
const sdk = await sdkModule.loadServicesSdk();
const { ensureWallet } = await import('../plugins/algoria/lib/stellar/keystore.mjs');
const { entry } = await ensureWallet({ network: 'testnet' });
const { quote, runJob, statusJob, listJobs } = await import('../plugins/algoria/lib/services/client.mjs');
const { setBudget, getBudget, readLedger, readJob, ledgerPath } = await import('../plugins/algoria/lib/services/state.mjs');
const { discover } = await import('../plugins/algoria/lib/services/discovery.mjs');
const { atomicAmount, validateChallenge } = await import('../plugins/algoria/lib/services/policy.mjs');
const fixture = JSON.parse(await readFile(new URL('../../platform/docs/skill-integration/image.generate.json', import.meta.url), 'utf8'));
/** @type {any} */ let contract;
/** @type {Map<string, any>} */ let remote;
/** @type {any[]} */ let posts;
/** @type {((challenge: any, id: string) => void) | null} */ let corruptOffer;
let losePaidResponse = false;
let replyStatus = 'queued';
const sign = vi.fn(async (/** @type {any} */ challenge, /** @type {string} */ seed) => {
  expect(seed).toMatch(/^S/);
  expect(challenge.accepts[0].extra.custom).toBe('preserved');
  return 'mock-signed-authorization';
});

/** @param {any} job */
function result(job) {
  return {
    job_id: job.id, service_id: contract.id, service_version: contract.version,
    status: job.status, status_url: `${API_BASE}/v1/jobs/${job.id}`,
    payment: job.paid ? { success: true, network: 'stellar:testnet', transaction: 'a'.repeat(64), payer: entry.publicKey } : null,
    output: job.status === 'succeeded' ? { images: [{ url: 'https://media.example.com/image.png', content_type: 'image/png', width: 1024, height: 1024 }], url_expires_in: 3600 } : null,
    error: job.status === 'failed' ? { code: 'generation-failed' } : null
  };
}

beforeEach(async () => {
  await rm(ledgerPath(), { force: true });
  contract = structuredClone(fixture); remote = new Map(); posts = []; corruptOffer = null;
  losePaidResponse = false; replyStatus = 'queued'; sign.mockClear();
  vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, signChallenge: sign });
  vi.stubGlobal('fetch', vi.fn(async (/** @type {string | URL | Request} */ input, /** @type {RequestInit} */ init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    expect(init.redirect).toBe('error');
    if (url.pathname.endsWith('/discovery/resources')) return Response.json({ x402Version: 2, resources: [contract], pagination: { total: 1, limit: 20, offset: 0, cursor: null } });
    if (init.method !== 'POST' && url.pathname.endsWith(`/services/${contract.id}`)) return Response.json(contract);
    if (url.pathname.includes('/v1/jobs/')) {
      const id = url.pathname.split('/').at(-1) ?? '';
      const job = remote.get(id);
      if (!job) return Response.json({ code: 'job-not-found' }, { status: 404 });
      expect(headers.get('authorization')).toBe(`Bearer ${job.token}`);
      return Response.json(result(job));
    }
    if (init.method === 'POST') {
      const id = headers.get('Idempotency-Key') ?? '';
      const saved = await readJob(id); // proves persistence precedes first POST
      expect(saved.body).toBe(init.body);
      expect(headers.get('X-Recovery-Token')).toBe(saved.token);
      posts.push({ id, body: init.body, signature: headers.get('PAYMENT-SIGNATURE'), token: saved.token });
      const job = remote.get(id) ?? { id, token: saved.token, status: 'awaiting_payment', paid: false };
      remote.set(id, job);
      if (headers.has('PAYMENT-SIGNATURE')) {
        job.status = replyStatus; job.paid = true;
        if (losePaidResponse) throw new Error('connection lost after settlement');
        return Response.json(result(job), { status: 202 });
      }
      if (job.status === 'paid') { job.status = 'queued'; return Response.json(result(job), { status: 202 }); }
      if (job.status !== 'awaiting_payment') return Response.json(result(job));
      const challenge = { x402Version: 2, resource: { url: contract.resource, mimeType: 'application/json' }, accepts: [{ ...contract.accepts[0], extra: { ...contract.accepts[0].extra, custom: 'preserved' } }], extensions: { bazaar: { info: {}, schema: {} } } };
      corruptOffer?.(challenge, id);
      return Response.json({ ...challenge, job_id: id, expires_at: new Date(Date.now() + 600_000).toISOString() }, { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') } });
    }
    throw new Error('unexpected mock request');
  }));
  await setBudget('demo', '0.03', '0.02');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => rm(home, { recursive: true, force: true }));

describe('discovery and quote', () => {
  it('reads live metadata and preserves search and pagination filters', async () => {
    expect((await discover({ query: 'image', offset: 2, limit: 5 })).resources[0].id).toBe('image.generate');
    const called = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(called).toContain('query=image'); expect(called).toContain('offset=2');
  });
  it('saves identity/token and validates input before any payment', async () => {
    const job = await quote('image.generate', { prompt: 'a sailboat' }, 'demo');
    expect(job.amount).toBe('0.0100000'); expect(sign).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1); expect(posts[0].signature).toBeNull();
    expect((await stat(ledgerPath())).mode & 0o777).toBe(0o600);
    expect((await readJob(job.id)).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(quote('image.generate', { prompt: 'different' }, 'demo', job.id)).rejects.toThrow(/different input/);
  });
  it('rejects extra inputs before creating a quote', async () => {
    await expect(quote('image.generate', { prompt: 'test', model: 'forbidden' }, 'demo')).rejects.toThrow(/invalid service input/);
    expect(posts).toHaveLength(0);
  });
  it.each(['payTo', 'amount', 'network', 'asset'])('refuses a challenge whose %s differs from the saved contract', async (field) => {
    corruptOffer = (challenge) => { challenge.accepts[0][field] = field === 'payTo' ? entry.publicKey : field === 'amount' ? '200000' : 'unexpected'; };
    await expect(quote('image.generate', { prompt: 'test' }, 'demo')).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });
  it('rejects an invocation URL outside the trusted platform', async () => {
    contract.resource = 'https://attacker.invalid/service';
    await expect(quote('image.generate', { prompt: 'test' }, 'demo')).rejects.toThrow(/unsupported/);
    expect(posts).toHaveLength(0);
  });
  it('rejects mismatched challenge header/body and expired offers before signing', async () => {
    const preview = await quote('image.generate', { prompt: 'test' }, 'demo');
    const job = await readJob(preview.id);
    const response = new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(job.challenge)).toString('base64') } });
    const body = { ...structuredClone(job.challenge), job_id: job.id, expires_at: job.expiresAt };
    body.accepts[0].amount = '200000';
    await expect(validateChallenge(job, response, body)).rejects.toThrow(/header\/body mismatch/);
    await expect(validateChallenge(job, response, { ...job.challenge, job_id: job.id, expires_at: '2000-01-01T00:00:00Z' })).rejects.toThrow(/expired/);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('x402 payment and recovery', () => {
  it('requires approval then signs once, keeps the exact body and retrieves completed media', async () => {
    const job = await quote('image.generate', { prompt: 'a sailboat' }, 'demo');
    await expect(runJob(job.id)).rejects.toThrow(/approve/);
    expect(sign).not.toHaveBeenCalled();
    await runJob(job.id, { approve: true });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.signature)).toHaveLength(1);
    expect(new Set(posts.map((p) => p.id)).size).toBe(1);
    expect(new Set(posts.map((p) => p.body)).size).toBe(1);
    remote.get(job.id).status = 'succeeded';
    expect(await statusJob(job.id)).toMatchObject({ status: 'succeeded', phase: 'complete', output: { images: [{ content_type: 'image/png' }] } });
    expect(await getBudget('demo')).toMatchObject({ spent: '0.0100000', remaining: '0.0200000' });
    const visible = JSON.stringify(await listJobs());
    expect(visible).not.toContain((await readJob(job.id)).token);
    expect(visible).not.toContain('mock-signed-authorization');
  });
  it('recovers a lost paid response with GET, without resigning or charging twice', async () => {
    const job = await quote('image.generate', { prompt: 'test' }, 'demo');
    losePaidResponse = true;
    await expect(runJob(job.id, { approve: true })).rejects.toThrow(/uncertain/);
    losePaidResponse = false;
    const resumed = await runJob(job.id, { approve: true });
    expect(resumed.status).toBe('queued'); expect(resumed.requiresAttention).toBe(false);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.signature)).toHaveLength(1);
  });
  it('never resigns when the remote job still says awaiting_payment after dispatch', async () => {
    const job = await quote('image.generate', { prompt: 'test' }, 'demo');
    losePaidResponse = true;
    await expect(runJob(job.id, { approve: true })).rejects.toThrow();
    remote.get(job.id).status = 'awaiting_payment'; remote.get(job.id).paid = false;
    expect(await runJob(job.id, { approve: true })).toMatchObject({ requiresAttention: true });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(await getBudget('demo')).toMatchObject({ reserved: '0.0100000', remaining: '0.0200000' });
  });
  it('resumes an already paid job with an unsigned POST', async () => {
    const job = await quote('image.generate', { prompt: 'test' }, 'demo');
    replyStatus = 'paid'; await runJob(job.id, { approve: true });
    const resumed = await runJob(job.id);
    expect(resumed.status).toBe('queued'); expect(posts.at(-1).signature).toBeNull();
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it('preserves the receipt for a failed generation and does not restart it', async () => {
    const job = await quote('image.generate', { prompt: 'test' }, 'demo');
    replyStatus = 'failed'; await runJob(job.id, { approve: true });
    expect(await runJob(job.id, { approve: true })).toMatchObject({ status: 'failed', payment: { success: true } });
    expect(sign).toHaveBeenCalledTimes(1);
  });
  it('enforces remaining budget across concurrent jobs', async () => {
    await setBudget('limited', '0.01', '0.01');
    const a = await quote('image.generate', { prompt: 'a' }, 'limited');
    const b = await quote('image.generate', { prompt: 'b' }, 'limited');
    await Promise.allSettled([runJob(a.id, { approve: true }), runJob(b.id, { approve: true })]);
    expect(posts.filter((p) => p.signature)).toHaveLength(1);
    expect((await getBudget('limited')).remaining).toBe('0.0000000');
    await expect(setBudget('limited', '0.001', '0.001')).rejects.toThrow(/spent\/reserved/);
  });
  it('does not sign above the per-call limit', async () => {
    await setBudget('small', '0.03', '0.005');
    const job = await quote('image.generate', { prompt: 'test' }, 'small');
    await expect(runJob(job.id, { approve: true })).rejects.toThrow(/per-call/);
    expect(sign).not.toHaveBeenCalled();
    expect(posts.filter((p) => p.signature)).toHaveLength(0);
  });
  it('serializes concurrent execution of the same job', async () => {
    const job = await quote('image.generate', { prompt: 'test' }, 'demo');
    await Promise.allSettled([runJob(job.id, { approve: true }), runJob(job.id, { approve: true })]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(posts.filter((p) => p.signature)).toHaveLength(1);
  });
  it('does not replace a corrupt state file with an empty budget', async () => {
    await writeFile(ledgerPath(), 'broken');
    await expect(setBudget('demo', '1', '1')).rejects.toThrow();
    expect(await readFile(ledgerPath(), 'utf8')).toBe('broken');
  });
  it('uses exact decimal arithmetic rather than floats', () => {
    expect(atomicAmount('0.0000001')).toBe('1');
    expect(atomicAmount('0.09')).toBe('900000');
    expect(() => atomicAmount('0.00000001')).toThrow();
    expect(() => atomicAmount('1e3')).toThrow();
  });
});
