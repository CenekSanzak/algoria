#!/usr/bin/env node
/**
 * List the local wallets. Public metadata only; no passphrase is required and
 * no secret is read.
 *
 * Usage: node list-wallets.mjs [--network <testnet|pubnet>] [--json]
 */

import { emit, parseArgs, run } from '../../../lib/cli.mjs';
import { listWallets, walletsDir } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const filter = typeof flags.network === 'string' ? resolveNetwork(flags.network).id : null;

  const wallets = (await listWallets())
    .filter((wallet) => !filter || wallet.network === filter)
    .map((wallet) => ({
      name: wallet.name,
      network: wallet.network,
      publicKey: wallet.publicKey,
      encrypted: wallet.encrypted,
      createdAt: wallet.createdAt
    }));

  if (wallets.length === 0) {
    emit(flags, { directory: walletsDir(), wallets }, [
      `No wallets found in ${walletsDir()}.`,
      `Create one: node create-wallet.mjs --name main --network testnet --fund`
    ]);
    return;
  }

  emit(flags, { directory: walletsDir(), wallets }, [
    `${wallets.length} wallet${wallets.length === 1 ? '' : 's'} in ${walletsDir()}:`,
    ``,
    ...wallets.map(
      (wallet) =>
        `  ${wallet.name.padEnd(20)} ${wallet.network.padEnd(8)} ${wallet.publicKey}` +
        `${wallet.encrypted ? '' : '  [UNENCRYPTED]'}`
    )
  ]);
});
