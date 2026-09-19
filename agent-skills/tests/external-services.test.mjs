import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdkModule from '../plugins/algoria/lib/services/sdk.mjs';
import * as discovery from '../plugins/algoria/lib/services/stellar8004.mjs';
import * as http from '../plugins/algoria/lib/services/external-http.mjs';
import { externalChallenge, externalInvocation } from '../plugins/algoria/lib/services/external-client.mjs';
import { quote, runJob, statusJob, listJobs } from '../plugins/algoria/lib/services/client.mjs';
import { getBudget, ledgerPath, readJob, setBudget, updateJob } from '../plugins/algoria/lib/services/state.mjs';
import { ensureWallet } from '../plugins/algoria/lib/stellar/keystore.mjs';
import { NETWORKS } from '../plugins/algoria/lib/stellar/network.mjs';

const home = await mkdtemp(join(tmpdir(), 'algoria-external-'));
process.env.ALGORIA_HOME = home;
const { entry } = await ensureWallet({ network: 'testnet' });
const sdk = await sdkModule.loadServicesSdk();
/** @type {any} */ let service;
/** @type {any} */ let offer;
/** @type {any} */ let payment;
/** @type {any[]} */ let paidCalls;
let loseResponse = false, omitReceipt = false, status = 200;
let challengeResource = '';
const sign = vi.fn(async (/** @type {any} */ challenge, /** @type {string} */ seed) => {
  expect(challenge.accepts[0].extra.custom).toBe('preserved');
  expect(seed).toMatch(/^S/);
  return 'saved-signature';
});
/** @param {any} data */
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64');

beforeEach(async () => {
  await rm(ledgerPath(), { force: true });
  service = { id: 'stellar8004:0:0', supported: true, source: 'stellar8004', registry: discovery.TESTNET_REGISTRY, version: '1', metadataFingerprint: 'original', resource: 'https://provider.example.com/render', method: null };
  offer = { scheme: 'exact', network: 'stellar:testnet', asset: NETWORKS.testnet.usdcSac, amount: '10000', payTo: entry.publicKey, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true, custom: 'preserved' } };
  payment = { success: true, network: 'stellar:testnet', transaction: 'a'.repeat(64), payer: entry.publicKey };
  paidCalls = []; loseResponse = false; omitReceipt = false; status = 200; challengeResource = ''; sign.mockClear();
  vi.spyOn(discovery, 'getStellar8004Service').mockImplementation(async () => structuredClone(service));
  vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, signChallenge: sign });
  vi.spyOn(http, 'externalRequest').mockImplementation(async (resource, options = {}) => {
    if (options.signature) {
      const saved = (await listJobs()).find((job) => job.source === 'stellar8004' && job.status === 'payment-uncertain');
      expect(saved?.requiresAttention).toBe(true); // write-ahead dispatch intent
      paidCalls.push({ resource, ...options });
      if (loseResponse) throw new Error('connection lost');
      return { response: new Response(null, { status, headers: omitReceipt ? {} : { 'payment-response': encode(payment) } }), body: { title: 'Rendered page' } };
    }
    return { response: new Response(null, { status: 402, headers: { 'payment-required': encode({ x402Version: 2, resource: { url: challengeResource || resource }, accepts: [structuredClone(offer)] }) } }), body: {} };
  });
  await setBudget('demo', '0.003', '0.002');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rm(home, { recursive: true, force: true }));
const input = { url: 'https://stellar.org' };
const newQuote = () => quote(service.id, input, 'demo', undefined, 'GET');

