import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sdkModule from '../plugins/algoria/lib/services/sdk.mjs';
import * as http from '../plugins/algoria/lib/services/external-http.mjs';
import { discoverStellar8004, getStellar8004Service, TESTNET_REGISTRY } from '../plugins/algoria/lib/services/stellar8004.mjs';

const sdk = await sdkModule.loadServicesSdk();
/** @param {any} metadata */
const dataUri = (metadata) => `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;
const metadata = { name: 'RenderGate', x402: true, services: [{ name: 'x402', endpoint: 'https://provider.example.com/render', inputExample: '{"url":"https://stellar.org"}' }] };
afterEach(() => vi.restoreAllMocks());

describe('on-chain Stellar8004 discovery', () => {
  it('uses the pinned testnet registry, preserves service indexes and searches a bounded agent page', async () => {
    const readRegistry = vi.fn(async (registry, method, id) => {
      expect(registry).toBe(TESTNET_REGISTRY);
      if (method === 'total_agents') return 27;
      if (id === 1) throw new Error('missing metadata');
      return dataUri(id === 0 ? metadata : { name: 'Other', services: [] });
    });
    vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, readRegistry });
    const page = await discoverStellar8004({ query: 'render', limit: 3 });
    expect(page).toMatchObject({ resources: [{ id: 'stellar8004:0:0', supported: true, method: null, inputExample: { url: 'https://stellar.org' } }], unavailable: [{ agentId: 1 }], pagination: { totalAgents: 27, nextOffset: 3 } });
    expect(readRegistry).toHaveBeenCalledTimes(4);
    const empty = await discoverStellar8004({ query: 'missing', offset: 3, limit: 2 });
    expect(empty.resources).toEqual([]);
    expect(empty.pagination.nextOffset).toBe(5);
  });
  it('exposes unavailable entries rather than pretending the entire registry is empty', async () => {
    vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, readRegistry: async (_, method) => method === 'total_agents' ? 2 : 'data:application/json,broken' });
    expect(await discoverStellar8004()).toMatchObject({ resources: [], unavailable: [{ agentId: 0 }, { agentId: 1 }], pagination: { totalAgents: 2, nextOffset: null } });
  });
  it('fails when the RPC count cannot be read', async () => {
    vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, readRegistry: async () => { throw new Error('RPC offline'); } });
    await expect(discoverStellar8004()).rejects.toThrow('RPC offline');
  });
  it('marks private, MCP and A2A endpoints unsupported without calling them', async () => {
    const m = { name: 'Untrusted', x402: true, services: [{ name: 'x402', endpoint: 'https://127.0.0.1/run' }, { name: 'mcp', endpoint: 'https://provider.example.com/mcp' }, { name: 'a2a', endpoint: 'http://localhost:8787' }] };
    vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, readRegistry: async (_, method) => method === 'total_agents' ? 1 : dataUri(m) });
    const request = vi.spyOn(http, 'externalRequest');
    expect((await discoverStellar8004()).resources.every((s) => !s.supported)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it('reads HTTPS metadata through the bounded public connector and fingerprints changes', async () => {
    vi.spyOn(sdkModule, 'loadServicesSdk').mockResolvedValue({ ...sdk, readRegistry: async () => 'https://provider.example.com/agent.json' });
    const request = vi.spyOn(http, 'externalRequest').mockResolvedValue({ response: new Response(), body: metadata });
    const first = await getStellar8004Service('stellar8004:2:0');
    expect(request).toHaveBeenCalledWith('https://provider.example.com/agent.json', { maxBytes: 65536 });
    request.mockResolvedValue({ response: new Response(), body: { ...metadata, name: 'Changed' } });
    expect((await getStellar8004Service('stellar8004:2:0')).metadataFingerprint).not.toBe(first.metadataFingerprint);
    await expect(getStellar8004Service('stellar8004:2:1')).rejects.toThrow('does not advertise');
  });
  it.each(['stellar8004:-1:0', 'stellar8004:4294967296:0', 'stellar8004:0:100', 'stellar8004:01:0', 'stellar8004:0'])('rejects malformed ID %s', async (id) => {
    await expect(getStellar8004Service(id)).rejects.toThrow('expected stellar8004:');
  });
});
