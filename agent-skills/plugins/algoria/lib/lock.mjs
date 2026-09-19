import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { algoriaHome } from './stellar/keystore.mjs';

/** Fail closed across processes; never expire a lock while its owner may sign.
 * A crash leaves an owner file for explicit recovery after checking that PID.
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} action
 * @returns {Promise<T>}
 */
export async function withLock(name, action) {
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('invalid lock name');
  const root = join(algoriaHome(), 'locks');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, name);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    throw new Error(`operation locked at ${path}. Retry after the running command finishes. If it crashed, check owner.json and remove this lock directory only after confirming its process has stopped.`);
  }
  try {
    await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    return await action();
  } finally {
    await rm(path, { recursive: true });
  }
}
