import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { emit, isMain, parseArgs, run } from './cli.mjs';

export const MARKETPLACE = 'algoria-skills';
export const REPOSITORY = 'CenekSanzak/algoria';
const PLUGIN = `algoria@${MARKETPLACE}`;
const USAGE = `algoria install — install the Algoria plugin for your coding agent

  npx algoria@latest install --agent codex
  npx algoria@latest install --agent claude
  npx algoria@latest install --agent codex --ref codex/stellar8004-testnet-services

Options:
  --agent codex|claude   required; install into that application's user account
  --ref <branch/tag>    GitHub ref (default main)
  --cli <absolute-path> use a specific installed host CLI
  --dry-run             show the commands without running or installing anything
  --json                machine-readable result; host progress goes to stderr

Requires Node 22+ and an installed host with plugin support. On macOS, Codex's
CLI can be found inside Codex.app or ChatGPT.app even when it is not on PATH.
The host fetches the GitHub marketplace; no project checkout is needed.
After installation, open a new task/session to load the skills.
This command does not create a wallet, fund it, or authorize any payments.`;

/** @param {string} ref */
export function validateRef(ref) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..') || ref.includes('//') ||
      ref.endsWith('/') || ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('invalid --ref; use a Git branch, tag or commit without spaces or shell syntax');
  }
  return ref;
}

/** @param {string} path */
function executable(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

/** @param {'codex' | 'claude'} agent
 * @param {{cli?: string, platform?: string, path?: string, home?: string, exists?: (path: string) => boolean}} [options]
 */
export function findHost(agent, { cli, platform = process.platform, path = process.env.PATH ?? '', home = homedir(), exists = executable } = {}) {
  if (cli) {
    if (!isAbsolute(cli) || !exists(cli)) throw new Error('--cli must be an absolute path to an executable host CLI');
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) throw new Error('use the native host .exe with --cli, or run from WSL');
    return cli;
  }
  const filename = platform === 'win32' ? `${agent}.exe` : agent;
  const candidates = path.split(delimiter).filter(Boolean).map((dir) => resolve(dir, filename));
  candidates.push(join(home, '.local', 'bin', filename));
  if (agent === 'codex' && platform === 'darwin') {
    for (const parent of ['/Applications', join(home, 'Applications')]) {
      for (const app of ['Codex.app', 'ChatGPT.app']) candidates.push(join(parent, app, 'Contents', 'Resources', 'codex'));
    }
  }
  return candidates.find(exists) ?? null;
}

/** Use each host's supported Git-ref syntax; never construct a shell command.
 * @param {'codex' | 'claude'} agent @param {string} ref
 */
export function installCommands(agent, ref) {
  validateRef(ref);
  if (agent === 'codex') return [
    ['plugin', 'marketplace', 'add', REPOSITORY, '--ref', ref],
    ['plugin', 'add', PLUGIN]
  ];
  if (agent === 'claude') return [
    ['plugin', 'marketplace', 'add', `${REPOSITORY}@${ref}`, '--scope', 'user'],
    ['plugin', 'install', PLUGIN, '--scope', 'user']
  ];
  throw new Error('--agent must be codex or claude');
}

/** @param {string} cli @param {string[]} args @param {boolean} [quiet]
 * @returns {string}
 */
export function runHost(cli, args, quiet = false) {
  // Stream host prompts/progress immediately to stderr, leaving --json stdout
  // clean. Only capability probes are captured, and they never mutate state.
  const child = spawnSync(cli, args, { shell: false, encoding: 'utf8', stdio: ['inherit', quiet ? 'pipe' : 2, quiet ? 'pipe' : 2], timeout: 180_000, maxBuffer: 2_097_152 });
  if (child.error || child.status !== 0) {
    const detail = (child.stderr || child.stdout || child.error?.message || `exit ${child.status}`).trim().slice(-4000);
    throw new Error(`Host command failed: ${args.join(' ')}. ${detail}`);
  }
  return child.stdout ?? '';
}

/** @param {'codex' | 'claude'} agent @param {string} cli @param {string} ref
 * @param {(cli: string, args: string[], quiet?: boolean) => string} [execute]
 */
export function installPlugin(agent, cli, ref, execute = runHost) {
  // Check capabilities before mutating a marketplace. Older host CLIs fail
  // clearly instead of leaving a partial install after an unsupported command.
  execute(cli, ['plugin', 'marketplace', 'add', '--help'], true);
  execute(cli, ['plugin', agent === 'codex' ? 'add' : 'install', '--help'], true);
  for (const args of installCommands(agent, ref)) execute(cli, args);
}

/** @param {string[]} argv */
export async function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    if (!argv.length || flags.help || positional[0] === 'help') { process.stdout.write(USAGE + '\n'); return; }
    const allowed = new Set(['agent', 'ref', 'cli', 'dry-run', 'json']);
    if (positional.length || Object.keys(flags).some((key) => !allowed.has(key))) throw new Error('unexpected install argument; use algoria install --help');
    if (flags.agent !== 'codex' && flags.agent !== 'claude') throw new Error('--agent codex or --agent claude is required');
    if ((flags.ref !== undefined && typeof flags.ref !== 'string') || (flags.cli !== undefined && typeof flags.cli !== 'string') ||
        (flags['dry-run'] !== undefined && flags['dry-run'] !== true) || (flags.json !== undefined && flags.json !== true)) throw new Error('invalid install option value');
    const agent = flags.agent;
    const ref = validateRef(typeof flags.ref === 'string' ? flags.ref : 'main');
    const cli = findHost(agent, { cli: typeof flags.cli === 'string' ? flags.cli : undefined });
    const commands = installCommands(agent, ref);
    if (flags['dry-run']) {
      emit(flags, { dryRun: true, agent, cli: cli ?? agent, cliFound: Boolean(cli), repository: REPOSITORY, ref, commands },
        [`Preview only: ${agent}, ${REPOSITORY}@${ref}`, ...commands.map((args) => JSON.stringify([cli ?? agent, ...args])),
          ...(cli ? [] : [`${agent} CLI was not found; install it or supply --cli before running installation.`])]);
      return;
    }
    if (!cli) throw new Error(`${agent} CLI not found. Install ${agent === 'codex' ? 'Codex (or the desktop app)' : 'Claude Code'} with plugin support, or pass --cli /absolute/path/to/${agent}.`);
    process.stderr.write(`Installing Algoria for ${agent} from ${REPOSITORY}@${ref}...\n`);
    installPlugin(agent, cli, ref);
    const next = agent === 'codex' ? 'Open a new task in Codex/ChatGPT desktop to load the plugin.' : 'Start a new Claude Code session to load the plugin.';
    emit(flags, { installed: true, agent, repository: REPOSITORY, ref, plugin: PLUGIN, next },
      [`Algoria installed for ${agent}.`, next, 'Try: "Create an image for me using up to 0.02 test USDC."']);
  });
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
