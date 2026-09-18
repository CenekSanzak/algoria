#!/usr/bin/env node
/**
 * Reveal a wallet's secret seed, for backup or for importing into another
 * Stellar wallet application.
 *
 * Usage:
 *   node export-secret.mjs --name <name> --out <path>   (recommended)
 *   node export-secret.mjs --name <name> --stdout
 *
 * `--out` writes the seed to an owner-only file and prints nothing but the
 * path. `--stdout` prints the seed itself, which means it enters the terminal,
 * the scrollback, and — if an agent ran the command — the conversation. That is
 * why it has to be asked for by name.
 */

import { writeFile } from 'node:fs/promises';
import { emit, parseArgs, resolvePassphrase, run } from '../../../lib/cli.mjs';
import { unlockWallet } from '../../../lib/stellar/keystore.mjs';

run(async () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const name = typeof flags.name === 'string' ? flags.name : '';
  if (!name) throw new Error('--name is required');

  const out = typeof flags.out === 'string' ? flags.out : null;
  if (!out && flags.stdout !== true) {
    throw new Error('choose an output: --out <path> to write the seed to a file, or --stdout to print it');
  }

  const passphrase = await resolvePassphrase(flags, {
    allowNone: true,
    prompt: `Passphrase for "${name}": `
  });
  const { record, keypair } = await unlockWallet(name, passphrase);

  if (out) {
    await writeFile(out, `${keypair.secretSeed}\n`, { mode: 0o600 });
    emit(flags, { name: record.name, network: record.network, publicKey: record.publicKey, writtenTo: out }, [
      `Secret seed for "${record.name}" written to ${out} (mode 0600).`,
      `Address: ${record.publicKey}`,
      ``,
      `Move it somewhere safe and delete the file. Anyone holding this seed controls the account.`
    ]);
    return;
  }

  process.stderr.write(
    `warning: the secret seed for "${record.name}" is about to be printed to stdout and will remain in scrollback.\n`
  );
  emit(flags, { name: record.name, network: record.network, publicKey: record.publicKey, secretSeed: keypair.secretSeed }, [
    `Address:     ${record.publicKey}`,
    `Secret seed: ${keypair.secretSeed}`,
    ``,
    `Anyone holding this seed controls the account. Clear your scrollback when done.`
  ]);
});
