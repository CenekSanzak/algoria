import { IMAGE_SERVICE, normalizeInput, type Service, type ServiceInput } from './catalog.ts';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message = code) {
    super(message);
  }
}

export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const size = Number(request.headers.get('content-length'));
  if (size > limit) throw new HttpError(413, 'body-too-large');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, 'body-too-large');
      }
      chunks.push(value);
    }
  } finally {
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

export async function inputBody(request: Request, service: Service = IMAGE_SERVICE): Promise<ServiceInput> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json-required');
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBytes(request, 32768)));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid-json');
  }
  try {
    return normalizeInput(service, body);
  } catch (error) {
    throw new HttpError(400, 'invalid-input', error instanceof Error ? error.message : 'Invalid input.');
  }
}

export const validId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export const validToken = (token: string) => /^[A-Za-z0-9_-]{43,128}$/.test(token);
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function tokenMatches(token: string, expected: string): Promise<boolean> {
  if (!validToken(token)) return false;
  const actual = await hash(token);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return diff === 0;
}
