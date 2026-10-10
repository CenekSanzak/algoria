#!/usr/bin/env node
import { uploadReference } from '../../../lib/services/references.mjs';
import { readFile } from 'node:fs/promises';
import { emit, isMain, parseArgs, run } from '../../../lib/cli.mjs';
import { listJobs, quote, runJob, statusJob } from '../../../lib/services/client.mjs';
import { getBudget, setBudget, revokeBudget } from '../../../lib/services/state.mjs';
import { quoteTempo } from '../../../lib/services/tempo-client.mjs';
import { tempoTask } from '../../../lib/services/task.mjs';
import { tempoReadiness } from '../../../lib/services/tempo-readiness.mjs';

const USAGE = `algoria pay — buy AI services and resume saved tasks

  readiness                                           local Tempo/Touch ID checks; no payment
  task --service image.generate|phone.call --input <json-file> --budget <name>
                                                      prepare one Tempo task (default: image)
  task <saved-id> [--approve] [--wait]                  resume/open the same task

  budget --name <name> --total <USDC> --per-call <USDC>   set a named spending cap
  budget --name <name>                                 remaining/spent/reserved
  revoke --name <name>                                 stop new Tempo signatures locally
  quote <service-id> --input <json-file> --budget <name> save job and price; no payment
  run <job-id> --approve                               pay within budget or resume
  status <job-id> [--wait] [--timeout 180]               same job and fresh media URLs
  list                                                local jobs (no secrets)
  upload-reference <photo-path> [--id <UUID-v4>]         private reference upload; no payment

Options: --json; quote --id <UUID-v4> reuses a known identity and identical input.
Tempo: budget/quote --protocol mpp; run --approve (testnet faucet funding is automatic).
Use --no-fund-testnet for manual test-token funding; --fund-testnet remains an alias.
Tempo budget requires --agent claude|codex --recipient 0x... --expires ISO_DATE.
Use budget --service phone.call for calls; default image permissions cannot pay for calls.
Grant/change opens Touch ID; revoke does not undo submitted payments.
Tempo uses test PathUSD, a separate budget, and the native Touch ID companion.
External: quote stellar8004:<agent>:<service-index> --method GET|POST ...
Use the method from service documentation. GET input is scalar query parameters.
External status is local only; a lost paid response must never be auto-retried.
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
    const protocol = typeof flags.protocol === 'string' ? flags.protocol : 'x402';
    if (!['x402', 'mpp'].includes(protocol)) throw new Error('expected --protocol x402 or mpp');
    if (flags.network && !(protocol === 'mpp' ? ['testnet', 'eip155:42431'] : ['testnet', 'stellar:testnet']).includes(String(flags.network))) throw new Error('Algoria services currently support testnet only');
    let result;
    if (command === 'readiness') result = tempoReadiness();
    else if (command === 'task') {
      let input;
      if (typeof flags.input === 'string') {
        const data = await readFile(flags.input, 'utf8');
        if (Buffer.byteLength(data) > 32768) throw new Error('input file exceeds 32768 bytes');
        input = JSON.parse(data);
      }
      if (target && flags.id && target !== flags.id) throw new Error('conflicting task IDs');
      result = await tempoTask({ id: target ?? (typeof flags.id === 'string' ? flags.id : undefined), input,
        service: typeof flags.service === 'string' ? flags.service : undefined,
        budget: typeof flags.budget === 'string' ? flags.budget : undefined,
        approve: flags.approve === true, fundTestnet: flags['no-fund-testnet'] !== true,
        wait: flags.wait === true, timeout: Number(flags.timeout ?? 180) });
      if ('interrupted' in result && result.interrupted) process.exitCode = 1;
    } else if (command === 'budget') {
      const name = value(flags, 'name');
      result = flags.total || flags['per-call']
        ? await setBudget(name, value(flags, 'total'), value(flags, 'per-call'), protocol,
          { agent: typeof flags.agent === 'string' ? flags.agent : undefined,
            service: typeof flags.service === 'string' ? flags.service : undefined,
            recipient: typeof flags.recipient === 'string' ? flags.recipient : undefined,
            expires: typeof flags.expires === 'string' ? flags.expires : undefined })
        : await getBudget(name);
    } else if (command === 'revoke') {
      result = await revokeBudget(value(flags, 'name'));
    } else if (command === 'list') result = { jobs: await listJobs() };
    else {
      if (!target) throw new Error('a service ID or saved job ID is required');
      if (command === 'upload-reference') result = await uploadReference(target, typeof flags.id === 'string' ? flags.id : undefined);
      else if (command === 'quote') {
        const data = await readFile(value(flags, 'input'), 'utf8');
        if (Buffer.byteLength(data) > 32768) throw new Error('input file exceeds 32768 bytes');
        result = protocol === 'mpp'
          ? await quoteTempo(target, JSON.parse(data), value(flags, 'budget'), typeof flags.id === 'string' ? flags.id : undefined)
          : await quote(target, JSON.parse(data), value(flags, 'budget'), typeof flags.id === 'string' ? flags.id : undefined, typeof flags.method === 'string' ? flags.method : undefined);
      } else if (command === 'run') result = await runJob(target, { approve: flags.approve === true, fundTestnet: flags['no-fund-testnet'] !== true });
      else if (command === 'status') result = await statusJob(target, { wait: flags.wait === true, timeout: Number(flags.timeout ?? 180) });
      else throw new Error('expected readiness, task, budget, quote, run, status, list or upload-reference');
    }
    const human = 'journey' in result ? ['message' in result ? result.message : result.journey.message,
      `Task: ${result.id}`, `Price: ${result.amount ?? 'pending'} ${result.unit ?? ''}`,
      `Next: ${'nextAction' in result ? result.nextAction : result.journey.nextAction}`,
      ...(result.payment?.success ? ['Payment confirmed; receipt saved.'] : []),
      ...('transactionUrl' in result && result.transactionUrl ? [`Tempo transaction: ${result.transactionUrl}`] : [])]
      : command === 'readiness' ? [result.ready ? 'Tempo wallet is ready for a testnet purchase.' : 'Tempo wallet needs setup.', result.nextAction]
      : [JSON.stringify(result, null, 2)];
    emit(flags, result, human);
  });
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
