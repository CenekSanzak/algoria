#!/usr/bin/env node
import { emit, isMain, parseArgs, run } from '../../../lib/cli.mjs';
import { discover, getService } from '../../../lib/services/discovery.mjs';
import { displayAmount } from '../../../lib/services/policy.mjs';

const USAGE = `algoria discover — find Algoria agents/services

  list                       list available services
  search <query>             search service descriptions
  show <service-id>          input/output schemas, price and invocation contract

Options: --json, --limit 1–100, --offset 0`;

/** @param {string[]} argv */
export function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    const [command, ...args] = positional;
    if (!command || command === 'help' || flags.help) { process.stdout.write(USAGE + '\n'); return; }
    if (command === 'show') {
      if (!args[0]) throw new Error('show needs a service ID');
      const service = await getService(args[0]);
      emit(flags, service, [JSON.stringify(service, null, 2)]);
      return;
    }
    if (!['list', 'search'].includes(command)) throw new Error('expected list, search or show');
    if (command === 'search' && !args.length) throw new Error('search needs a query');
    const result = await discover({ query: command === 'search' ? args.join(' ') : undefined, limit: Number(flags.limit ?? 20), offset: Number(flags.offset ?? 0) });
    emit(flags, result, [
      ...result.resources.map((/** @type {any} */ service) => `${service.id} (v${service.version}) — ${displayAmount(service.accepts[0].amount)} test USDC\n  ${service.description ?? ''}`),
      `Showing ${result.resources.length}; total ${result.pagination?.total ?? 'unknown'}. Use --offset for more, show <id> for schemas.`
    ]);
  });
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
