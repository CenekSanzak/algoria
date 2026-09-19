// Queue and signatures: https://fal.ai/docs/documentation/model-apis/inference/
// Model schema: https://fal.ai/models/google/nano-banana-2-lite/api
export const FAL_MODEL = 'google/nano-banana-2-lite';
const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MODEL_PATH = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/;
const encoder = new TextEncoder();

export type FalTarget = {
  model: string;
  queuePath: string;
  output: 'images' | 'audio' | 'video' | 'video_url' | 'call';
};

export interface FalMediaFile {
  url: string;
  content_type?: string;
  file_size?: number;
  duration?: number;
  width?: number;
  height?: number;
}

export type FalImage = FalMediaFile;

export type FalPollResult = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  images?: FalImage[];
  audio?: FalMediaFile;
  video?: FalMediaFile;
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

function resolvedTarget(target?: FalTarget): FalTarget {
  if (!target) return { model: FAL_MODEL, queuePath: FAL_MODEL, output: 'images' };
  if (
    ![target.model, target.queuePath].every((path) =>
      typeof path === 'string' && path.length <= 256 && MODEL_PATH.test(path)
    ) || !['images', 'audio', 'video', 'video_url'].includes(target.output)
  ) throw new Error('Invalid fal target');
  return target;
}

function mediaFile(value: unknown, kind: 'image' | 'audio' | 'video'): FalMediaFile {
  const source = record(value);
  if (typeof source.url !== 'string') throw new Error(`fal ${kind} has no URL`);
  trustedMediaUrl(source.url, kind);
  const file: FalMediaFile = { url: source.url };
  if (typeof source.content_type === 'string') file.content_type = source.content_type;
  for (const dimension of ['width', 'height'] as const) {
    const size = source[dimension];
    if (typeof size === 'number' && Number.isSafeInteger(size) && size > 0) file[dimension] = size;
  }
  if (
    typeof source.file_size === 'number' && Number.isSafeInteger(source.file_size) &&
    source.file_size >= 0
  ) file.file_size = source.file_size;
  if (typeof source.duration === 'number' && Number.isFinite(source.duration) && source.duration >= 0) {
    file.duration = source.duration;
  }
  return file;
}

export class FalProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey.trim()) throw new Error('FAL_KEY is required');
  }

  async submit(
    input: Record<string, unknown>,
    webhookUrl: string,
    target?: FalTarget,
  ): Promise<{ requestId: string }> {
    let callback: URL;
    let endpoint: FalTarget;
    let body: string;
    try {
      endpoint = resolvedTarget(target);
      record(input);
      callback = new URL(webhookUrl);
      if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
        throw new Error('Invalid callback URL');
      }
      if (!target && (typeof input.prompt !== 'string' || !input.prompt.trim())) {
        throw new Error('Invalid prompt');
      }
      body = JSON.stringify(
        target ? input : {
          prompt: input.prompt,
          num_images: 1,
          aspect_ratio: '1:1',
          output_format: 'png',
          limit_generations: true,
          sync_mode: false,
          // This model is fixed at 1K. Omitting thinking_level disables thinking.
        },
      );
    } catch {
      throw new FalSubmissionError('Invalid fal submission configuration', 'rejected');
    }
    const url = new URL(`https://queue.fal.run/${endpoint.model}`);
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
          body,
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

  async poll(requestId: string, signal?: AbortSignal, target?: FalTarget): Promise<FalPollResult> {
    if (!REQUEST_ID.test(requestId)) throw new Error('Invalid fal request ID');
    const endpoint = resolvedTarget(target);
    const base = `https://queue.fal.run/${endpoint.queuePath}/requests/${requestId}`;
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
        if (endpoint.output === 'audio') {
          return { status: 'succeeded', audio: mediaFile(output.audio, 'audio') };
        }
        if (endpoint.output === 'video') {
          return { status: 'succeeded', video: mediaFile(output.video, 'video') };
        }
        if (endpoint.output === 'video_url') {
          return { status: 'succeeded', video: mediaFile({ url: output.video_url }, 'video') };
        }
        if (!Array.isArray(output.images) || output.images.length !== 1) {
          throw new Error('fal returned an unexpected image count');
        }
        return { status: 'succeeded', images: [mediaFile(output.images[0], 'image')] };
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

function trustedMediaUrl(value: string, kind: 'image' | 'audio' | 'video'): URL {
  const url = new URL(value);
  // Shared Google storage is limited to fal's documented bucket, not all GCS.
  const falHost = url.hostname === 'fal.media' || /^v\d+[a-z]?\.fal\.media$/.test(url.hostname);
  const falBucket = url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/');
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
    (!falHost && !falBucket)
  ) throw new Error(`Untrusted fal ${kind} URL`);
  return url;
}

