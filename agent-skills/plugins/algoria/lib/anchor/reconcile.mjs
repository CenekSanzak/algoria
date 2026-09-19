import { ANCHOR } from './anchor.mjs';
import { getDeposit, isTerminal, listDeposits } from './sep6.mjs';
import { findDeposit, readState, recordDeposit, updateDeposit } from './state.mjs';

/** Persist remote recovery as well as refreshing existing local records.
 * @param {import('./sep6.mjs').DepositState} deposit
 * @param {string} publicKey
 */
export async function rememberDeposit(deposit, publicKey) {
  const local = await findDeposit(deposit.id);
  if (local && local.publicKey !== publicKey) throw new Error('deposit belongs to a different wallet');
  if (!local) {
    await recordDeposit({
      id: deposit.id, network: 'testnet', publicKey,
      amountTry: deposit.amountIn ?? 'unknown (see deposit page)',
      iban: deposit.iban || 'see deposit page',
      reference: deposit.reference || 'see deposit page',
      payUrl: `${ANCHOR.base}/sep6/tx/${encodeURIComponent(deposit.id)}`,
      status: deposit.status
    });
  }
  return /** @type {import('./state.mjs').DepositRecord} */ (await updateDeposit(deposit.id, {
    status: deposit.status, amountOut: deposit.amountOut, stellarTransactionId: deposit.stellarTransactionId
  }));
}

/** Consult remote history before opening anything; ambiguity is not a new bill.
 * @param {{jwt: string, publicKey: string}} session
 */
export async function reconcileDeposits({ jwt, publicKey }) {
  const remote = await listDeposits({ jwt });
  const known = (await readState()).deposits.filter((entry) => entry.publicKey === publicKey);
  // History may be bounded; do not lose a locally known older pending deposit.
  for (const local of known) {
    if (!isTerminal(local.status) && !remote.some((entry) => entry.id === local.id)) {
      remote.push(await getDeposit({ jwt, id: local.id }));
    }
  }
  const records = [];
  for (const deposit of remote.slice().reverse()) records.push(await rememberDeposit(deposit, publicKey));
  return records.filter((entry) => !isTerminal(entry.status));
}
