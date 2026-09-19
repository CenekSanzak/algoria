import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { externalRequest, externalUrl, publicAddresses, sseResponse } from '../plugins/algoria/lib/services/external-http.mjs';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
/** @type {any} */ let socketOptions;
/** @type {any} */ let pinned;
let status = 200;
/** @type {Record<string, string>} */ let headers;
let body = '{}';
let endStream = true;

beforeEach(() => {
  status = 200; headers = { 'content-type': 'application/json' }; body = '{}'; endStream = true;
  vi.mocked(lookup).mockResolvedValue(/** @type {any} */ ([{ address: '93.184.216.34', family: 4 }]));
  vi.mocked(request).mockImplementation(/** @type {any} */ ((/** @type {URL} */ url, /** @type {any} */ options, /** @type {any} */ callback) => {
    socketOptions = options;
    const req = Object.assign(new EventEmitter(), {
      destroy: (/** @type {Error} */ error) => { queueMicrotask(() => { req.emit('error', error); req.emit('close'); }); },
      end: () => {
        options.lookup(url.hostname, { all: true }, (/** @type {Error | null} */ error, /** @type {any} */ addresses) => {
          if (error) { req.destroy(error); return; }
          pinned = addresses;
          const incoming = Object.assign(new EventEmitter(), { statusCode: status, headers, destroy: (/** @type {Error} */ e) => {
            if (e) queueMicrotask(() => incoming.emit('error', e));
          } });
          callback(incoming);
          incoming.emit('data', Buffer.from(body)); if (endStream) incoming.emit('end'); req.emit('close');
        });
      }
    });
    return req;
  }));
});
afterEach(() => vi.clearAllMocks());

describe('external HTTPS boundary', () => {
  it.each(['http://example.com', 'https://localhost', 'https://localhost.', 'https://127.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://user:secret@example.com', 'https://example.com:8443', 'https://example.com/#fragment', 'https://service.internal', 'https://service.local'])('rejects unsafe URL %s', (url) => {
    expect(() => externalUrl(url)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.0.1', '172.16.0.1', '0.0.0.0', '224.0.0.1'])('rejects DNS resolving to %s before connection', async (address) => {
    vi.mocked(lookup).mockResolvedValue(/** @type {any} */ ([{ address, family: 4 }]));
    await expect(publicAddresses('provider.example.com')).rejects.toThrow('private or reserved');
  });
  it('passes exactly the checked addresses to the connector and only payment-specific headers', async () => {
    headers['payment-response'] = 'receipt'; body = '{"output":"ok"}';
    const result = await externalRequest('https://provider.example.com/run', { method: 'POST', body: '{}', signature: 'signed' });
    expect(pinned).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(socketOptions.agent).toBe(false);
    expect(socketOptions.headers).toEqual({ accept: 'application/json, text/plain', 'accept-encoding': 'identity', 'content-type': 'application/json', 'PAYMENT-SIGNATURE': 'signed' });
    expect(result.body).toEqual({ output: 'ok' });
    expect(result.response.headers.get('payment-response')).toBe('receipt');
  });
  it('rejects a mixed public/private DNS result', async () => {
    vi.mocked(lookup).mockResolvedValue(/** @type {any} */ ([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]));
    await expect(externalRequest('https://provider.example.com')).rejects.toThrow('failed');
  });
  it('never follows redirects, including for signed requests', async () => {
    status = 302; headers.location = 'https://other.example.com';
    await expect(externalRequest('https://provider.example.com', { signature: 'signed' })).rejects.toThrow('redirects');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('bounds streamed bodies rather than trusting content-length', async () => {
    headers['content-length'] = '1'; body = '123456789';
    await expect(externalRequest('https://provider.example.com', { maxBytes: 4 })).rejects.toThrow('too large');
  });
  it('rejects compressed data without decompressing it', async () => {
    headers['content-encoding'] = 'gzip';
    await expect(externalRequest('https://provider.example.com')).rejects.toThrow('compressed');
  });
  it('rejects binary media instead of corrupting it into a text result', async () => {
    headers['content-type'] = 'image/png';
    await expect(externalRequest('https://provider.example.com')).rejects.toThrow('binary media');
  });
  it('accepts a matching MCP SSE reply and only the explicit MCP headers', async () => {
    endStream = false; // A matching reply must finish even if the server keeps SSE open.
    headers = { 'content-type': 'text/event-stream', 'mcp-session-id': 'server-session' };
    body = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' +
      'data: {"jsonrpc":"2.0","id":"rpc-1","result":{"tools":[]}}\n\n';
    const result = await externalRequest('https://provider.example.com/mcp', { method: 'POST', body: '{}', mcp: { id: 'rpc-1', sessionId: 'session', protocol: '2025-11-25', bearer: 'explicit-token' } });
    expect(result.body).toMatchObject({ id: 'rpc-1', result: { tools: [] } });
    expect(result.response.headers.get('mcp-session-id')).toBe('server-session');
    expect(socketOptions.headers.accept).toBe('application/json, text/event-stream');
    expect(socketOptions.headers.authorization).toBe('Bearer explicit-token');
    expect(socketOptions.headers['Mcp-Session-Id']).toBe('session');
    expect(socketOptions.headers['PAYMENT-SIGNATURE']).toBeUndefined();
  });
  it('does not parse unfinished events and handles CRLF/multiline data', () => {
    const part = 'data: {"id":"1",\r\ndata: "result":{"ok":true}}\r\n';
    expect(sseResponse(part, '1')).toBeUndefined();
    expect(sseResponse(part + '\r\n', '1')).toEqual({ id: '1', result: { ok: true } });
    expect(() => sseResponse('data: {"id":"request","method":"sampling/createMessage"}\n\n', '1')).toThrow('server-to-client');
  });
  it('rejects header injection and combining MCP with payment authorization before sending', async () => {
    await expect(externalRequest('https://provider.example.com/mcp', { mcp: { sessionId: 'a\r\nb' } })).rejects.toThrow('header');
    await expect(externalRequest('https://provider.example.com/mcp', { mcp: {}, signature: 'signed' })).rejects.toThrow('x402');
    expect(request).not.toHaveBeenCalled();
  });
});
