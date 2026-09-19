import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findHost, installCommands, installPlugin, validateRef } from '../plugins/algoria/lib/install.mjs';

const temp = await mkdtemp(join(tmpdir(), 'algoria installer ü '));
const fake = join(temp, 'host cli');
const log = join(temp, 'calls.jsonl');
const cli = fileURLToPath(new URL('../plugins/algoria/bin/algoria.mjs', import.meta.url));
await writeFile(fake, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.ALGORIA_INSTALL_TEST_LOG, JSON.stringify(args)+'\\n');
if(args.includes('--help')) {console.log('Plugin commands supported');process.exit(0);}
if(process.env.ALGORIA_INSTALL_TEST_FAIL && args.includes(process.env.ALGORIA_INSTALL_TEST_FAIL)) {console.error('host rejected install');process.exit(7);}
console.log('Host operation completed');
`, { mode: 0o755 });
beforeEach(async () => { await rm(log, { force: true }); });
afterAll(() => rm(temp, { recursive: true, force: true }));
/** @param {string[]} args @param {Record<string, string>} [env] */
function invoke(args, env = {}) {
  return spawnSync(process.execPath, [cli, 'install', ...args], {
    encoding: 'utf8', cwd: temp,
    env: { ...process.env, ALGORIA_INSTALL_TEST_LOG: log, ...env }
  });
}
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

describe('plugin installer', () => {
  it('installs Codex via argv from any directory, with spaces in the CLI path and an explicit branch', async () => {
    const result = invoke(['--agent', 'codex', '--cli', fake, '--ref', 'codex/stellar8004-testnet-services', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ installed: true, agent: 'codex', ref: 'codex/stellar8004-testnet-services', plugin: 'algoria@algoria-skills' });
    expect(await calls()).toEqual([
      ['plugin', 'marketplace', 'add', '--help'], ['plugin', 'add', '--help'],
      ['plugin', 'marketplace', 'add', 'CenekSanzak/algoria', '--ref', 'codex/stellar8004-testnet-services'],
      ['plugin', 'add', 'algoria@algoria-skills']
    ]);
    expect(result.stderr).toContain('Host operation completed');
  });
  it('installs Claude at user scope with its supported ref syntax', async () => {
    const result = invoke(['--agent', 'claude', '--cli', fake, '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ installed: true, agent: 'claude', ref: 'main' });
    expect((await calls()).slice(-2)).toEqual([
      ['plugin', 'marketplace', 'add', 'CenekSanzak/algoria@main', '--scope', 'user'],
      ['plugin', 'install', 'algoria@algoria-skills', '--scope', 'user']
    ]);
  });
  it('does not install or print success after a marketplace failure', async () => {
    const result = invoke(['--agent', 'claude', '--cli', fake, '--json'], { ALGORIA_INSTALL_TEST_FAIL: 'marketplace' });
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('host rejected install');
    expect((await calls()).filter((a) => a.includes('install') && !a.includes('--help'))).toHaveLength(0);
  });
  it('does not report success when plugin installation fails', () => {
    const result = invoke(['--agent', 'claude', '--cli', fake, '--json'], { ALGORIA_INSTALL_TEST_FAIL: 'install' });
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('host rejected install');
  });
  it('previews without starting any host process', async () => {
    const result = invoke(['--agent', 'codex', '--cli', fake, '--dry-run', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, cliFound: true, ref: 'main' });
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('shows help and never touches the host', async () => {
    expect(invoke([]).stdout).toContain('--agent');
    expect(invoke(['--help']).status).toBe(0);
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['--agent', 'other'], ['--agent'], ['--agent', 'codex', '--ref'],
    ['--agent', 'codex', '--ref', 'main; touch /tmp/unwanted'],
    ['--agent', 'codex', '--ref=--upload-pack=bad'],
    ['--agent', 'codex', '--dry-run=false'], ['--agent', 'codex', '--unknown'],
    ['--agent', 'codex', '--cli', 'relative/path']
  ])('rejects invalid options before any host call: %s', async (...args) => {
    const result = invoke(args);
    expect(result.status).toBe(1);
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('detects the desktop bundled Codex CLI without PATH and prefers a working PATH executable', () => {
    const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
    const exists = (/** @type {string} */ p) => p === bundled;
    expect(findHost('codex', { platform: 'darwin', path: '', home: '/home/test', exists })).toBe(bundled);
    expect(findHost('codex', { platform: 'darwin', path: '/opt/bin', exists: (p) => p === '/opt/bin/codex' || exists(p) })).toBe('/opt/bin/codex');
    expect(findHost('claude', { platform: 'darwin', path: '', exists })).toBeNull();
    expect(findHost('codex', { platform: 'linux', path: '', exists })).toBeNull();
  });
  it('fails capability checks before adding a marketplace', () => {
    const execute = vi.fn(() => { throw new Error('host too old'); });
    expect(() => installPlugin('codex', '/cli', 'main', execute)).toThrow('host too old');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(['main', 'v0.5.1', 'codex/stellar8004-testnet-services', 'a'.repeat(40)])('accepts ref %s', (ref) => {
    expect(validateRef(ref)).toBe(ref);
    expect(installCommands('codex', ref)[0].at(-1)).toBe(ref);
  });
  it.each(['../main', 'foo//bar', 'main.lock', 'main/', '.hidden', 'main..next', 'main$(id)', 'main@{1}', 'foo/.hidden', 'foo/bar.'])('rejects ref %s', (ref) => {
    expect(() => validateRef(ref)).toThrow('invalid --ref');
  });
});
