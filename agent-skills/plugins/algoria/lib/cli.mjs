/**
 * Shared plumbing for skill scripts: flag parsing, passphrase input, and output.
 *
 * Two rules hold everywhere here.
 *
 * A passphrase never arrives as a command-line argument, because arguments are
 * visible to `ps`, land in shell history, and end up quoted back into the
 * conversation. It comes from a file, an environment variable, or a TTY prompt.
 *
 * Secrets are never part of normal output. A script that reveals one says so in
 * its own name and asks for it explicitly.
 */

import { readFile } from 'node:fs/promises';

const ETX = ''; // ctrl-c
const DEL = '';
const BACKSPACE = '';

/**
 * @param {string[]} argv
 * @returns {{flags: Record<string, string | boolean>, positional: string[]}}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, positional };
}

/**
 * Resolve a passphrase without ever accepting one as an argument.
 *
 * @param {Record<string, string | boolean>} flags
 * @param {object} [options]
 * @param {boolean} [options.allowNone] permit `--no-passphrase` (testnet only)
 * @param {string} [options.prompt]
 * @returns {Promise<string | null>}
 */
export async function resolvePassphrase(flags, { allowNone = false, prompt = 'Passphrase: ' } = {}) {
  if (flags.passphrase) {
    throw new Error('refusing --passphrase: use --passphrase-file, ALGORIA_WALLET_PASSPHRASE, or the prompt');
  }
  if (flags['no-passphrase'] === true) {
    if (!allowNone) throw new Error('--no-passphrase is not allowed here');
    return null;
  }
  if (typeof flags['passphrase-file'] === 'string') {
    const contents = await readFile(flags['passphrase-file'], 'utf8');
    const value = contents.replace(/\r?\n$/, '');
    if (!value) throw new Error(`passphrase file ${flags['passphrase-file']} is empty`);
    return value;
  }
  if (process.env.ALGORIA_WALLET_PASSPHRASE) return process.env.ALGORIA_WALLET_PASSPHRASE;
  if (process.stdin.isTTY) return promptHidden(prompt);

  throw new Error(
    'no passphrase available. Set ALGORIA_WALLET_PASSPHRASE, pass --passphrase-file <path>, or run in a terminal.'
  );
}

/**
 * Read a line from the TTY without echoing it.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    const wasRaw = stdin.isRaw ?? false;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const finish = (/** @type {() => void} */ done) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
      stderr.write('\n');
      done();
    };
    const onData = (/** @type {string} */ chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(value));
        if (char === ETX) return finish(() => reject(new Error('cancelled')));
        if (char === DEL || char === BACKSPACE) value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Name this script the way the user actually reached it.
 *
 * The same code has two front doors: an agent runs the skill script directly
 * (`node skills/algoria-wallet/scripts/wallet.mjs`), and a human runs
 * `algoria wallet` through `bin/algoria.mjs`. A message that tells someone to
 * retype a command has to match the door they came in by, or the instruction is
 * wrong for half the users.
 *
 * `bin/algoria.mjs` sets ALGORIA_INVOKED_AS before handing over. Reading that is
 * deliberate: inferring the door from `process.argv[1]` looks equivalent and is
 * not, because npm installs a bin as `node_modules/.bin/algoria` with no
 * extension, so the obvious filename check silently misses every npx user.
 *
 * @param {string} group the `algoria <group>` name, e.g. 'wallet'
 * @param {string} script the standalone file name, e.g. 'wallet.mjs'
 * @returns {string}
 */
export function commandName(group, script) {
  const cli = process.env.ALGORIA_INVOKED_AS;
  return cli ? `${cli} ${group}` : script;
}

/**
 * Print a result as human text or JSON, depending on `--json`.
 * @param {Record<string, string | boolean>} flags
 * @param {object} payload
 * @param {string[]} lines
 */
export function emit(flags, payload, lines) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Run a script body, turning any thrown error into a clean one-line failure.
 * @param {() => Promise<void>} body
 */
export async function run(body) {
  try {
    await body();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
