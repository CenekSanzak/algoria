import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';

// Resolve and pin public IPv4 addresses inside the connector, never check then
// ask fetch to resolve again. IPv6-only services are currently unsupported.
const blocked = new BlockList();
for (const [network, bits] of /** @type {[string, number][]} */ ([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
])) blocked.addSubnet(network, bits, 'ipv4');

/** @param {string} value */
export function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('invalid external URL');
  const url = new URL(value);
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || isIP(host) || host.startsWith('[') ||
      !host.includes('.') || /\.(localhost|local|internal|test|invalid|example)$/.test(host)) {
    throw new Error('external services require a public HTTPS hostname and default port');
  }
  return url;
}

/** Exposed for boundary tests; the same validated addresses go to the socket.
 * @param {string} hostname
 */
export async function publicAddresses(hostname) {
  const addresses = await lookup(hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address, family }) => family !== 4 || !isIP(address) || blocked.check(address, 'ipv4'))) {
    throw new Error('external host resolves to a private or reserved address');
  }
  return addresses;
}

/** Bounded HTTPS, no redirects, cookies, auth, recovery tokens, proxies or retries.
 * @param {string} value
 * @param {{method?: 'GET' | 'POST', body?: string, signature?: string, maxBytes?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{response: Response, body: any}>}
 */
export async function externalRequest(value, { method = 'GET', body, signature, maxBytes = 2_097_152, timeoutMs = 30_000 } = {}) {
  const url = externalUrl(value);
  return new Promise((resolve, reject) => {
    const headers = { accept: 'application/json, text/plain', 'accept-encoding': 'identity',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(signature ? { 'PAYMENT-SIGNATURE': signature } : {}) };
    const req = request(url, { method, headers, agent: false, family: 4,
      lookup: (hostname, options, callback) => {
        void publicAddresses(hostname).then((addresses) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, 4);
        }).catch(() => callback(new Error('external DNS rejected'), ''));
      }
    }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) { incoming.destroy(); reject(new Error('external redirects are not permitted')); return; }
      if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
        incoming.destroy(); reject(new Error('compressed external responses are not supported')); return;
      }
      const contentType = incoming.headers['content-type'];
      if (contentType && !/^text\//i.test(contentType) && !/^application\/(?:[\w.-]+\+)?json\b/i.test(contentType)) {
        incoming.destroy(); reject(new Error('external responses must be JSON or text, not binary media')); return;
      }
      /** @type {Buffer[]} */ const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { reject(new Error('external response too large')); incoming.destroy(); return; }
        chunks.push(chunk);
      });
      incoming.on('error', () => reject(new Error('external response unavailable or too large')));
      incoming.on('end', () => {
        const resultHeaders = new Headers();
        for (const name of ['content-type', 'payment-required', 'payment-response']) {
          const v = incoming.headers[name];
          if (typeof v === 'string') resultHeaders.set(name, v);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let result;
        try { result = JSON.parse(text); } catch { result = text; }
        resolve({ response: new Response(null, { status, headers: resultHeaders }), body: result });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('external request timed out')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new Error('external request failed; do not automatically repeat a paid call')));
    req.end(body);
  });
}
