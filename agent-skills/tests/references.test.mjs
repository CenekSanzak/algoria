import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { uploadReference } from '../plugins/algoria/lib/services/references.mjs';
import { API_BASE } from '../plugins/algoria/lib/services/api.mjs';
const home=await mkdtemp(join(tmpdir(),'algoria-reference-'));
process.env.ALGORIA_HOME=home;
const photo=join(home,'photo.png');
const bytes=Buffer.alloc(24);bytes.set([137,80,78,71,13,10,26,10]);
await writeFile(photo,bytes);
const id='00000000-0000-4000-8000-000000000001';
afterEach(()=>vi.unstubAllGlobals());
afterAll(()=>rm(home,{recursive:true,force:true}));
it('saves upload identity before dispatch and retries the same bytes/token without payment',async()=>{
  /** @type {string[]} */ const tokens=[];
  let lose=true;
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>{
    const saved=JSON.parse(await readFile(join(home,'references',`${id}.json`),'utf8'));
    expect(saved.id).toBe(id);expect(new Headers(init.headers).has('PAYMENT-SIGNATURE')).toBe(false);
    expect(new Headers(init.headers).get('X-Recovery-Token')).toBe(saved.token);tokens.push(saved.token);
    expect(url).toBe(`${API_BASE}/v1/references/${id}`);expect(init.redirect).toBe('error');
    if(lose)throw new Error('lost response');
    return Response.json({reference_id:id,url:`${new URL(API_BASE).origin}/storage/v1/object/sign/outputs/references/${id}/${createHash('sha256').update(bytes).digest('hex')}.png?token=signed`});
  }));
  await expect(uploadReference(photo,id)).rejects.toThrow(id);
  expect((await stat(join(home,'references',`${id}.json`))).mode & 0o777).toBe(0o600);
  lose=false;await uploadReference(photo,id);expect(tokens[0]).toBe(tokens[1]);
  const changed=Buffer.from(bytes);changed[23]=1;await writeFile(photo,changed);
  await expect(uploadReference(photo,id)).rejects.toThrow('conflicts');
});
it('rejects invalid content before any network upload',async()=>{
  const request=vi.fn();vi.stubGlobal('fetch',request);
  const path=join(home,'not-an-image.png');await writeFile(path,'hello');
  await expect(uploadReference(path)).rejects.toThrow('PNG');expect(request).not.toHaveBeenCalled();
});
