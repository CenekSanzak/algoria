#!/usr/bin/env node
/**
 * Buying testnet USDC with mock Turkish lira, through the TR mock anchor.
 *
 *   node topup.mjs start --try 200     open a deposit, print the bank details
 *   node topup.mjs status --wait       follow it until the USDC lands
 *   node topup.mjs history             every deposit this wallet has opened
 *
 * The shape is deliberately two steps, not one. `start` opens an order and
 * gives the user an IBAN, a reference and a link; the user pays; `status`
 * watches the money arrive. This script never simulates the transfer itself —
 * pressing that button is the user's decision, the same way a real transfer
 * would be.
 */

import { commandName, emit, parseArgs, run } from '../../../lib/cli.mjs';
import { ANCHOR, assertAnchorNetwork, estimateUsdc, normaliseTryAmount, verifyAnchor } from '../../../lib/anchor/anchor.mjs';
import { authenticate } from '../../../lib/anchor/sep10.mjs';
import { createDeposit, getDeposit, isSuccess, isTerminal, listDeposits } from '../../../lib/anchor/sep6.mjs';
import { findDeposit, latestDeposit, recordDeposit, updateDeposit } from '../../../lib/anchor/state.mjs';
import { loadAccount } from '../../../lib/stellar/horizon.mjs';
import { getWallet, unlockWallet } from '../../../lib/stellar/keystore.mjs';
import { resolveNetwork } from '../../../lib/stellar/network.mjs';
import { hasUsdcTrustline, usdcBalance } from '../../../lib/stellar/trustline.mjs';

const USAGE = `algoria topup — mock TRY into testnet USDC

  start      open a deposit and print the bank details to pay
  status     check, or follow, the deposit already open
  history    every deposit this wallet has opened at the anchor

Options
  --try <amount>   start: how many mock lira to send (e.g. --try 200)
  --new            start: open another deposit even if one is still open
  --id <id>        status: a specific deposit instead of the newest
  --wait           status: poll until the USDC lands or the deposit fails
  --timeout <s>    status --wait: give up after this long (default 180)
  --network        testnet only; the anchor does not exist on pubnet
  --json           machine-readable output`;

/** @typedef {Record<string, string | boolean>} Flags */

const POLL_INTERVAL_MS = 3000;

/**
 * Everything a command needs before it can talk to the anchor: a wallet that
 * exists, is funded, and can actually hold the USDC it is about to buy.
 * @param {Flags} flags
 */
async function requireReadyWallet(flags) {
  const network = resolveNetwork(flags.network ?? 'testnet');
  assertAnchorNetwork(network);

  const entry = await getWallet(network.id);
  if (!entry) {
    throw new Error(`no testnet wallet on this machine. Run \`${WALLET} onboard --network testnet\` first.`);
  }
  const account = await loadAccount(network, entry.publicKey);
  if (!account.exists) {
    throw new Error(`${entry.publicKey} is not funded yet. Run \`${WALLET} onboard --network testnet\`.`);
  }
  if (!hasUsdcTrustline(account, network)) {
    throw new Error(
      `${entry.publicKey} has no USDC trustline, so the anchor cannot pay it. Run \`${WALLET} trustline --network testnet\`.`
    );
  }
  return { network, publicKey: entry.publicKey, usdc: usdcBalance(account, network) };
}

/**
 * @param {import('../../../lib/stellar/network.mjs').NetworkProfile} network
 * @returns {Promise<string>}
 */
