import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { forget, forgetService, memoryPath, recall, remember, saveService } from '../plugins/algoria/lib/memory.mjs';
import { editLedger, ledgerPath } from '../plugins/algoria/lib/services/state.mjs';

const home = await mkdtemp(join(tmpdir(), 'algoria-memory-'));
const cli = fileURLToPath(new URL('../plugins/algoria/bin/algoria.mjs', import.meta.url));
process.env.ALGORIA_HOME = home;
beforeEach(async () => { await rm(memoryPath(), { force: true }); await rm(ledgerPath(), { force: true }); });
afterAll(() => rm(home, { recursive: true, force: true }));

describe('local memory', () => {
  it('recalls empty state without creating wallets or files', async () => {
    expect(await recall()).toMatchObject({ notes: [], services: [], history: [] });
    await expect(stat(memoryPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(home, 'wallet.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists across CLI sessions, scopes project context and includes user preferences', async () => {
    execFileSync(process.execPath, [cli, 'memory', 'remember', '--scope', 'user', '--key', 'language', '--value', 'Turkish', '--json']);
    await remember('project:a', 'style', 'watercolour');
    await remember('project:b', 'style', 'photorealistic');
    const output = JSON.parse(execFileSync(process.execPath, [cli, 'memory', 'recall', '--scope', 'project:a', '--json'], { encoding: 'utf8' }));
    expect(output.notes.map((/** @type {any} */ n) => n.value).sort()).toEqual(['Turkish', 'watercolour']);
    expect((await stat(memoryPath())).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });
  it('updates a note in place and forgets only that note', async () => {
    await remember('user', 'style', 'old'); await remember('user', 'style', 'new');
    await remember('project:a', 'style', 'separate');
    expect((await recall()).notes).toHaveLength(2);
    expect(await forget('user', 'style')).toEqual({ removed: 1 });
    expect((await recall()).notes[0].value).toBe('separate');
  });
  it('keeps service IDs distinct across catalogs and supports removing bookmarks', async () => {
    await saveService({ source: 'bazaar', service: 'image', url: 'https://example.com/image' });
    await saveService({ source: 'other', service: 'image' });
    await saveService({ source: 'bazaar', service: 'image', note: 'preferred' });
    expect((await recall()).services).toHaveLength(2);
    expect(await forgetService('bazaar', 'image')).toEqual({ removed: 1 });
    expect((await recall()).services[0].source).toBe('other');
  });
  it.each(['https://example.com/file?token=secret', 'https://user:secret@example.com/', 'file:///tmp/image', 'https://example.com/#secret'])('rejects credential-bearing or unsafe bookmark %s', async (url) => {
    await expect(saveService({ source: 'other', service: 'image', url })).rejects.toThrow();
  });
  it('derives paid history without leaking input, URLs or credentials and never changes budgets', async () => {
    await editLedger((state) => {
      state.budgets.demo = { total: '100000', perCall: '100000', reservations: { paid: '100000' } };
      state.jobs.paid = { id: 'paid', service: 'image.generate', status: 'succeeded', phase: 'complete', budget: 'demo', offer: { amount: '100000' }, payment: { success: true }, token: 'secret-recovery', signature: 'secret-signature', body: 'secret-prompt', output: { url: 'https://media.test/?token=secret-url' } };
      state.jobs.uncertain = { id: 'uncertain', source: 'stellar8004', service: 'stellar8004:0:0', status: 'payment-uncertain', phase: 'uncertain', offer: { amount: '100000' } };
    });
    const before = await readFile(ledgerPath(), 'utf8');
    const result = await recall();
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(result.history.find((j) => j.id === 'paid')).toMatchObject({ charged: '0.0100000', recoverable: true });
    expect(result.history.find((j) => j.id === 'uncertain')).toMatchObject({ charged: null, requiresAttention: true, recoverable: false });
    expect(await readFile(ledgerPath(), 'utf8')).toBe(before);
  });
  it('filters recall, bounds results, and reports totals', async () => {
    await remember('user', 'style', 'blue image'); await remember('user', 'other', 'red image');
    expect(await recall({ query: 'IMAGE', limit: 1 })).toMatchObject({ totals: { notes: 2 } });
    expect((await recall({ query: 'IMAGE', limit: 1 })).notes).toHaveLength(1);
    await expect(recall({ limit: 0 })).rejects.toThrow();
  });
  it('preserves corrupted memory instead of replacing it', async () => {
    await writeFile(memoryPath(), 'broken');
    await expect(remember('user', 'style', 'blue')).rejects.toThrow();
    expect(await readFile(memoryPath(), 'utf8')).toBe('broken');
  });
  it('rejects unknown CLI options before writes', async () => {
    const result = spawnSync(process.execPath, [cli, 'memory', 'remember', '--scope', 'user', '--key', 'a', '--value', 'b', '--approve'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    await expect(stat(memoryPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
