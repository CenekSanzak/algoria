#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { emit, isMain, parseArgs, run } from '../../../lib/cli.mjs';
import { listJobs, quote, runJob, statusJob } from '../../../lib/services/client.mjs';
import { getBudget, setBudget } from '../../../lib/services/state.mjs';

const USAGE = `algoria pay — execute services with local x402 testnet USDC payments

  budget --name <name> --total <USDC> --per-call <USDC>   set a named spending cap
  budget --name <name>                                 remaining/spent/reserved
  quote <service-id> --input <json-file> --budget <name> save job and price; no payment
  run <job-id> --approve                               pay within budget or resume
  status <job-id> [--wait] [--timeout 180]               same job and fresh media URLs
  list                                                local jobs (no secrets)

Options: --json; quote --id <UUID-v4> reuses a known identity and identical input.
Testnet only. Recovery tokens and signed authorizations stay in ~/.algoria.
After an interruption use the saved job ID, not another quote.`;

/** @param {Record<string, string | boolean>} flags @param {string} name */
function value(flags, name) {
  if (typeof flags[name] !== 'string' || !flags[name]) throw new Error(`--${name} is required`);
  return /** @type {string} */ (flags[name]);
}

/** @param {string[]} argv */
export function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    const [command, target] = positional;
    if (!command || command === 'help' || flags.help) { process.stdout.write(USAGE + '\n'); return; }
    // Never let a caller believe these services use their pubnet wallet.
    if (flags.network && !['testnet', 'stellar:testnet'].includes(String(flags.network))) throw new Error('Algoria services currently support testnet only');
    let result;
    if (command === 'budget') {
      const name = value(flags, 'name');
      result = flags.total || flags['per-call']
        ? await setBudget(name, value(flags, 'total'), value(flags, 'per-call'))
        : await getBudget(name);
    } else if (command === 'list') result = { jobs: await listJobs() };
    else {
      if (!target) throw new Error('a service ID or saved job ID is required');
      if (command === 'quote') {
        const data = await readFile(value(flags, 'input'), 'utf8');
        if (Buffer.byteLength(data) > 32768) throw new Error('input file exceeds 32768 bytes');
        result = await quote(target, JSON.parse(data), value(flags, 'budget'), typeof flags.id === 'string' ? flags.id : undefined);
      } else if (command === 'run') result = await runJob(target, { approve: flags.approve === true });
      else if (command === 'status') result = await statusJob(target, { wait: flags.wait === true, timeout: Number(flags.timeout ?? 180) });
      else throw new Error('expected budget, quote, run, status or list');
    }
    emit(flags, result, [JSON.stringify(result, null, 2)]);
  });
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
