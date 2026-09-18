#!/usr/bin/env node
/**
 * Create a new local Stellar wallet.
 *
 * Usage:
 *   node create-wallet.mjs --name <name> --network <testnet|pubnet> [options]
 *
 * Options:
 *   --fund                 fund the new account from Friendbot (testnet only)
 *   --passphrase-file PATH read the encryption passphrase from a file
 *   --no-passphrase        store the seed unencrypted (testnet only)
 *   --json                 machine-readable output
 *
 * The passphrase may also come from ALGORIA_WALLET_PASSPHRASE, or from a prompt
 * when a terminal is attached. It is never accepted as a command-line argument.
 *
 * The secret seed is never printed. Back it up with export-secret.mjs.
 */

import { emit, parseArgs, resolvePassphrase, run } from '../../../lib/cli.mjs';
import { generateKeypair } from '../../../lib/stellar/keypair.mjs';
import { assertValidName, saveWallet } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';
import { fundWithFriendbot } from '../../../lib/stellar/horizon.mjs';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));

  const name = assertValidName(typeof flags.name === 'string' ? flags.name : '');
  const network = resolveNetwork(typeof flags.network === 'string' ? flags.network : undefined);

  if (flags['no-passphrase'] === true && network.realValue) {
    throw new Error('--no-passphrase is refused on pubnet: a real wallet must be encrypted');
  }
  if (flags.fund && !network.friendbotUrl) {
    throw new Error(`--fund is not available on ${network.id}: there is no faucet for real funds`);
  }

  const passphrase = await resolvePassphrase(flags, {
    allowNone: !network.realValue,
    prompt: `Passphrase to encrypt "${name}": `
  });

  const keypair = generateKeypair();
  const { path, record } = await saveWallet({ name, network: network.id, keypair, passphrase });

  let funding = null;
  if (flags.fund) {
    funding = await fundWithFriendbot(network, keypair.publicKey);
  }

  emit(
    flags,
    {
      name: record.name,
      network: record.network,
      publicKey: record.publicKey,
      encrypted: record.encrypted,
      path,
      createdAt: record.createdAt,
      funding
    },
    [
      `Created wallet "${record.name}" on ${record.network}.`,
      ``,
      `  Address    ${record.publicKey}`,
      `  Stored at  ${path}`,
      `  Encrypted  ${record.encrypted ? 'yes (AES-256-GCM, scrypt)' : 'NO — unencrypted testnet wallet'}`,
      `  Explorer   ${network.explorer}/account/${record.publicKey}`,
      funding ? `  Funding    ${funding.detail}` : `  Funding    not requested`,
      ``,
      `The secret seed was not printed and is not in this output.`,
      `Back it up now: node export-secret.mjs --name ${record.name}`,
      record.encrypted
        ? `Without the passphrase, this wallet cannot be recovered from the file alone.`
        : `This seed is stored in plain text. Never reuse it on pubnet.`
    ]
  );
});
