import { createHash } from 'node:crypto';
import { loadServicesSdk } from './sdk.mjs';
import { externalRequest, externalUrl } from './external-http.mjs';

// trionlabs/stellar-8004 SDK config, deployment 2026-04-11. Never take a
// registry, network or RPC URL from agent-supplied metadata.
export const TESTNET_REGISTRY = 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH';
const MAX_METADATA_BYTES = 65_536;

/** @param {string} id */
export function parseExternalId(id) {
  const match = /^stellar8004:(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(id);
  if (!match || Number(match[1]) > 0xffffffff || Number(match[2]) > 99) throw new Error('expected stellar8004:<agent-id>:<service-index>');
  return { agentId: Number(match[1]), serviceIndex: Number(match[2]) };
}

/** @param {string} uri */
async function metadataFromUri(uri) {
  if (typeof uri !== 'string' || Buffer.byteLength(uri) > MAX_METADATA_BYTES * 2) throw new Error('agent metadata URI is missing or too large');
  let metadata;
  if (uri.startsWith('data:application/json')) {
    const match = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
    if (!match) throw new Error('unsupported agent metadata data URI');
    const text = match[1] ? Buffer.from(match[2], 'base64').toString('utf8') : decodeURIComponent(match[2]);
    if (Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error('agent metadata is too large');
    metadata = JSON.parse(text);
  } else {
    const url = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
    const { response, body } = await externalRequest(url, { maxBytes: MAX_METADATA_BYTES });
    if (!response.ok) throw new Error('agent metadata unavailable');
    metadata = body;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid agent metadata');
  return metadata;
}

/** @param {unknown} value @param {number} max */
function text(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : ''; }

/** @param {number} agentId */
async function readAgent(agentId) {
  const sdk = await loadServicesSdk();
  const uri = await sdk.readRegistry(TESTNET_REGISTRY, 'agent_uri', agentId);
  const metadata = await metadataFromUri(uri);
  if (metadata.services !== undefined && (!Array.isArray(metadata.services) || metadata.services.length > 100)) throw new Error('invalid agent service list');
  const fingerprint = createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  return (metadata.services ?? []).map((/** @type {any} */ service, /** @type {number} */ index) => {
    const endpoint = typeof service?.endpoint === 'string' ? service.endpoint : '';
    const name = text(service?.name, 100);
    const mcp = /^mcp$/i.test(name) || /^mcp$/i.test(service?.type ?? service?.protocol ?? '');
    const x402 = /x402/i.test(name) || ((metadata.x402 === true || metadata.x402Support === true) && /^(https?|rest|web)$/i.test(name));
    const transport = mcp ? 'mcp' : x402 ? 'x402' : 'unsupported';
    let supported = mcp || x402;
    try { externalUrl(endpoint); } catch { supported = false; }
    let inputExample = service?.inputExample;
    if (typeof inputExample === 'string') {
      try { inputExample = JSON.parse(inputExample); } catch { inputExample = text(inputExample, 4000); }
    }
    return {
      id: `stellar8004:${agentId}:${index}`, source: 'stellar8004', transport, registryNetwork: 'stellar:testnet', paymentNetwork: mcp ? null : 'unverified-until-quote',
      registry: TESTNET_REGISTRY, agentId, serviceIndex: index, metadataFingerprint: fingerprint,
      agentName: text(metadata.name, 150), name, description: text(service?.description ?? metadata.description, 2000),
      resource: endpoint, method: ['GET', 'POST'].includes(service?.method) ? service.method : null,
      version: text(service?.version, 100) || 'unversioned', inputExample,
      input_schema: service?.inputSchema ?? service?.input_schema ?? null,
      supported, price: mcp ? 'Provider-defined; MCP does not imply free access. No automatic x402 payment.' : 'Obtain an unsigned x402 quote',
      ...(mcp ? { invocation: 'algoria mcp tools <id>, then algoria mcp call <id> --tool <name> --input <file> --approve', availability: 'unverified-until-MCP-handshake' } : {}),
      trust: 'On-chain identity; capabilities and endpoints are self-declared. This is not an endorsement.',
      unsupportedReason: supported ? null : 'Requires public HTTPS x402 or Streamable HTTP MCP. A2A, local and stdio endpoints are not supported.'
    };
  });
}

/** Pagination scans agent IDs, not matching services: even an empty page may
 * have a nextOffset. Bad metadata must not hide all other agents in the page.
 * @param {{query?: string, limit?: number, offset?: number}} [options]
 */
export async function discoverStellar8004({ query, limit = 20, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) throw new Error('invalid discovery pagination');
  const { readRegistry } = await loadServicesSdk();
  const total = await readRegistry(TESTNET_REGISTRY, 'total_agents');
  if (!Number.isInteger(total) || total < 0 || total > 0xffffffff) throw new Error('invalid registry agent count');
  const end = Math.min(total, offset + limit);
  /** @type {any[]} */ const resources = [];
  /** @type {{agentId: number, reason: string}[]} */ const unavailable = [];
  // Four concurrent reads bounds both latency and load on the public RPC.
  for (let start = offset; start < end; start += 4) {
    await Promise.all(Array.from({ length: Math.min(4, end - start) }, async (_, n) => {
      const agentId = start + n;
      try { resources.push(...await readAgent(agentId)); }
      catch { unavailable.push({ agentId, reason: 'metadata could not be read or validated' }); }
    }));
  }
  resources.sort((a, b) => a.agentId - b.agentId || a.serviceIndex - b.serviceIndex);
  unavailable.sort((a, b) => a.agentId - b.agentId);
  const search = query?.toLowerCase();
  return { source: 'stellar8004', network: 'stellar:testnet', registry: TESTNET_REGISTRY,
    resources: search ? resources.filter((r) => `${r.agentName} ${r.name} ${r.description}`.toLowerCase().includes(search)) : resources,
    unavailable, pagination: { limit, offset, totalAgents: total, nextOffset: end < total ? end : null } };
}

/** @param {string} id */
export async function getStellar8004Service(id) {
  const { agentId, serviceIndex } = parseExternalId(id);
  const resources = await readAgent(agentId);
  const resource = resources[serviceIndex];
  if (!resource) throw new Error('agent does not advertise that service');
  return resource;
}
