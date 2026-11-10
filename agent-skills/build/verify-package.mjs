// Clean-package and real-host installation smoke test. Everything is written to
// a new temporary directory; never reads or modifies the user's host profiles.
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { findHost } from '../plugins/algoria/lib/install.mjs';
const root = fileURLToPath(new URL('../plugins/algoria/', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'algoria-release-'));
const stage = join(temp, 'marketplace');
const plugin = join(stage, 'plugins', 'algoria');
await mkdir(plugin, { recursive: true });
/** @param {string} command @param {string[]} args @param {any} [options] */
function invoke(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, npm_config_cache: join(temp, 'npm-cache') }, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.error || result.stdout}`);
  return result.stdout;
}
const packed = JSON.parse(invoke('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root }))[0];
assert(!packed.files.some((/** @type {any} */ f) => /(^|\/)(node_modules|tests|\.env)(\/|$)/.test(f.path)));
for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) assert(packed.files.some((/** @type {any} */ f) => f.path === manifest));
invoke('tar', ['-xzf', join(temp, packed.filename), '--strip-components=1', '-C', plugin]);
const metadata = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
assert.equal(metadata.dependencies, undefined);
await mkdir(join(stage, '.claude-plugin'), { recursive: true });
await mkdir(join(stage, '.agents', 'plugins'), { recursive: true });
await writeFile(join(stage, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'algoria-skills', owner: { name: 'Algoria' }, plugins: [{ name: 'algoria', source: './plugins/algoria' }] }));
await writeFile(join(stage, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'algoria-skills', plugins: [{ name: 'algoria', source: { source: 'local', path: './plugins/algoria' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] }));
const reports = [];
/** @param {string} copy @param {NodeJS.ProcessEnv} env */
async function check(copy, env) {
  const bin = join(copy, 'bin', 'algoria.mjs');
  assert.equal(JSON.parse(await readFile(join(copy, 'package.json'), 'utf8')).version, metadata.version);
  assert.equal(await readFile(join(copy, 'lib/services/state.mjs'), 'utf8'), await readFile(join(plugin, 'lib/services/state.mjs'), 'utf8'));
  assert(invoke(process.execPath, [bin, 'pay', '--help'], { env }).includes('revoke'));
  const ready = JSON.parse(invoke(process.execPath, [bin, 'pay', 'readiness', '--json'], { env }));
  assert.equal(ready.permissionsEnabled, true);
  assert.equal(ready.realFundsSupported, false);
  // Actually load the shipped, dependency-free SDK, not a fixture or host SDK.
  invoke(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(join(copy, 'lib/services/tempo-sdk.mjs'))}); const s=await m.loadTempoSdk(); if(!s.preparePurchase||!s.Credential) throw Error('missing SDK');`], { env });
}
await check(plugin, { ...process.env, ALGORIA_HOME: join(temp, 'state-clean'), ALGORIA_TEMPO_SIGNER_APP: '' });
/** @param {string} folder */
async function installedCopies(folder) {
  const result = /** @type {string[]} */ ([]);
  /** @param {string} path */
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(path, entry.name));
      else if (entry.isFile() && entry.name === 'package.json') {
        try { if (JSON.parse(await readFile(join(path, entry.name), 'utf8')).name === 'algoria') result.push(path); } catch {}
      }
    }
  }
  await visit(folder); return result;
}
if (process.argv.includes('--hosts')) {
  for (const agent of /** @type {const} */ (['codex', 'claude'])) {
    const cli = findHost(agent);
    if (!cli) throw new Error(`${agent} CLI unavailable; not a verified installation`);
    const profile = join(temp, `${agent}-profile`);
    await mkdir(profile);
    const env = { ...process.env, CODEX_HOME: join(temp, 'codex-profile'), CLAUDE_CONFIG_DIR: join(temp, 'claude-profile'),
      ALGORIA_HOME: join(temp, `state-${agent}`), ALGORIA_TEMPO_SIGNER_APP: '' };
    invoke(process.execPath, [join(plugin, 'bin/algoria.mjs'), 'install', '--agent', agent, '--cli', cli, '--source', stage, '--json'], { env, cwd: stage });
    const copies = await installedCopies(profile);
    assert(copies.length > 0, `${agent} reported install but no installed package found`);
    for (const copy of copies) await check(copy, env);
    reports.push({ agent, installedCopies: copies, commandChecks: 'passed', livePurchase: 'not-run' });
  }
}
console.log(JSON.stringify({ version: metadata.version, package: join(temp, packed.filename), temp,
  files: packed.entryCount, dependencyFree: true, cleanPackageChecks: 'passed', hosts: reports,
  caveat: 'CLI installation and installed runtime only; no host conversation, biometric or paid provider test.' }, null, 2));
