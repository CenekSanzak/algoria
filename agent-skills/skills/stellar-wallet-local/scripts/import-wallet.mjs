#!/usr/bin/env node
/**
 * Import an existing Stellar secret seed into the local keystore.
 *
 * Usage:
 *   node import-wallet.mjs --name <name> --network <testnet|pubnet> --seed-file <path>
 *   cat seed.txt | node import-wallet.mjs --name <name> --network <net> --seed-stdin
 *
 * The seed is never accepted as a command-line argument. It comes from a file,
 * from stdin, or from ALGORIA_WALLET_SEED.
 */

import { readFile } from 'node:fs/promises';
import { emit, parseArgs, resolvePassphrase, run } from '../../../lib/cli.mjs';
import { fromSecretSeed } from '../../../lib/stellar/keypair.mjs';
import { assertValidName, saveWallet } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';

/**
 * @param {Record<string, string | boolean>} flags
 * @returns {Promise<string>}
 */
async function readSeed(flags) {
  if (flags.seed) throw new Error('refusing --seed: use --seed-file, --seed-stdin, or ALGORIA_WALLET_SEED');
  if (typeof flags['seed-file'] === 'string') {
    return (await readFile(flags['seed-file'], 'utf8')).trim();
  }
  if (flags['seed-stdin'] === true) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  if (process.env.ALGORIA_WALLET_SEED) return process.env.ALGORIA_WALLET_SEED.trim();
  throw new Error('no seed provided. Use --seed-file <path>, --seed-stdin, or set ALGORIA_WALLET_SEED.');
}

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));

  const name = assertValidName(typeof flags.name === 'string' ? flags.name : '');
  const network = resolveNetwork(typeof flags.network === 'string' ? flags.network : undefined);

  if (flags['no-passphrase'] === true && network.realValue) {
    throw new Error('--no-passphrase is refused on pubnet: a real wallet must be encrypted');
  }

  const keypair = fromSecretSeed(await readSeed(flags));
  const passphrase = await resolvePassphrase(flags, {
    allowNone: !network.realValue,
    prompt: `Passphrase to encrypt "${name}": `
  });

  const { path, record } = await saveWallet({ name, network: network.id, keypair, passphrase });

  emit(
    flags,
    {
      name: record.name,
      network: record.network,
      publicKey: record.publicKey,
      encrypted: record.encrypted,
      path
    },
    [
      `Imported wallet "${record.name}" on ${record.network}.`,
      ``,
      `  Address    ${record.publicKey}`,
      `  Stored at  ${path}`,
      `  Encrypted  ${record.encrypted ? 'yes (AES-256-GCM, scrypt)' : 'NO — unencrypted testnet wallet'}`,
      ``,
      `Verify this is the address you expected before sending anything to it.`
    ]
  );
});
