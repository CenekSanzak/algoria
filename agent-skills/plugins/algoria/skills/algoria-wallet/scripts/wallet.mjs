#!/usr/bin/env node
/**
 * The Algoria wallet CLI.
 *
 *   node wallet.mjs onboard --network testnet    create + fund + trustline
 *   node wallet.mjs balance                      spendable USDC and XLM
 *   node wallet.mjs accounts                     every wallet, every network
 *   node wallet.mjs fund                         Friendbot, or a deposit address
 *   node wallet.mjs trustline                    opt in to holding USDC
 *   node wallet.mjs import --seed-file <path>    adopt an existing seed
 *   node wallet.mjs export --out <path>          reveal the seed
 *
 * Every command takes `--network testnet|pubnet` (default testnet) and `--json`.
 *
 * The wallet is created on first use rather than by a separate command, so an
 * agent that needs an address gets one instead of a prompt. Creation is always
 * announced: `created: true` in JSON, a line saying so in text.
 */

import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { emit, parseArgs, resolvePassphrase, run } from '../../../lib/cli.mjs';
import { loadAccount, fundWithFriendbot } from '../../../lib/stellar/horizon.mjs';
import { deleteWallet, ensureWallet, importWallet, listWallets, unlockWallet, walletPath } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';
import { addUsdcTrustline, hasUsdcTrustline, usdcBalance } from '../../../lib/stellar/trustline.mjs';

const USAGE = `algoria wallet

  onboard      create the wallet, fund it, and add the USDC trustline
  balance      USDC and XLM for one network
  accounts     every wallet held locally, with funding links
  fund         Friendbot on testnet; deposit instructions on pubnet
  trustline    opt the account in to holding USDC
  import       adopt an existing secret seed
  export       reveal the secret seed
  forget       remove a wallet from this machine

Options
  --network testnet|pubnet   default: testnet
  --json                     machine-readable output
  --passphrase-file <path>   pubnet only; or set ALGORIA_WALLET_PASSPHRASE`;

/** @typedef {Record<string, string | boolean>} Flags */

/**
 * Pubnet wallets are encrypted, testnet wallets are not, so a passphrase is
 * only ever collected for the network that needs one.
 * @param {import('../../../lib/stellar/network.mjs').NetworkProfile} network
 * @param {Flags} flags
 * @returns {Promise<string | null>}
 */
async function passphraseFor(network, flags) {
  if (!network.realValue) return null;
  return resolvePassphrase(flags, { prompt: 'Passphrase for the pubnet wallet: ' });
}

/**
 * @param {import('../../../lib/stellar/network.mjs').NetworkProfile} network
 * @param {string} publicKey
 */
async function describeAccount(network, publicKey) {
  const account = await loadAccount(network, publicKey);
  return {
    exists: account.exists,
    xlm: account.xlm,
    usdc: usdcBalance(account, network),
    trustline: hasUsdcTrustline(account, network),
    balances: account.balances
  };
}

/**
 * `0.5 USDC` and `no trustline` are different states and the difference
 * matters, so they never collapse into the same string.
 * @param {string | null} value
 */
const formatUsdc = (value) => (value === null ? 'none (no trustline yet)' : `${value} USDC`);

