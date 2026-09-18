#!/usr/bin/env node
/**
 * Fund a testnet wallet from Friendbot.
 *
 * Usage: node fund-wallet.mjs --name <name> [--json]
 *
 * Pubnet has no faucet. A pubnet wallet is funded by someone sending it XLM,
 * and this script will say so rather than pretending otherwise.
 */

import { emit, parseArgs, run } from '../../../lib/cli.mjs';
import { readWallet } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';
import { fundWithFriendbot, loadAccount } from '../../../lib/stellar/horizon.mjs';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const name = typeof flags.name === 'string' ? flags.name : '';
  if (!name) throw new Error('--name is required');

  const record = await readWallet(name);
  const network = resolveNetwork(record.network);

  if (!network.friendbotUrl) {
    throw new Error(
      `"${record.name}" is a ${network.id} wallet. There is no faucet for real funds; send XLM to ${record.publicKey} instead.`
    );
  }

  const result = await fundWithFriendbot(network, record.publicKey);
  const account = await loadAccount(network, record.publicKey);

  emit(flags, { name: record.name, network: record.network, publicKey: record.publicKey, result, account }, [
    `${result.detail} — ${record.publicKey}`,
    account.exists ? `Balance: ${account.xlm} XLM` : `Account not visible on Horizon yet; retry in a moment.`,
    `Explorer: ${network.explorer}/account/${record.publicKey}`
  ]);
});
