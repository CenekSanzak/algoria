#!/usr/bin/env node
/**
 * `npx algoria` — the same skills, driven by a human instead of an agent.
 *
 * This is a dispatcher, not a second implementation. Each skill already exposes
 * one entry point; this maps a group name onto it and hands over the rest of the
 * argv, so `algoria wallet onboard` and the agent's
 * `node skills/algoria-wallet/scripts/wallet.mjs onboard` run the same code.
 *
 * Nothing here may grow behaviour of its own. A flag that works in one and not
 * the other is the failure this file exists to prevent.
 */

import { readFile } from 'node:fs/promises';

const GROUPS = {
  memory: {
    script: '../skills/algoria-memory/scripts/memory.mjs',
    blurb: 'recall local context/history and manage saved services across catalogs'
  },
  install: {
    script: '../lib/install.mjs',
    blurb: 'install the plugin for Codex or Claude Code in one command'
  },
  discover: {
    script: '../skills/algoria-discover/scripts/discover.mjs',
    blurb: 'find agents/services, read schemas and current testnet prices'
  },
  pay: {
    script: '../skills/algoria-pay/scripts/pay.mjs',
    blurb: 'quote, pay with x402 within a budget, and recover saved results'
  },
  wallet: {
    script: '../skills/algoria-wallet/scripts/wallet.mjs',
    blurb: 'create a wallet, fund it, check balances, add the USDC trustline'
  },
  topup: {
    script: '../skills/algoria-topup/scripts/topup.mjs',
    blurb: 'buy testnet USDC with mock Turkish lira, through the TR anchor'
  }
};

/** @returns {Promise<string>} */
async function version() {
  const manifest = new URL('../package.json', import.meta.url);
  return JSON.parse(await readFile(manifest, 'utf8')).version;
}

async function usage() {
  const lines = ['algoria — a Stellar wallet your agent can spend from', ''];
  for (const [name, { blurb }] of Object.entries(GROUPS)) {
    lines.push(`  ${name.padEnd(10)} ${blurb}`);
  }
  lines.push(
    '',
    'Examples',
    '  algoria install --agent codex',
    '  algoria wallet onboard --network testnet',
    '  algoria wallet balance --json',
    '  algoria topup start --try 200',
    '  algoria discover search image',
    '  algoria pay',
    '',
    `Run \`algoria <group>\` on its own for that group's commands.`,
    '',
    'Every wallet lives on this machine, in ~/.algoria. The secret seed never',
    'leaves it. testnet is the default, and testnet balances are not money.'
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

const [group, ...rest] = process.argv.slice(2);

if (group === '--version' || group === '-v') {
  process.stdout.write(`${await version()}\n`);
} else if (!group || group === 'help' || group === '--help' || group === '-h') {
  await usage();
} else if (Object.hasOwn(GROUPS, group)) {
  // Tell the skill which front door this is, so a message that asks the user to
  // retype something names `algoria wallet …` and not the script file.
  process.env.ALGORIA_INVOKED_AS = 'algoria';

  // Each skill's `main()` owns its own errors and exit code; pass argv straight
  // through so a flag never has to be understood in two places.
  const { main } = await import(GROUPS[group].script);
  await main(rest);
} else {
  process.stderr.write(
    `error: unknown command "${group}". Expected one of: ${Object.keys(GROUPS).join(', ')}.\n` +
      'Run `algoria` with no arguments to see the list.\n'
  );
  process.exitCode = 1;
}