async function login(network) {
  const { keypair } = await unlockWallet(network.id, null);
  return authenticate(keypair);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plain English for a SEP-6 status, so the agent does not have to invent one.
 * @param {string} status
 */
function explain(status) {
  switch (status) {
    case 'pending_user_transfer_start':
      return 'waiting for your transfer';
    case 'pending_anchor':
      return 'lira received, buying USDC';
    case 'pending_stellar':
      return 'sending the USDC on-chain';
    case 'pending_trust':
      return 'blocked: the account needs a USDC trustline';
    case 'completed':
      return 'done';
    case 'error':
      return 'failed at the anchor';
    case 'refunded':
      return 'refunded';
    case 'expired':
      return 'expired';
    default:
      return status;
  }
}

const SELF = commandName('topup', 'topup.mjs');
const WALLET = commandName('wallet', 'wallet.mjs');

/** @type {Record<string, (flags: Flags) => Promise<void>>} */
const COMMANDS = {
  /** Open a deposit and hand the user the bank details. No money moves here. */
  async start(flags) {
    const { network, publicKey } = await requireReadyWallet(flags);
    const status = await verifyAnchor();
    const amountTry = normaliseTryAmount(String(flags.try ?? flags.amount ?? ''), status);

    // An open deposit is an unpaid bill. Opening a second one is how a user
    // ends up paying twice, so it takes an explicit --new.
    const open = await latestDeposit(publicKey);
    if (open && !isTerminal(open.status) && flags.new !== true) {
      emit(
        flags,
        { reused: true, ...open, estimateUsdc: null },
        [
          `Pay at     ${open.payUrl}`,
          `IBAN       ${open.iban}`,
          `Amount     ${open.amountTry} TRY`,
          `Reference  ${open.reference}`,
          '',
          `Deposit ${open.id} is still open — ${explain(open.status)}.`,
          'Finish or abandon that one first. `--new` opens another anyway.'
        ]
      );
      return;
    }

    const jwt = await login(network);
    const order = await createDeposit({ jwt, publicKey, amountTry });
    const record = await recordDeposit({
      id: order.id,
      network: network.id,
      publicKey,
      amountTry,
      iban: order.iban,
      reference: order.reference,
      payUrl: order.payUrl,
      status: 'pending_user_transfer_start'
    });
    const estimate = estimateUsdc(amountTry, status);

    emit(
      flags,
      { reused: false, ...record, estimateUsdc: estimate, environment: status.environment },
      // The payment details lead, one per line. Agent hosts often show only the
      // first few lines of a command's output, and these are the lines the user
      // cannot proceed without.
      [
        `Pay at     ${order.payUrl}`,
        `IBAN       ${order.iban}`,
        `Amount     ${amountTry} TRY  (about ${estimate} USDC at today's rate)`,
        `Reference  ${order.reference}  (must appear in the transfer description)`,
        `Bank       ${order.bankName}`,
        '',
        `Deposit ${record.id} opened. Nothing has been paid yet.`,
        'This is a sandbox: no real bank, no real lira. On the page above, press',
        '"Simulate incoming TRY transfer" to stand in for the bank transfer.',
        '',
        `Then follow it with:  ${SELF} status --wait`
      ]
    );
  },

  /** Where is the money. Optionally, wait for it. */
  async status(flags) {
    const { network, publicKey } = await requireReadyWallet(flags);
    const jwt = await login(network);

    const id = await resolveDepositId(flags, { jwt, publicKey });
    const deadline = Date.now() + Number(flags.timeout ?? 180) * 1000;

    let deposit = await getDeposit({ jwt, id });
    while (flags.wait === true && !isTerminal(deposit.status) && Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      deposit = await getDeposit({ jwt, id });
    }
    await updateDeposit(id, {
      status: deposit.status,
      amountOut: deposit.amountOut,
      stellarTransactionId: deposit.stellarTransactionId
    });

    // The anchor saying "completed" and the wallet holding the USDC are two
    // different claims. Report the second one.
    const account = await loadAccount(network, publicKey);
    const balance = usdcBalance(account, network);

    const lines = [`Deposit ${deposit.id}: ${deposit.status} — ${explain(deposit.status)}`];
    if (isSuccess(deposit.status)) {
      lines.push(
        `Received ${deposit.amountOut} USDC for ${deposit.amountIn} TRY (fee ${deposit.fee ?? '0'} TRY).`,
        `Wallet balance: ${balance ?? 'none'} USDC`,
        deposit.stellarTransactionId ? `${network.explorer}/tx/${deposit.stellarTransactionId}` : ''
      );
      if (deposit.claimableBalanceId) {
        lines.push('The USDC came as a claimable balance: the trustline was missing when it was paid.');
      }
    } else if (!isTerminal(deposit.status)) {
      lines.push(
        deposit.status === 'pending_user_transfer_start'
          ? `Nothing received yet. Pay at ${ANCHOR.base}/sep6/tx/${deposit.id}`
          : 'Still moving. Run again with --wait.'
      );
    } else {
      lines.push('This deposit will not complete. Nothing was charged that the anchor has not refunded.');
    }

    emit(
      flags,
      {
        id: deposit.id,
        status: deposit.status,
        settled: isSuccess(deposit.status),
        pending: !isTerminal(deposit.status),
        amountIn: deposit.amountIn,
        amountOut: deposit.amountOut,
        fee: deposit.fee,
        transaction: deposit.stellarTransactionId,
        claimableBalanceId: deposit.claimableBalanceId,
        usdc: balance,
        payUrl: `${ANCHOR.base}/sep6/tx/${deposit.id}`
      },
      lines.filter(Boolean)
    );
  },

  /** The anchor's own record, which outlives this machine's. */
  async history(flags) {
    const { network } = await requireReadyWallet(flags);
    const jwt = await login(network);
    const deposits = await listDeposits({ jwt });

    emit(
      flags,
      { deposits },
      deposits.length === 0
        ? ['No deposits at the anchor for this wallet.']
        : deposits.map(
            (entry) =>
              `${entry.id}  ${entry.status.padEnd(28)} ${entry.amountIn ?? '-'} TRY -> ${entry.amountOut ?? '-'} USDC`
          )
    );
  }
};

/**
 * Which deposit this command is about. Prefers what was asked for, then what
 * this machine remembers, and falls back to the anchor's own list — a lost
 * state file is a reason to look the deposit up, never to open a new one.
 *
 * @param {Flags} flags
 * @param {{jwt: string, publicKey: string}} session
 * @returns {Promise<string>}
 */
async function resolveDepositId(flags, { jwt, publicKey }) {
  if (typeof flags.id === 'string') {
    return (await findDeposit(flags.id))?.id ?? flags.id;
  }
  const local = await latestDeposit(publicKey);
  if (local) return local.id;

  const remote = await listDeposits({ jwt });
  if (remote.length === 0) {
    throw new Error(`no deposit to check. Run \`${SELF} start --try <amount>\` first.`);
  }
  return (remote.find((entry) => !isTerminal(entry.status)) ?? remote[0]).id;
}

/**
 * @param {string[]} argv arguments after the script name
 * @returns {Promise<void>}
 */
export function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    const command = positional[0];
    if (!command || flags.help === true) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new Error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    await handler(flags);
  });
}

// Runnable on its own, which is how the skills invoke it, and importable by
// `bin/algoria.mjs`, which is how `npx algoria` invokes it. The guard keeps the
// import side-effect-free so the dispatcher can pass its own argv.
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));

