#!/usr/bin/env node
import { emit, isMain, parseArgs, run } from '../../../lib/cli.mjs';
import { forget, forgetService, recall, remember, saveService } from '../../../lib/memory.mjs';

const USAGE = `algoria memory — local context and saved services across sessions

  recall [--scope <project/session>] [--query <text>] [--limit 20]
  remember --scope <user|project|session> --key <name> --value <text>
  forget --scope <scope> --key <name>
  save-service --source <catalog> --service <id> [--name <name>] [--url <https-url>] [--note <text>]
  forget-service --source <catalog> --service <id>

All commands accept --json. Notes and bookmarks: ~/.algoria/memory.json.
History is a safe projection of existing services.json, with no signed URLs or
secrets. No network calls, payments, scheduler or database. ALGORIA_HOME supported.
A bookmark (including Bazaar) is not a supported payment integration.
Scope filters notes; recall also includes user preferences and all local job history.
For new paid tasks, check wallet balance BEFORE reading memory or discovery.`;

/** @param {Record<string, string | boolean>} flags @param {string} key */
function required(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key]) throw new Error(`--${key} is required`);
  return /** @type {string} */ (flags[key]);
}
/** @param {Record<string, string | boolean>} flags @param {string} key */
function optional(flags, key) { return flags[key] === undefined ? undefined : required(flags, key); }

/** @param {string[]} argv */
export function main(argv) {
  return run(async () => {
    const { positional, flags } = parseArgs(argv);
    const [command] = positional;
    if (!command || command === 'help' || flags.help) { process.stdout.write(USAGE + '\n'); return; }
    const allowed = /** @type {Record<string, string[]>} */ ({
      recall: ['scope', 'query', 'limit'], remember: ['scope', 'key', 'value'], forget: ['scope', 'key'],
      'save-service': ['source', 'service', 'name', 'url', 'note'], 'forget-service': ['source', 'service']
    });
    if (!Object.hasOwn(allowed, command) || positional.length !== 1 ||
      Object.keys(flags).some((key) => key !== 'json' && !allowed[command].includes(key))) throw new Error('invalid memory command or option; use --help');
    let result;
    if (command === 'recall') result = await recall({ scope: optional(flags, 'scope'), query: optional(flags, 'query'), limit: flags.limit === undefined ? 20 : Number(required(flags, 'limit')) });
    else if (command === 'remember') result = await remember(required(flags, 'scope'), required(flags, 'key'), required(flags, 'value'));
    else if (command === 'forget') result = await forget(required(flags, 'scope'), required(flags, 'key'));
    else if (command === 'save-service') result = await saveService({ source: required(flags, 'source'), service: required(flags, 'service'), name: optional(flags, 'name'), url: optional(flags, 'url'), note: optional(flags, 'note') });
    else result = await forgetService(required(flags, 'source'), required(flags, 'service'));
    emit(flags, result, [JSON.stringify(result, null, 2)]);
  });
}
if (isMain(import.meta.url)) main(process.argv.slice(2));
