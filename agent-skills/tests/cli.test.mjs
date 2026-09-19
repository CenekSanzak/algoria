import { afterAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isMain } from '../plugins/algoria/lib/cli.mjs';

const temp = await mkdtemp(join(tmpdir(), 'algoria CLI ü # '));
const plugin = join(temp, 'plugin');
await cp(fileURLToPath(new URL('../plugins/algoria', import.meta.url)), plugin, { recursive: true });
afterAll(() => rm(temp, { recursive: true, force: true }));

describe('installed entrypoints', () => {
  for (const [group, script] of [['wallet', 'wallet'], ['topup', 'topup'], ['discover', 'discover'], ['pay', 'pay'], ['memory', 'memory'], ['mcp', 'mcp']]) {
    it(`runs ${group} from a path with spaces, Unicode and a hash without node_modules`, () => {
      const standalone = execFileSync(process.execPath, [join(plugin, `skills/algoria-${group}/scripts/${script}.mjs`), '--help'], { encoding: 'utf8', cwd: temp });
      const dispatcher = execFileSync(process.execPath, [join(plugin, 'bin/algoria.mjs'), group, '--help'], { encoding: 'utf8', cwd: temp });
      expect(standalone.length).toBeGreaterThan(100);
      expect(dispatcher).toBe(standalone);
    });
  }
  it('recognizes symlinked direct entrypoints and leaves imports inert', async () => {
    const target = join(plugin, 'skills/algoria-wallet/scripts/wallet.mjs');
    const link = join(temp, 'wallet-link');
    await symlink(target, link);
    expect(isMain(pathToFileURL(target).href, link)).toBe(true);
    expect(isMain(pathToFileURL(target).href, join(temp, 'absent'))).toBe(false);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(target).href)});`], { encoding: 'utf8' });
    expect(result).toBe('');
  });
});
