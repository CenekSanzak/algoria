/**
 * SEP-6: opening a deposit and following it.
 *
 * A deposit is an order, not a payment. Creating one returns bank details and
 * a reference; the lira arrive separately, when the user sends them. Nothing
 * here moves money, and nothing here simulates the transfer — that is the
 * user's step, on the anchor's own page.
 */

import { anchorFetch } from './anchor.mjs';

/** Statuses that will never change again. */
const TERMINAL = new Set(['completed', 'error', 'refunded', 'expired']);

/** @param {string} status */
export function isTerminal(status) {
  return TERMINAL.has(status);
}

/** @param {string} status */
export function isSuccess(status) {
  return status === 'completed';
}

/**
 * @typedef {object} DepositOrder
 * @property {string} id
 * @property {string} bankName
 * @property {string} iban
 * @property {string} reference written in the transfer description
 * @property {string} payUrl the anchor's page for this deposit
 */

/**
 * Open a deposit. Returns the instructions the user needs to pay.
 *
 * @param {object} options
 * @param {string} options.jwt
 * @param {string} options.publicKey
 * @param {string} options.amountTry
 * @returns {Promise<DepositOrder>}
 */
export async function createDeposit({ jwt, publicKey, amountTry }) {
  const query = new URLSearchParams({
    asset_code: 'USDC',
    account: publicKey,
    amount: amountTry,
    funding_method: 'bank_account'
  });

  let body;
  try {
    body = await anchorFetch(`/sep6/deposit?${query}`, { jwt });
  } catch (error) {
    // The sandbox accepts anyone, but SEP-6 lets an anchor demand KYC first.
    // Its KYC is a formality: any PUT is accepted, no personal data needed.
    if (/** @type {any} */ (error)?.status === 403) {
      await anchorFetch('/sep12/customer', { method: 'PUT', jwt, body: {} });
      body = await anchorFetch(`/sep6/deposit?${query}`, { jwt });
    } else {
      throw error;
    }
  }

  const instructions = body?.instructions ?? {};
  const id = String(body?.id ?? '');
  if (!id) throw new Error('the anchor opened no deposit');

  return {
    id,
    bankName: String(instructions.bank_name?.value ?? 'TR Mock Bank'),
    iban: String(instructions.bank_account_number?.value ?? ''),
    reference: String(instructions.external_transfer_memo?.value ?? ''),
    payUrl: `https://tr-mock-anchor.fly.dev/sep6/tx/${id}`
  };
}

/**
 * @typedef {object} DepositState
 * @property {string} id
 * @property {string} status
 * @property {string | null} amountIn TRY the anchor received
 * @property {string | null} amountOut USDC paid out
 * @property {string | null} fee
 * @property {string | null} stellarTransactionId
 * @property {string | null} claimableBalanceId set when the account had no trustline
 */

/**
 * @param {object} options
 * @param {string} options.jwt
 * @param {string} options.id
 * @returns {Promise<DepositState>}
 */
export async function getDeposit({ jwt, id }) {
  const body = await anchorFetch(`/sep6/transaction?id=${encodeURIComponent(id)}`, { jwt });
  const tx = body?.transaction ?? body;
  if (!tx?.id) throw new Error(`the anchor knows no deposit ${id}`);
  return {
    id: String(tx.id),
    status: String(tx.status ?? 'unknown'),
    amountIn: tx.amount_in ?? null,
    amountOut: tx.amount_out ?? null,
    fee: tx.amount_fee ?? null,
    stellarTransactionId: tx.stellar_transaction_id ?? null,
    claimableBalanceId: tx.claimable_balance_id ?? null
  };
}

/**
 * Every deposit this wallet has ever opened, newest first. This is the
 * recovery path: if the local record is lost, the anchor still has the order,
 * and opening a second one would be a second bill.
 *
 * @param {object} options
 * @param {string} options.jwt
 * @returns {Promise<DepositState[]>}
 */
export async function listDeposits({ jwt }) {
  const body = await anchorFetch('/sep6/transactions?asset_code=USDC&kind=deposit', { jwt });
  const transactions = Array.isArray(body?.transactions) ? body.transactions : [];
  return transactions.map((/** @type {any} */ tx) => ({
    id: String(tx.id),
    status: String(tx.status ?? 'unknown'),
    amountIn: tx.amount_in ?? null,
    amountOut: tx.amount_out ?? null,
    fee: tx.amount_fee ?? null,
    stellarTransactionId: tx.stellar_transaction_id ?? null,
    claimableBalanceId: tx.claimable_balance_id ?? null
  }));
}
