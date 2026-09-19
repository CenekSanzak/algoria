import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { algoriaHome } from '../stellar/keystore.mjs';
import { withLock } from '../lock.mjs';
import { API_BASE, apiError, apiFetch, jobUrl } from './api.mjs';

/** Upload only a user-selected reference photo. Identity survives transport loss.
 * @param {string} path @param {string} [id]
 */
export async function uploadReference(path, id = randomUUID()) {
  jobUrl(id); // Shared UUID validation; no request is sent here.
  if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Reference must be at most 10 MB');
  const bytes = await readFile(path);
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Reference must be at most 10 MB');
  const type = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : undefined;
  if (!type) throw new Error('Reference must be PNG, JPEG or WebP');
  return withLock(`reference-${id}`, async () => {
    const directory = join(algoriaHome(), 'references');
    await mkdir(directory, {recursive:true,mode:0o700});
    const statePath = join(directory, `${id}.json`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    let state;
    try {state=JSON.parse(await readFile(statePath,'utf8'));}
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */(error).code !== 'ENOENT') throw error;
      state={id,digest,token:randomBytes(32).toString('base64url')};
      await writeFile(statePath,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});
    }
    if (state.id !== id || state.digest !== digest || !/^[A-Za-z0-9_-]{43}$/.test(state.token)) throw new Error('Reference identity conflicts with saved content');
    let result;
    try {result=await apiFetch(`${API_BASE}/v1/references/${id}`,{method:'POST',headers:{'content-type':type,'X-Recovery-Token':state.token},body:bytes},60000);}
    catch {throw new Error(`Reference ${id} saved. Repeat upload-reference with this --id and the same file; no payment was made.`);}
    if (!result.response.ok) throw apiError(result.response,result.body);
    if (result.body?.reference_id !== id || typeof result.body.url !== 'string') throw new Error('Reference response identity mismatch');
    const url=new URL(result.body.url);
    const expectedOrigin=new URL(API_BASE).origin;
    if (url.origin !== expectedOrigin || !url.pathname.startsWith(`/storage/v1/object/sign/outputs/references/${id}/${digest}.`) || !url.searchParams.has('token')) throw new Error('Untrusted reference URL');
    return result.body;
  });
}