describe('external invocation and x402', () => {
  it('requires an explicit method if registration omits it and safely builds exact GET/POST input', () => {
    expect(() => externalInvocation(service, input)).toThrow('--method');
    expect(externalInvocation(service, input, 'GET')).toMatchObject({ resource: 'https://provider.example.com/render?url=https%3A%2F%2Fstellar.org', body: undefined });
    expect(externalInvocation(service, input, 'POST')).toMatchObject({ resource: service.resource, body: JSON.stringify(input) });
    expect(() => externalInvocation(service, { nested: {} }, 'GET')).toThrow('scalar');
    expect(() => externalInvocation({ ...service, resource: `${service.resource}?url=registered` }, input, 'GET')).toThrow('overwriting');
    expect(() => externalInvocation({ ...service, method: 'GET' }, input, 'POST')).toThrow('differs');
  });
  it('quotes, approves and sends exactly once, with a shared budget and local-only status', async () => {
    const job = await newQuote();
    expect(job).toMatchObject({ source: 'stellar8004', amount: '0.0010000', statusSource: 'local' });
    expect((await readJob(job.id)).token).toBeUndefined();
    await expect(runJob(job.id)).rejects.toThrow('--approve');
    expect(sign).not.toHaveBeenCalled();
    expect(await runJob(job.id, { approve: true })).toMatchObject({ status: 'succeeded', output: { title: 'Rendered page' }, payment: { success: true } });
    const calls = vi.mocked(http.externalRequest).mock.calls.length;
    await runJob(job.id, { approve: true });
    await statusJob(job.id, { wait: true });
    expect(vi.mocked(http.externalRequest)).toHaveBeenCalledTimes(calls);
    expect(sign).toHaveBeenCalledTimes(1); expect(paidCalls).toHaveLength(1);
    expect(paidCalls[0]).toMatchObject({ method: 'GET', body: undefined, signature: 'saved-signature' });
    expect(await getBudget('demo')).toMatchObject({ spent: '0.0010000', remaining: '0.0020000' });
    expect(JSON.stringify(await listJobs())).not.toContain('saved-signature');
  });
  it('accepts RenderGate-style http resource metadata but calls only the exact HTTPS URL', async () => {
    challengeResource = 'http://provider.example.com/render?url=https%3A%2F%2Fstellar.org';
    await newQuote();
    expect(vi.mocked(http.externalRequest).mock.calls.every(([url]) => url.startsWith('https:'))).toBe(true);
  });
  it('selects testnet from mixed offers and rejects ambiguous compatible offers', async () => {
    const challenge = { x402Version: 2, resource: { url: service.resource }, accepts: [{ ...offer, network: 'stellar:pubnet' }, offer] };
    const reply = () => new Response(null, { status: 402, headers: { 'payment-required': encode(challenge) } });
    expect((await externalChallenge(service, reply())).challenge.accepts).toEqual([offer]);
    challenge.accepts = [offer, { ...offer, amount: '20000' }];
    await expect(externalChallenge(service, reply())).rejects.toThrow('exactly one');
  });
  it('uses the identical JSON body for the unsigned and signed POST requests', async () => {
    service.method = 'POST';
    const job = await quote(service.id, input, 'demo');
    await runJob(job.id, { approve: true });
    expect(vi.mocked(http.externalRequest).mock.calls.every(([url, options]) => url === service.resource && options?.method === 'POST' && options.body === JSON.stringify(input))).toBe(true);
  });
  it('serializes concurrent runs of the same external job', async () => {
    const job = await newQuote();
    await Promise.allSettled([runJob(job.id, { approve: true }), runJob(job.id, { approve: true })]);
    expect(sign).toHaveBeenCalledTimes(1); expect(paidCalls).toHaveLength(1);
  });
  it('refuses an expired quote before signing or probing again', async () => {
    const job = await newQuote();
    await updateJob(job.id, { expiresAt: '2000-01-01T00:00:00.000Z' });
    const count = vi.mocked(http.externalRequest).mock.calls.length;
    await expect(runJob(job.id, { approve: true })).rejects.toThrow('expired');
    expect(http.externalRequest).toHaveBeenCalledTimes(count); expect(sign).not.toHaveBeenCalled();
  });
  it.each(['https://other.example.com/render', 'https://provider.example.com/other', 'http://provider.example.com:8080/render', 'https://provider.example.com/render'])('rejects a mismatched challenge resource %s', async (url) => {
    challengeResource = url;
    await expect(newQuote()).rejects.toThrow('quote failed');
    expect(sign).not.toHaveBeenCalled();
    expect((await listJobs())[0].status).toBe('quote-failed');
  });
  it.each(['network', 'asset', 'scheme', 'amount'])('rejects unsupported %s before signing', async (key) => {
    offer[key] = key === 'amount' ? '0' : 'wrong';
    await expect(newQuote()).rejects.toThrow('quote failed');
    expect(sign).not.toHaveBeenCalled();
  });
  it('does not pay when metadata or price changes after quoting', async () => {
    const job = await newQuote();
    service.metadataFingerprint = 'changed';
    await expect(runJob(job.id, { approve: true })).rejects.toThrow('registered service changed');
    service.metadataFingerprint = 'original'; offer.amount = '20000';
    await expect(runJob(job.id, { approve: true })).rejects.toThrow('payment terms changed');
    expect(sign).not.toHaveBeenCalled();
  });
  it('preserves the saved identity and refuses a different input or method', async () => {
    const job = await newQuote();
    const count = vi.mocked(http.externalRequest).mock.calls.length;
    await quote(service.id, input, 'demo', job.id, 'GET');
    expect(http.externalRequest).toHaveBeenCalledTimes(count);
    await expect(quote(service.id, input, 'demo', job.id, 'POST')).rejects.toThrow('different input');
  });
  it('keeps the budget reserved after a lost response and never retries or resigns', async () => {
    const job = await newQuote(); loseResponse = true;
    await expect(runJob(job.id, { approve: true })).rejects.toThrow('uncertain');
    const count = vi.mocked(http.externalRequest).mock.calls.length;
    expect(await statusJob(job.id)).toMatchObject({ requiresAttention: true, statusSource: 'local' });
    await runJob(job.id, { approve: true });
    expect(http.externalRequest).toHaveBeenCalledTimes(count);
    expect(sign).toHaveBeenCalledTimes(1); expect(paidCalls).toHaveLength(1);
    expect(await getBudget('demo')).toMatchObject({ reserved: '0.0010000', remaining: '0.0020000' });
  });
  it('retains an existing signature without signing again if the process stopped before dispatch', async () => {
    const job = await newQuote();
    await updateJob(job.id, { signature: 'existing-signature', phase: 'signed', payer: entry.publicKey });
    await runJob(job.id, { approve: true });
    expect(sign).not.toHaveBeenCalled();
    expect(paidCalls[0].signature).toBe('existing-signature');
  });
  it('does not treat a missing receipt or a receipt on another network as success', async () => {
    const job = await newQuote(); omitReceipt = true;
    await expect(runJob(job.id, { approve: true })).rejects.toThrow('uncertain');
    expect(await statusJob(job.id)).toMatchObject({ status: 'payment-uncertain', output: { title: 'Rendered page' } });
    omitReceipt = false; payment.network = 'stellar:pubnet';
    const next = await newQuote();
    await expect(runJob(next.id, { approve: true })).rejects.toThrow('uncertain');
  });
  it('records 202 with a receipt as paid but requiring attention, without inventing polling', async () => {
    const job = await newQuote(); status = 202;
    expect(await runJob(job.id, { approve: true })).toMatchObject({ status: 'submission-uncertain', payment: { success: true }, requiresAttention: true });
    expect(await getBudget('demo')).toMatchObject({ spent: '0.0010000' });
  });
  it('enforces per-call and cumulative budgets across external jobs', async () => {
    await setBudget('demo', '0.001', '0.001');
    const a = await newQuote(), b = await newQuote();
    await runJob(a.id, { approve: true });
    await expect(runJob(b.id, { approve: true })).rejects.toThrow('budget');
    expect(paidCalls).toHaveLength(1);
  });
});
