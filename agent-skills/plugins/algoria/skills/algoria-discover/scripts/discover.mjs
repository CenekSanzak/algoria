#!/usr/bin/env node
import { emit, isMain, parseArgs, run } from '../../../lib/cli.mjs';
import { discover, getService } from '../../../lib/services/discovery.mjs';
import { displayAmount } from '../../../lib/services/policy.mjs';
import { discoverStellar8004, getStellar8004Service } from '../../../lib/services/stellar8004.mjs';

const USAGE = `algoria discover — find Algoria agents/services

  list                       list available services
  search <query>             search service descriptions
  show <service-id>          input/output schemas, price and invocation contract

Options: --json, --limit 1–100, --offset 0, --source algoria|stellar8004 (default algoria)
Stellar8004 uses the testnet registry directly. Pagination scans agent IDs;
follow nextOffset even when a search page has no matches. Service IDs are
stellar8004:<agent-id>:<service-index>. show detects their source automatically.`;

/** @param {string[]} argv */
export function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    const [command, ...args] = positional;
    if (!command || command === 'help' || flags.help) { process.stdout.write(USAGE + '\n'); return; }
    if (flags.source && !['algoria', 'stellar8004'].includes(String(flags.source))) throw new Error('source must be algoria or stellar8004');
    if (flags.network && !['testnet', 'stellar:testnet'].includes(String(flags.network))) throw new Error('discovery supports testnet only');
    if (command === 'show') {
      if (!args[0]) throw new Error('show needs a service ID');
      const external = args[0].startsWith('stellar8004:');
      if (flags.source && flags.source !== (external ? 'stellar8004' : 'algoria')) throw new Error('source differs from the service ID');
      const service = await (external ? getStellar8004Service(args[0]) : getService(args[0]));
      emit(flags, service, [JSON.stringify(service, null, 2)]);
      return;
    }
    if (!['list', 'search'].includes(command)) throw new Error('expected list, search or show');
    if (command === 'search' && !args.length) throw new Error('search needs a query');
    const options = { query: command === 'search' ? args.join(' ') : undefined, limit: Number(flags.limit ?? 20), offset: Number(flags.offset ?? 0) };
    if (flags.source === 'stellar8004') {
      const result = await discoverStellar8004(options);
      emit(flags, result, [...result.resources.map((service) => `${service.id} — ${service.agentName}: ${service.name} (${service.supported ? service.transport === 'mcp' ? 'MCP tools; handshake required' : 'x402 quote required' : 'unsupported'})\n  ${service.description}`),
        `Scanned agent IDs from ${result.pagination.offset}; total agents ${result.pagination.totalAgents}; nextOffset ${result.pagination.nextOffset ?? 'none'}; unreadable ${result.unavailable.length}.`]);
      return;
    }
    const result = await discover(options);
    emit(flags, result, [
      ...result.resources.map((/** @type {any} */ service) => `${service.id} (v${service.version}) — ${displayAmount(service.accepts[0].amount)} test USDC\n  ${service.description ?? ''}`),
      `Showing ${result.resources.length}; total ${result.pagination?.total ?? 'unknown'}. Use --offset for more, show <id> for schemas.`
    ]);
  });
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
