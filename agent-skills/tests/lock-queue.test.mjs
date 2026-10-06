import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const home = await mkdtemp(join(tmpdir(), 'algoria-queue-'));
process.env.ALGORIA_HOME = home;
const { withLock } = await import('../plugins/algoria/lib/lock.mjs');
const { signAndPayTempo } = await import('../plugins/algoria/lib/services/tempo-signer.mjs');
afterAll(() => rm(home, { recursive: true, force: true }));
describe('cross-task wallet approval queue', () => {
  it('rejects expired queued purchases before key creation or faucet funding', async () => {
    const stages = /** @type {string[]} */ ([]);
    await expect(signAndPayTempo({ expiresAt: '2020-01-01' }, { fundTestnet: true,
      onStage: async stage => { stages.push(stage); } }, async () => { throw new Error('must not broadcast'); })).rejects.toThrow('Quote expired');
    expect(stages).toEqual(['queued-approval']);
  });
  it('waits for the active owner without overlapping signing actions', async () => {
    const order = /** @type {string[]} */ ([]);
    let started = /** @type {() => void} */ (() => {});
    const entered = new Promise(resolve => { started = () => resolve(null); });
    const first = withLock('wallet', async () => {
      order.push('first'); started();
      await new Promise(resolve => setTimeout(resolve, 60));
      order.push('first-done');
    });
    await entered;
    await withLock('wallet', async () => { order.push('second'); }, { waitMs: 1000 });
    await first;
    expect(order).toEqual(['first', 'first-done', 'second']);
  });
  it('times out without deleting even an ownerless crash lock', async () => {
    await mkdir(join(home, 'locks', 'crash'));
    await expect(withLock('crash', async () => {}, { waitMs: 10 })).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    await expect(withLock('crash', async () => {})).rejects.toThrow('operation locked');
  });
  it('cleans only its own acquired lock after failure', async () => {
    await expect(withLock('failure', async () => { throw new Error('denied'); })).rejects.toThrow('denied');
    expect(await withLock('failure', async () => 'ready')).toBe('ready');
    await expect(readFile(join(home, 'locks', 'failure', 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
