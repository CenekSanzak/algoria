import type { Artifacts } from './artifacts.ts';
import { hash, HttpError, readBytes, validId, validToken } from './security.ts';
import type { SocialStore } from './social-store.ts';

export async function uploadReference(
  request: Request,
  id: string,
  repository: Pick<SocialStore, 'reserveReference'>,
  artifacts: Artifacts,
) {
  const token = request.headers.get('X-Recovery-Token') ?? '';
  if (!validId(id) || !validToken(token)) throw new HttpError(400, 'request-identity-required');
  const type = request.headers.get('content-type')?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type ?? '')) {
    throw new HttpError(415, 'unsupported-reference-type');
  }
  const bytes = await readBytes(request, 10 * 1024 * 1024);
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.subarray(start, end));
  const valid = type === 'image/png'
    ? bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    : type === 'image/jpeg'
    ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (!valid) throw new HttpError(400, 'invalid-reference-image');
  const contentHash = await hash(bytes);
  const extension = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : 'webp';
  const path = `references/${id}/${contentHash}.${extension}`;
  try {
    await repository.reserveReference(id, await hash(token), contentHash, path);
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    if (message.includes('reference-not-found')) throw new HttpError(404, 'reference-not-found');
    if (message.includes('reference-conflict')) throw new HttpError(409, 'reference-conflict');
    if (message.includes('reference-capacity-exhausted')) {
      throw new HttpError(429, 'reference-capacity-exhausted');
    }
    throw e;
  }
  await artifacts.put(path, bytes, type!);
  return { reference_id: id, url: await artifacts.signedUrl(path), content_type: type, url_expires_in: 3600 };
}
