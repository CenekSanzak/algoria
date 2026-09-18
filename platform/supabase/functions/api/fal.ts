// Queue and signatures: https://fal.ai/docs/documentation/model-apis/inference/
// Model schema: https://fal.ai/models/google/nano-banana-2-lite/api
export const FAL_MODEL = 'google/nano-banana-2-lite';
const QUEUE_URL = `https://queue.fal.run/${FAL_MODEL}`;
const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

export interface FalImage {
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

export type FalPollResult = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  images?: FalImage[];
  error?: string;
};

export class FalSubmissionError extends Error {
  constructor(
    message: string,
    public readonly outcome: 'rejected' | 'uncertain',
  ) {
    super(message);
    this.name = 'FalSubmissionError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid fal response');
  }
  return value as Record<string, unknown>;
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('fal response exceeds size limit');
  }
  if (!response.body) throw new Error('Empty fal response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error('fal response exceeds size limit');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function json(response: Response, limit = MAX_JSON_BYTES) {
  return record(JSON.parse(new TextDecoder().decode(await readBytes(response, limit))));
}

async function boundedFetch<T>(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    return await consume(await fetch(url, { ...init, signal }));
  } finally {
    clearTimeout(timer);
  }
}

function providerError(data: Record<string, unknown>): string {
  // Provider messages may contain input. Do not pass them through to public responses.
  const kind = data.error_type;
  return typeof kind === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(kind)
    ? `fal generation failed (${kind})`
    : 'fal generation failed';
}

export class FalProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey.trim()) throw new Error('FAL_KEY is required');
  }

  async submit(input: { prompt: string }, webhookUrl: string): Promise<{ requestId: string }> {
    let callback: URL;
    try {
      callback = new URL(webhookUrl);
      if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
        throw new Error('Invalid callback URL');
      }
      if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
        throw new Error('Invalid prompt');
      }
    } catch {
      throw new FalSubmissionError('Invalid fal submission configuration', 'rejected');
    }
    const url = new URL(QUEUE_URL);
    url.searchParams.set('fal_webhook', callback.href);
    try {
      return await boundedFetch(
        url,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Key ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            prompt: input.prompt,
            num_images: 1,
            aspect_ratio: '1:1',
            output_format: 'png',
            limit_generations: true,
            sync_mode: false,
            // This model is fixed at 1K. Omitting thinking_level disables thinking.
          }),
        },
        15_000,
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel();
            const rejected = response.status >= 400 && response.status < 500 &&
              response.status !== 408 && response.status !== 425;
            throw new FalSubmissionError(
              `fal submission returned HTTP ${response.status}`,
              rejected ? 'rejected' : 'uncertain',
            );
          }
          const data = await json(response);
          if (typeof data.request_id !== 'string' || !REQUEST_ID.test(data.request_id)) {
            throw new FalSubmissionError('fal accepted request without a usable ID', 'uncertain');
          }
          return { requestId: data.request_id };
        },
      );
    } catch (error) {
      if (error instanceof FalSubmissionError) throw error;
      // A network/body error may occur after acceptance. Never resubmit automatically.
      throw new FalSubmissionError('fal submission outcome is unknown', 'uncertain');
    }
  }

  async poll(requestId: string, signal?: AbortSignal): Promise<FalPollResult> {
    if (!REQUEST_ID.test(requestId)) throw new Error('Invalid fal request ID');
    const base = `${QUEUE_URL}/requests/${requestId}`;
    const init = { redirect: 'error', signal, headers: { authorization: `Key ${this.apiKey}` } } as const;
    return await boundedFetch(`${base}/status`, init, 8_000, async (response) => {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`fal status unavailable (HTTP ${response.status})`);
      }
      const data = await json(response);
      if (data.status === 'IN_QUEUE') return { status: 'queued' };
      if (data.status === 'IN_PROGRESS') return { status: 'running' };
      if (data.status !== 'COMPLETED') throw new Error('Unknown fal queue status');
      // COMPLETED includes failed executions; it does not by itself mean success.
      if (data.error != null || data.error_type != null) {
        return { status: 'failed', error: providerError(data) };
      }
      return await boundedFetch(base, init, 8_000, async (result) => {
        if (!result.ok) {
          await result.body?.cancel();
          if (result.status === 400 || result.status === 422) {
            return { status: 'failed', error: 'fal rejected generation input' };
          }
          // Transport/auth/expired-result errors are not proof the generation failed.
          throw new Error(`fal result unavailable (HTTP ${result.status})`);
        }
        const output = await json(result);
        if (output.error != null || output.error_type != null) {
          return { status: 'failed', error: providerError(output) };
        }
        if (!Array.isArray(output.images) || output.images.length !== 1) {
          throw new Error('fal returned an unexpected image count');
        }
        const source = record(output.images[0]);
        if (typeof source.url !== 'string') throw new Error('fal image has no URL');
        trustedImageUrl(source.url);
        const image: FalImage = { url: source.url };
        if (typeof source.content_type === 'string') image.content_type = source.content_type;
        for (const dimension of ['width', 'height'] as const) {
          const value = source[dimension];
          if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
            image[dimension] = value;
          }
        }
        return { status: 'succeeded', images: [image] };
      });
    });
  }

  verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<boolean> {
    return verifyWebhook(rawBody, headers);
  }
}