function hasImageSignature(bytes: Uint8Array, type: string): boolean {
  if (type === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return type === 'image/webp' && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
}

function hasAudioSignature(bytes: Uint8Array, type: string): boolean {
  if (type === 'audio/wav') {
    return new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WAVE';
  }
  if (type !== 'audio/mpeg' || bytes.length < 4) return false;
  // ID3v2 header, or MPEG audio frame sync with non-reserved version/layer/rate fields.
  if (bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    return bytes.length >= 10 && [2, 3, 4].includes(bytes[3]) && bytes[4] !== 255 &&
      bytes.slice(6, 10).every((byte) => byte < 128);
  }
  return bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 &&
    (bytes[1] & 0x06) !== 0 && (bytes[2] & 0xf0) !== 0 && (bytes[2] & 0xf0) !== 0xf0 &&
    (bytes[2] & 0x0c) !== 0x0c;
}

function hasVideoSignature(bytes: Uint8Array, type: string): boolean {
  if (type !== 'video/mp4' || bytes.length < 16) return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return boxSize >= 16 && boxSize <= bytes.length &&
    new TextDecoder().decode(bytes.slice(4, 8)) === 'ftyp';
}

/** Duration from the downloaded container, never from provider-reported metadata. */
export function mediaDuration(bytes: Uint8Array, contentType: string): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => new TextDecoder().decode(bytes.subarray(offset, offset + 4));
  if (contentType === 'audio/wav' && hasAudioSignature(bytes, contentType)) {
    const end = view.getUint32(4, true) + 8;
    if (end < 12 || end > bytes.length) return undefined;
    let byteRate: number | undefined;
    let blockAlign: number | undefined;
    let dataSize = 0;
    let offset = 12;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (size > end - start) return undefined;
      if (tag(offset) === 'fmt ') {
        if (byteRate !== undefined || size < 16) return undefined;
        const format = view.getUint16(start, true);
        const channels = view.getUint16(start + 2, true);
        const sampleRate = view.getUint32(start + 4, true);
        byteRate = view.getUint32(start + 8, true);
        blockAlign = view.getUint16(start + 12, true);
        const bits = view.getUint16(start + 14, true);
        // Uncompressed PCM/IEEE float have an exact duration from the data length.
        if (
          ![1, 3].includes(format) || channels === 0 || sampleRate === 0 || bits === 0 ||
          bits % 8 !== 0 || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign
        ) return undefined;
      } else if (tag(offset) === 'data') {
        dataSize += size;
      }
      offset = start + size + (size % 2);
    }
    if (offset !== end || !byteRate || !blockAlign || !dataSize || dataSize % blockAlign !== 0) {
      return undefined;
    }
    return dataSize / byteRate;
  }
  if (contentType !== 'video/mp4' || !hasVideoSignature(bytes, contentType)) return undefined;

  type Box = { type: string; start: number; end: number };
  function boxes(start: number, end: number): Box[] | undefined {
    const found: Box[] = [];
    for (let offset = start; offset < end;) {
      if (end - offset < 8) return undefined;
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (end - offset < 16) return undefined;
        const extended = view.getBigUint64(offset + 8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - offset;
      if (size < header || size > end - offset) return undefined;
      found.push({ type: tag(offset + 4), start: offset + header, end: offset + size });
      // A bounded download should not create an unbounded number of metadata objects.
      if (found.length > 4096) return undefined;
      offset += size;
    }
    return found;
  }
  const moov = boxes(0, bytes.length)?.filter((box) => box.type === 'moov');
  if (moov?.length !== 1) return undefined;
  const mvhd = boxes(moov[0].start, moov[0].end)?.filter((box) => box.type === 'mvhd');
  if (mvhd?.length !== 1) return undefined;
  const { start, end } = mvhd[0];
  if (end - start < 20) return undefined;
  const version = bytes[start];
  let timescale: number;
  let ticks: number;
  if (version === 0) {
    timescale = view.getUint32(start + 12);
    ticks = view.getUint32(start + 16);
    if (ticks === 0xffffffff) return undefined;
  } else if (version === 1) {
    if (end - start < 32) return undefined;
    timescale = view.getUint32(start + 20);
    const duration = view.getBigUint64(start + 24);
    if (duration > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    ticks = Number(duration);
  } else return undefined;
  return timescale > 0 && ticks > 0 ? ticks / timescale : undefined;
}

type MediaKind = 'image' | 'audio' | 'video';
type DownloadedMedia = { bytes: Uint8Array; contentType: string; duration?: number };

function mediaContentType(value: string | null, kind: MediaKind): string | undefined {
  const type = value?.split(';')[0].trim().toLowerCase();
  if (kind === 'image') {
    return type && ['image/png', 'image/jpeg', 'image/webp'].includes(type) ? type : undefined;
  }
  // FFmpeg compose serves MP4 files as generic binary. Accept that MIME only
  // from the trusted media hosts; the bounded body still must pass MP4 checks.
  if (kind === 'video') {
    return type === 'video/mp4' || type === 'application/octet-stream' ? 'video/mp4' : undefined;
  }
  if (type && ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(type)) return 'audio/wav';
  if (type && ['audio/mpeg', 'audio/mp3'].includes(type)) return 'audio/mpeg';
}

async function downloadMedia(
  file: FalMediaFile,
  kind: MediaKind,
  limit: number,
  signature: (bytes: Uint8Array, type: string) => boolean,
  signal?: AbortSignal,
): Promise<DownloadedMedia> {
  let url = trustedMediaUrl(file.url, kind);
  const deadline = Date.now() + 20_000;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`fal ${kind} download timed out`);
    const result = await boundedFetch<{ redirect: URL } | DownloadedMedia>(
      url,
      { redirect: 'manual', signal },
      remaining,
      async (response) => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 3) throw new Error(`Invalid fal ${kind} redirect`);
          return { redirect: trustedMediaUrl(new URL(location, url).href, kind) };
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`fal ${kind} unavailable (HTTP ${response.status})`);
        }
        const contentType = mediaContentType(response.headers.get('content-type'), kind);
        if (!contentType) {
          await response.body?.cancel();
          throw new Error(`Unsupported fal ${kind} type`);
        }
        const bytes = await readBytes(response, limit);
        if (!signature(bytes, contentType)) throw new Error(`Invalid fal ${kind} bytes`);
        const duration = mediaDuration(bytes, contentType);
        return { bytes, contentType, ...(duration === undefined ? {} : { duration }) };
      },
    );
    if ('redirect' in result) url = result.redirect;
    else return result;
  }
  throw new Error(`Too many fal ${kind} redirects`);
}

export function downloadImage(image: FalImage, signal?: AbortSignal) {
  return downloadMedia(image, 'image', MAX_IMAGE_BYTES, hasImageSignature, signal);
}

export function downloadAudio(audio: FalMediaFile, signal?: AbortSignal) {
  return downloadMedia(audio, 'audio', MAX_AUDIO_BYTES, hasAudioSignature, signal);
}

export function downloadVideo(video: FalMediaFile, signal?: AbortSignal) {
  return downloadMedia(video, 'video', MAX_VIDEO_BYTES, hasVideoSignature, signal);
}