/** @type {Record<string, (flags: Flags) => Promise<void>>} */
const COMMANDS = {
  /** Create, fund, and make the wallet able to hold USDC, in one call. */
  async onboard(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    const passphrase = await passphraseFor(network, flags);
    const { entry, created } = await ensureWallet({ network: network.id, passphrase });

    const steps = [];
    let account = await describeAccount(network, entry.publicKey);

    if (!account.exists) {
      if (network.friendbotUrl) {
        const funding = await fundWithFriendbot(network, entry.publicKey);
        steps.push(`funded: ${funding.detail}`);
        account = await describeAccount(network, entry.publicKey);
      } else {
        steps.push('not funded: pubnet has no faucet, send XLM to the address below');
      }
    } else {
      steps.push('already funded');
    }

    let trustline = null;
    if (account.exists && !account.trustline) {
      const { keypair } = await unlockWallet(network.id, passphrase);
      trustline = await addUsdcTrustline({ network, keypair });
      steps.push(trustline.created ? `USDC trustline added (${trustline.hash})` : 'USDC trustline already present');
      account = await describeAccount(network, entry.publicKey);
    } else if (account.trustline) {
      steps.push('USDC trustline already present');
    } else {
      steps.push('USDC trustline pending: the account must be funded first');
    }

    const ready = account.exists && account.trustline;

    emit(
      flags,
      {
        created,
        network: network.id,
        publicKey: entry.publicKey,
        encrypted: entry.encrypted,
        walletFile: walletPath(),
        xlm: account.xlm,
        usdc: account.usdc,
        trustline: account.trustline,
        ready,
        steps,
        trustlineTx: trustline?.hash ?? null
      },
      [
        created ? `Created a new ${network.id} wallet.` : `Using the existing ${network.id} wallet.`,
        ``,
        `  Address    ${entry.publicKey}`,
        `  Stored at  ${walletPath()}`,
        `  Encrypted  ${entry.encrypted ? 'yes (AES-256-GCM, scrypt)' : 'no — testnet seed, stored in the clear'}`,
        `  XLM        ${account.xlm ?? '0'}`,
        `  USDC       ${formatUsdc(account.usdc)}`,
        `  Explorer   ${network.explorer}/account/${entry.publicKey}`,
        ``,
        ...steps.map((step) => `  - ${step}`),
        ``,
        ready
          ? `Ready to receive and spend USDC on ${network.id}.`
          : `Not ready yet: ${account.exists ? 'add the USDC trustline' : `send XLM to ${entry.publicKey}`}.`,
        created && !entry.encrypted ? `The seed is stored unencrypted. Fine for testnet; never reuse it on pubnet.` : ``
      ].filter(Boolean)
    );
  },

  /** The one number an agent needs before deciding whether it can pay. */
  async balance(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    const entry = (await listWallets()).find((wallet) => wallet.network === network.id);
    if (!entry) throw new Error(`no ${network.id} wallet yet. Run: wallet.mjs onboard --network ${network.id}`);

    const account = await describeAccount(network, entry.publicKey);
    emit(
      flags,
      {
        network: network.id,
        publicKey: entry.publicKey,
        usdc: account.usdc,
        xlm: account.xlm,
        trustline: account.trustline,
        exists: account.exists
      },
      [
        `${formatUsdc(account.usdc)}   ${account.xlm ?? '0'} XLM   (${network.id})`,
        `${entry.publicKey}`,
        account.exists ? `` : `This account does not exist on-chain yet. Run: wallet.mjs fund --network ${network.id}`
      ].filter(Boolean)
    );
  },

  /** Every wallet on this machine, with where to send funds. */
  async accounts(flags) {
    const wallets = await listWallets();
    if (wallets.length === 0) {
      emit(flags, { walletFile: walletPath(), accounts: [] }, [
        `No wallets yet.`,
        `Create one: wallet.mjs onboard --network testnet`
      ]);
      return;
    }

    const accounts = [];
    for (const entry of wallets) {
      const network = resolveNetwork(entry.network);
      const account = await describeAccount(network, entry.publicKey);
      accounts.push({
        network: entry.network,
        publicKey: entry.publicKey,
        encrypted: entry.encrypted,
        usdc: account.usdc,
        xlm: account.xlm,
        trustline: account.trustline,
        exists: account.exists,
        fundWith: network.friendbotUrl ? 'friendbot' : 'transfer',
        explorer: `${network.explorer}/account/${entry.publicKey}`
      });
    }

    emit(flags, { walletFile: walletPath(), accounts }, [
      `Wallets in ${walletPath()}:`,
      ``,
      ...accounts.flatMap((account) => [
        `  ${account.network}`,
        `    ${account.publicKey}`,
        `    ${formatUsdc(account.usdc)}   ${account.xlm ?? '0'} XLM${account.encrypted ? '' : '   [seed unencrypted]'}`,
        `    fund by ${account.fundWith === 'friendbot' ? 'Friendbot' : 'sending XLM or USDC to the address above'}`,
        ``
      ])
    ]);
  },

  /** Friendbot on testnet; on pubnet, say plainly that a human must send funds. */
  async fund(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    const passphrase = await passphraseFor(network, flags);
    const { entry, created } = await ensureWallet({ network: network.id, passphrase });

    if (!network.friendbotUrl) {
      const account = await describeAccount(network, entry.publicKey);
      emit(
        flags,
        { network: network.id, publicKey: entry.publicKey, created, funded: false, ...account },
        [
          `${network.id} has no faucet. Send XLM (and USDC) to:`,
          ``,
          `  ${entry.publicKey}`,
          ``,
          `  XLM   ${account.xlm ?? '0'}`,
          `  USDC  ${formatUsdc(account.usdc)}`,
          `  ${network.explorer}/account/${entry.publicKey}`
        ]
      );
      return;
    }

    const funding = await fundWithFriendbot(network, entry.publicKey);
    const account = await describeAccount(network, entry.publicKey);
    emit(flags, { network: network.id, publicKey: entry.publicKey, created, funding, ...account }, [
      `${funding.detail} — ${entry.publicKey}`,
      `  XLM   ${account.xlm ?? '0'}`,
      `  USDC  ${formatUsdc(account.usdc)}`
    ]);
  },

  /** Without this, the account cannot hold USDC at all. */
  async trustline(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    const passphrase = await passphraseFor(network, flags);
    const { keypair, entry } = await unlockWallet(network.id, passphrase);
    const result = await addUsdcTrustline({ network, keypair });
    const account = await describeAccount(network, entry.publicKey);

    emit(flags, { network: network.id, publicKey: entry.publicKey, ...result, usdc: account.usdc }, [
      result.created
        ? `USDC trustline added for ${entry.publicKey}`
        : `USDC trustline already present for ${entry.publicKey}`,
      `  asset  ${result.asset}`,
      result.hash ? `  tx     ${result.hash}` : ``,
      `  USDC   ${formatUsdc(account.usdc)}`
    ].filter(Boolean));
  },

  /** Adopt a seed the user already has. */
  async import(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    if (flags.seed) throw new Error('refusing --seed: use --seed-file, --seed-stdin, or ALGORIA_WALLET_SEED');

    let seed;
    if (typeof flags['seed-file'] === 'string') seed = (await readFile(flags['seed-file'], 'utf8')).trim();
    else if (flags['seed-stdin'] === true) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      seed = Buffer.concat(chunks).toString('utf8').trim();
    } else if (process.env.ALGORIA_WALLET_SEED) seed = process.env.ALGORIA_WALLET_SEED.trim();
    else throw new Error('no seed provided. Use --seed-file <path>, --seed-stdin, or set ALGORIA_WALLET_SEED.');

    const passphrase = await passphraseFor(network, flags);
    const entry = await importWallet({
      network: network.id,
      secretSeed: seed,
      passphrase,
      replace: flags.replace === true
    });

    emit(flags, { network: entry.network, publicKey: entry.publicKey, encrypted: entry.encrypted, walletFile: walletPath() }, [
      `Imported the ${entry.network} wallet.`,
      `  Address    ${entry.publicKey}`,
      `  Stored at  ${walletPath()}`,
      `  Encrypted  ${entry.encrypted ? 'yes' : 'no — testnet seed, stored in the clear'}`,
      ``,
      `Verify this is the address you expected before sending anything to it.`
    ]);
  },

  /** The only command that reveals a secret, and it says so. */
  async export(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    const out = typeof flags.out === 'string' ? flags.out : null;
    if (!out && flags.stdout !== true) {
      throw new Error('choose an output: --out <path> to write the seed to a file, or --stdout to print it');
    }

    const passphrase = await passphraseFor(network, flags);
    const { entry, keypair } = await unlockWallet(network.id, passphrase);

    if (out) {
      await writeFile(out, `${keypair.secretSeed}\n`, { mode: 0o600 });
      emit(flags, { network: entry.network, publicKey: entry.publicKey, writtenTo: out }, [
        `Secret seed for the ${entry.network} wallet written to ${out} (mode 0600).`,
        `Address: ${entry.publicKey}`,
        ``,
        `Move it somewhere safe and delete the file. Anyone holding this seed controls the account.`
      ]);
      return;
    }

    process.stderr.write(`warning: the secret seed is about to be printed and will remain in scrollback.\n`);
    emit(flags, { network: entry.network, publicKey: entry.publicKey, secretSeed: keypair.secretSeed }, [
      `Address:     ${entry.publicKey}`,
      `Secret seed: ${keypair.secretSeed}`,
      ``,
      `Anyone holding this seed controls the account. Clear your scrollback when done.`
    ]);
  },

  /** Removing the file is removing the money, so this asks first. */
  async forget(flags) {
    const network = resolveNetwork(flags.network ?? 'testnet');
    const entry = (await listWallets()).find((wallet) => wallet.network === network.id);
    if (!entry) throw new Error(`no ${network.id} wallet to forget`);

    if (flags.yes !== true) {
      throw new Error(
        `this deletes the ${network.id} seed for ${entry.publicKey} from this machine and cannot be undone. ` +
          `Export it first (wallet.mjs export --network ${network.id} --out seed.txt), then pass --yes.`
      );
    }

    await deleteWallet(network.id);
    emit(flags, { network: network.id, publicKey: entry.publicKey, forgotten: true }, [
      `Removed the ${network.id} wallet (${entry.publicKey}) from ${walletPath()}.`
    ]);
  }
};

run(async () => {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help' || flags.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`unknown command "${command}". Run without arguments to see the list.`);
  }
  await handler(flags);
});
