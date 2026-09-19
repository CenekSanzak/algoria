import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as registry from '../plugins/algoria/lib/services/stellar8004.mjs';
import * as http from '../plugins/algoria/lib/services/external-http.mjs';
import { callMcpTool, listMcpTools, mcpStatus } from '../plugins/algoria/lib/services/mcp-client.mjs';
import { quoteExternal } from '../plugins/algoria/lib/services/external-client.mjs';
import { ledgerPath, readLedger, setBudget } from '../plugins/algoria/lib/services/state.mjs';
import { recall } from '../plugins/algoria/lib/memory.mjs';
import { runJob } from '../plugins/algoria/lib/services/client.mjs';

const home = await mkdtemp(join(tmpdir(), 'algoria-mcp-'));
process.env.ALGORIA_HOME = home;
const service = 'stellar8004:25:0';
const id = 'ab123456-1234-4123-8123-123456789012';
/** @type {any} */ let contract;
/** @type {any[]} */ let sent;
/** @type {any} */ let result;
/** @type {any} */ let tool;
/** @type {string | undefined} */ let failure;
/** @type {any[] | null} */ let listPages;
let listIndex = 0;

beforeEach(async () => {
  await rm(ledgerPath(), { force: true });
  sent = []; failure = undefined; listPages = null; listIndex = 0;
  contract = { id: service, source: 'stellar8004', transport: 'mcp', supported: true, registry: 'registry', resource: 'https://provider.example.com/mcp', metadataFingerprint: 'fingerprint', version: '1' };
  tool = { name: 'verify_agent', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['agentId'], properties: { agentId: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } };
  result = { content: [{ type: 'text', text: 'Verified' }], structuredContent: { verified: true } };
  vi.spyOn(registry, 'getStellar8004Service').mockImplementation(async () => structuredClone(contract));
  vi.spyOn(http, 'externalRequest').mockImplementation(async (_url, options) => {
    if (options?.method === 'DELETE') return { response: new Response(null, { status: 204 }), body: '' };
    const msg = JSON.parse(options?.body ?? '{}'); sent.push({ msg, options });
    if (msg.method === 'initialize') return { response: new Response(null, { headers: { 'mcp-session-id': 'private-session' } }), body: { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } } };
    if (msg.method === 'notifications/initialized') return { response: new Response(null, { status: 202 }), body: '' };
    if (msg.method === 'tools/list') return { response: new Response(), body: { jsonrpc: '2.0', id: msg.id, result: listPages ? listPages[listIndex++] : { tools: [tool] } } };
    expect(msg.method).toBe('tools/call');
    // The durable identity must exist before any potentially mutating request.
    expect((await readLedger()).jobs[id]).toMatchObject({ status: 'call-uncertain', tool: 'verify_agent' });
    if (failure === 'timeout') throw new Error('connection lost');
    if (failure === '402' || failure === '401') return { response: new Response(null, { status: Number(failure) }), body: {} };
    return { response: new Response(), body: { jsonrpc: '2.0', id: failure === 'wrong-id' ? 'other' : msg.id, result } };
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => rm(home, { recursive: true, force: true }));

describe('Stellar8004 MCP client', () => {
  it('negotiates a session and lists schemas with no wallet or payment', async () => {
    const listed = await listMcpTools(service);
    expect(listed.tools[0].name).toBe('verify_agent');
    expect(sent.map((s) => s.msg.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(sent[2].options.mcp).toMatchObject({ sessionId: 'private-session', protocol: '2025-11-25' });
    expect(sent.every((s) => !s.options.signature)).toBe(true);
    await expect(readFile(join(home, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('supports explicit stateless 2026 protocol metadata without a legacy handshake', async () => {
    await listMcpTools(service, { protocol: '2026-07-28' });
    expect(sent.map((s) => s.msg.method)).toEqual(['tools/list']);
    expect(sent[0].options.mcp).toMatchObject({ method: 'tools/list', protocol: '2026-07-28' });
    expect(sent[0].msg.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
  });
  it('records tool results without payment budgets, credentials or session secrets', async () => {
    const tokenFile = join(home, 'provider-token'); await writeFile(tokenFile, 'private-bearer');
    const output = await callMcpTool(service, 'verify_agent', { agentId: '25' }, { approve: true, id, tokenFile, authOrigin: 'https://provider.example.com' });
    expect(output).toMatchObject({ status: 'succeeded', transport: 'mcp', unit: null, amount: null, payment: null, output: { structuredContent: { verified: true } } });
    const saved = await readFile(ledgerPath(), 'utf8');
    expect(saved).not.toContain('private-bearer'); expect(saved).not.toContain('private-session');
    expect((await readLedger()).budgets).toEqual({});
    expect((await recall()).history[0]).toMatchObject({ transport: 'mcp', tool: 'verify_agent', charged: null });
    const before = sent.length;
    expect(await mcpStatus(id)).toEqual(output);
    expect(await callMcpTool(service, 'verify_agent', { agentId: '25' }, { approve: true, id })).toEqual(output);
    expect(sent).toHaveLength(before);
    await expect(runJob(id, { approve: true })).rejects.toThrow('cannot run through pay');
  });
  it('rejects token origin mismatch before any HTTP request', async () => {
    await expect(listMcpTools(service, { tokenFile: '/does-not-matter', authOrigin: 'https://other.example.com' })).rejects.toThrow('origin');
    expect(http.externalRequest).not.toHaveBeenCalled();
  });
  it('checks authorization and the live input schema before invoking a tool', async () => {
    await expect(callMcpTool(service, 'verify_agent', {}, { id })).rejects.toThrow('--approve');
    expect(sent).toHaveLength(0);
    await expect(callMcpTool(service, 'verify_agent', {}, { id, approve: true })).rejects.toThrow('invalid service input');
    expect(sent.some((s) => s.msg.method === 'tools/call')).toBe(false);
    expect((await readLedger()).jobs).toEqual({});
  });
  it.each(['timeout', 'wrong-id', '402', '401'])('never repeats a dispatched call after %s', async (mode) => {
    failure = mode;
    await expect(callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true })).rejects.toThrow('reconciliation');
    const before = sent.length;
    expect(await callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true })).toMatchObject({ status: 'call-uncertain', requiresAttention: true });
    expect(sent).toHaveLength(before);
    expect(sent.every((s) => !s.options.signature)).toBe(true);
  });
  it('treats isError and interactive results as non-success', async () => {
    result = { isError: true, content: [{ type: 'text', text: 'Cannot verify' }] };
    expect(await callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true })).toMatchObject({ status: 'failed', error: { code: 'mcp-tool-error' } });
    await rm(ledgerPath()); result = { resultType: 'input_required', inputRequests: {} };
    await expect(callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true, protocol: '2026-07-28' })).rejects.toThrow('reconciliation');
    expect(await mcpStatus(id)).toMatchObject({ requiresAttention: true });
  });
  it('blocks endpoint changes between discovery and dispatch', async () => {
    vi.mocked(registry.getStellar8004Service).mockResolvedValueOnce(structuredClone(contract)).mockResolvedValue({ ...contract, resource: 'https://other.example.com/mcp' });
    await expect(callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true })).rejects.toThrow('registration changed');
    expect(sent.some((s) => s.msg.method === 'tools/call')).toBe(false);
  });
  it('rejects a malformed RPC response instead of treating it as a tool list', async () => {
    vi.mocked(http.externalRequest).mockResolvedValue({ response: new Response(), body: {} });
    await expect(listMcpTools(service)).rejects.toThrow('response identity');
  });
  it('does not route an MCP endpoint into x402 quote', async () => {
    await setBudget('demo', '0.01', '0.01');
    await expect(quoteExternal(service, {}, 'demo')).rejects.toThrow('use algoria mcp');
    expect(http.externalRequest).not.toHaveBeenCalled();
  });
  it('follows tool pagination and rejects duplicate definitions/cursor loops', async () => {
    listPages = [{ tools: [tool], nextCursor: 'next' }, { tools: [{ ...tool, name: 'other' }] }];
    expect((await listMcpTools(service)).tools.map((t) => t.name)).toEqual(['verify_agent', 'other']);
    expect(sent.find((s) => s.msg.params?.cursor)?.msg.params.cursor).toBe('next');
    listIndex = 0; listPages = [{ tools: [tool], nextCursor: 'next' }, { tools: [tool] }];
    await expect(listMcpTools(service)).rejects.toThrow('duplicate');
    listIndex = 0; listPages = [{ tools: [], nextCursor: 'next' }, { tools: [], nextCursor: 'next' }];
    await expect(listMcpTools(service)).rejects.toThrow('cursor');
  });
  it('validates structured output instead of accepting malformed tool success', async () => {
    tool.outputSchema = { type: 'object', properties: { verified: { type: 'boolean' } }, required: ['verified'] };
    result = { content: [], structuredContent: { verified: 'not boolean' } };
    await expect(callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true })).rejects.toThrow('reconciliation');
    expect(await mcpStatus(id)).toMatchObject({ status: 'call-uncertain' });
  });
  it('rejects reusing a call ID with changed tool input', async () => {
    await callMcpTool(service, 'verify_agent', { agentId: '25' }, { id, approve: true });
    const before = sent.length;
    await expect(callMcpTool(service, 'verify_agent', { agentId: '26' }, { id, approve: true })).rejects.toThrow('identity');
    expect(sent).toHaveLength(before);
  });
});
