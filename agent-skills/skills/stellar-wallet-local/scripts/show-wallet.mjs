#!/usr/bin/env node
/**
 * Show one wallet's address and on-chain balances.
 *
 * Usage: node show-wallet.mjs --name <name> [--json]
 *
 * Reads public keystore metadata and queries Horizon. No passphrase required,
 * because nothing here needs the secret.
 */

import { emit, parseArgs, run } from '../../../lib/cli.mjs';
import { readWallet, walletPath } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';
import { loadAccount } from '../../../lib/stellar/horizon.mjs';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const name = typeof flags.name === 'string' ? flags.name : '';
  if (!name) throw new Error('--name is required');

  const record = await readWallet(name);
  const network = resolveNetwork(record.network);
  const account = await loadAccount(network, record.publicKey);

  emit(
    flags,
    {
      name: record.name,
      network: record.network,
      publicKey: record.publicKey,
      encrypted: record.encrypted,
      path: walletPath(record.name),
      account
    },
    [
      `Wallet "${record.name}" on ${record.network}`,
      ``,
      `  Address    ${record.publicKey}`,
      `  Stored at  ${walletPath(record.name)}`,
      `  Encrypted  ${record.encrypted ? 'yes' : 'NO — unencrypted testnet wallet'}`,
      `  Explorer   ${network.explorer}/account/${record.publicKey}`,
      ``,
      account.exists
        ? `  Balances`
        : `  This account does not exist on ${record.network} yet. It needs a starting XLM balance before it can hold anything.`,
      ...(account.exists ? account.balances.map((entry) => `    ${entry.balance.padStart(18)}  ${entry.asset}`) : []),
      ...(account.exists || network.friendbotUrl === null
        ? []
        : [``, `  Fund it: node fund-wallet.mjs --name ${record.name}`])
    ]
  );
});