let keyCache: { expires: number; keys: CryptoKey[] } | undefined;
let keyFetch: Promise<CryptoKey[]> | undefined;

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid JWKS key');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
}

async function webhookKeys(): Promise<CryptoKey[]> {
  if (keyCache && keyCache.expires > Date.now()) return keyCache.keys;
  if (keyFetch) return await keyFetch;
  keyFetch = boundedFetch(JWKS_URL, { redirect: 'error' }, 5_000, async (response) => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('fal signing keys unavailable');
    }
    const data = await json(response, 64 * 1024);
    if (!Array.isArray(data.keys) || data.keys.length > 16) throw new Error('Invalid fal JWKS');
    const keys: CryptoKey[] = [];
    for (const entry of data.keys) {
      try {
        const key = record(entry);
        if (
          typeof key.x !== 'string' || (key.kty != null && key.kty !== 'OKP') ||
          (key.crv != null && key.crv !== 'Ed25519') || (key.use != null && key.use !== 'sig')
        ) continue;
        const raw = decodeBase64Url(key.x);
        if (raw.length !== 32) continue;
        keys.push(await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']));
      } catch {
        // Key rotation may expose other key types alongside Ed25519.
      }
    }
    if (!keys.length) throw new Error('No usable fal signing keys');
    keyCache = { keys, expires: Date.now() + 60 * 60 * 1000 };
    return keys;
  });
  try {
    return await keyFetch;
  } finally {
    keyFetch = undefined;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Verify raw bytes before parsing. Callers must still deduplicate delivery by job. */
export async function verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<boolean> {
  const requestId = headers.get('x-fal-webhook-request-id');
  const userId = headers.get('x-fal-webhook-user-id');
  const timestamp = headers.get('x-fal-webhook-timestamp');
  const signature = headers.get('x-fal-webhook-signature');
  if (
    rawBody.length > MAX_JSON_BYTES || !requestId || !userId || !timestamp || !signature ||
    requestId.length > 256 || userId.length > 256 || /[\r\n]/.test(requestId + userId) ||
    !/^\d{1,12}$/.test(timestamp) || !/^[a-fA-F0-9]{128}$/.test(signature) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300
  ) return false;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(rawBody)));
    const message = encoder.encode([requestId, userId, timestamp, hex(digest)].join('\n'));
    const sig = Uint8Array.from(signature.match(/.{2}/g)!, (byte) => parseInt(byte, 16));
    for (const key of await webhookKeys()) {
      if (await crypto.subtle.verify('Ed25519', key, sig, message)) return true;
    }
  } catch {
    // Missing keys or unsupported crypto fail closed; fal can retry its delivery.
  }
  return false;
}

/** Parse only after verification. The queue, not this payload, is the source of results. */
export function parseWebhook(rawBody: Uint8Array): { requestId: string; status: 'OK' | 'ERROR' } {
  if (rawBody.length > MAX_JSON_BYTES) throw new Error('fal webhook is too large');
  const payload = record(JSON.parse(new TextDecoder().decode(rawBody)));
  if (
    typeof payload.request_id !== 'string' || !REQUEST_ID.test(payload.request_id) ||
    (payload.status !== 'OK' && payload.status !== 'ERROR')
  ) throw new Error('Invalid fal webhook');
  return { requestId: payload.request_id, status: payload.status };
}

function trustedImageUrl(value: string): URL {
  const url = new URL(value);
  // Shared Google storage is limited to fal's documented bucket, not all GCS.
  const falHost = url.hostname === 'fal.media' || /^v\d+[a-z]?\.fal\.media$/.test(url.hostname);
  const falBucket = url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/');
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
    (!falHost && !falBucket)
  ) throw new Error('Untrusted fal image URL');
  return url;
}

function hasImageSignature(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return type === 'image/webp' && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}

export async function downloadImage(
  image: FalImage,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let url = trustedImageUrl(image.url);
  const deadline = Date.now() + 20_000;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('fal image download timed out');
    const result = await boundedFetch<{ redirect: URL } | { bytes: Uint8Array; contentType: string }>(
      url,
      { redirect: 'manual', signal },
      remaining,
      async (response) => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 3) throw new Error('Invalid fal image redirect');
          return { redirect: trustedImageUrl(new URL(location, url).href) };
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`fal image unavailable (HTTP ${response.status})`);
        }
        const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!contentType || !['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
          await response.body?.cancel();
          throw new Error('Unsupported fal image type');
        }
        const bytes = await readBytes(response, MAX_IMAGE_BYTES);
        if (!hasImageSignature(bytes, contentType)) throw new Error('Invalid fal image bytes');
        return { bytes, contentType };
      },
    );
    if ('redirect' in result) url = result.redirect;
    else return result;
  }
  throw new Error('Too many fal image redirects');
}
