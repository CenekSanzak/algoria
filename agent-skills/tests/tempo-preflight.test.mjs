import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as readiness from '../plugins/algoria/lib/services/tempo-readiness.mjs';
import * as state from '../plugins/algoria/lib/services/state.mjs';
import * as sdkLoader from '../plugins/algoria/lib/services/tempo-sdk.mjs';
import { tempoPreflight } from '../plugins/algoria/lib/services/tempo-preflight.mjs';
import { serviceUrl } from '../plugins/algoria/lib/services/api.mjs';
import { TEMPO_TOKEN } from '../plugins/algoria/lib/services/tempo-links.mjs';
/** @type {any} */ let offer;
/** @type {any} */ let budget;
/** @type {any} */ let rpc;
beforeEach(() => {
  offer = { protocol: 'mpp', chain: 'eip155:42431', token: TEMPO_TOKEN, decimals: 6,
    amount: '10000', recipient: `0x${'1'.repeat(40)}` };
  budget = { protocol: 'mpp', remaining: '0.01', perCall: '0.01', permission: {
    state: 'active', service: 'image.generate', recipient: offer.recipient, agent: 'codex',
    expiresAt: new Date(Date.now() + 3600000).toISOString() } };
  vi.spyOn(readiness, 'tempoReadiness').mockReturnValue(/** @type {any} */ ({ ready: true, nextAction: 'Ready' }));
  vi.spyOn(state, 'getBudget').mockImplementation(async () => budget);
  rpc = { getChainId: vi.fn().mockResolvedValue(42431), getGasPrice: vi.fn().mockResolvedValue(20000000000n),
    request: vi.fn(), sendRawTransaction: vi.fn(), readContract: vi.fn() };
  vi.spyOn(sdkLoader, 'loadTempoSdk').mockResolvedValue({ createPublicClient: () => rpc, http: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    expect(options.method).toBeUndefined(); expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).has('Authorization')).toBe(false);
    return Response.json({ id: 'image.generate', resource: serviceUrl('image.generate'), mpp: offer });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('read-only demo preflight', () => {
  it('checks actual setup and allowance without creating, quoting, funding or paying', async () => {
    const result = await tempoPreflight({ budget: 'demo', agent: 'codex' });
    expect(result).toMatchObject({ ready: true, servicePrice: '0.010000', paymentAttempted: false, keyCreated: false, faucetRequested: false });
    expect(result.checks).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rpc.request).not.toHaveBeenCalled(); expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'expired-or-invalid', 'approval-required'])('does not repair %s permissions or raise limits', async status => {
    budget.permission.state = status; budget.remaining = '0';
    const result = await tempoPreflight({ budget: 'demo' });
    expect(result.ready).toBe(false);
    expect(result.checks.find(c => c.key === 'permission')?.ready).toBe(false);
    expect(result.checks.find(c => c.key === 'limits')?.ready).toBe(false);
  });
  it.each(['service', 'recipient', 'agent'])('rejects changed %s scope', async key => {
    budget.permission[key] = 'different';
    expect((await tempoPreflight({ budget: 'demo', agent: 'codex' })).ready).toBe(false);
  });
  it('returns an actionable missing-budget result without leaking exception data', async () => {
    vi.mocked(state.getBudget).mockRejectedValue(new Error('private fixture'));
    const result = await tempoPreflight({ budget: 'missing' });
    expect(result.ready).toBe(false); expect(JSON.stringify(result)).not.toContain('private fixture');
  });
  it('reports backend, network and Touch ID failures without pretending to be a live test', async () => {
    vi.mocked(readiness.tempoReadiness).mockReturnValue(/** @type {any} */ ({ ready: false, nextAction: 'Check sandbox access' }));
    vi.mocked(fetch).mockRejectedValue(new Error('offline')); rpc.getChainId.mockResolvedValue(1);
    const result = await tempoPreflight({ budget: 'demo' });
    expect(result.ready).toBe(false); expect(result.nextAction).toBe('Check sandbox access');
    expect(result.checks.find(c => c.key === 'service')?.ready).toBe(false);
    expect(result.checks.find(c => c.key === 'network')?.ready).toBe(false);
  });
  it('rejects unsafe live fee caps, near-expired grants and non-Tempo metadata', async () => {
    rpc.getGasPrice.mockResolvedValue(30000000001n);
    budget.permission.expiresAt = new Date(Date.now() + 1000).toISOString(); offer.chain = 'eip155:1';
    const result = await tempoPreflight({ budget: 'demo' });
    expect(result.checks.filter(c => !c.ready).map(c => c.key)).toEqual(['service', 'network', 'permission', 'limits']);
  });
});
