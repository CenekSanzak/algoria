/**
 * What the machine remembers about deposits.
 *
 * `~/.algoria/anchor.json`, next to the wallet, owner-readable only. It holds
 * no secret — a deposit id, an amount, a status — but it is the reason the
 * skill cannot bill a user twice: a deposit id written down before the money
 * is sent can always be found again, and a deposit that is still open blocks a
 * second one from being opened by mistake.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { algoriaHome } from '../stellar/keystore.mjs';

export const STATE_VERSION = 1;

/** @returns {string} */
export function anchorStatePath() {
  return join(algoriaHome(), 'anchor.json');
}

/**
 * @typedef {object} DepositRecord
 * @property {string} id
 * @property {string} network
 * @property {string} publicKey
 * @property {string} amountTry
 * @property {string} iban
 * @property {string} reference
 * @property {string} payUrl
 * @property {string} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} amountOut
 * @property {string | null} stellarTransactionId
 */

/**
 * @typedef {object} AnchorState
 * @property {number} version
 * @property {DepositRecord[]} deposits newest last
 */

/** @returns {Promise<AnchorState>} */
export async function readState() {
  try {
    const parsed = JSON.parse(await readFile(anchorStatePath(), 'utf8'));
    if (parsed.version !== STATE_VERSION) return { version: STATE_VERSION, deposits: [] };
    return { version: STATE_VERSION, deposits: Array.isArray(parsed.deposits) ? parsed.deposits : [] };
  } catch {
    return { version: STATE_VERSION, deposits: [] };
  }
}

/**
 * Written to a temp file and renamed, so a crash mid-write leaves the previous
 * state rather than half of this one.
 * @param {AnchorState} state
 */
async function writeState(state) {
  const path = anchorStatePath();
  await mkdir(algoriaHome(), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/**
 * @param {Omit<DepositRecord, 'createdAt' | 'updatedAt' | 'amountOut' | 'stellarTransactionId'>} record
 * @returns {Promise<DepositRecord>}
 */
export async function recordDeposit(record) {
  const state = await readState();
  const now = new Date().toISOString();
  /** @type {DepositRecord} */
  const full = { ...record, createdAt: now, updatedAt: now, amountOut: null, stellarTransactionId: null };
  state.deposits = [...state.deposits.filter((entry) => entry.id !== record.id), full];
  await writeState(state);
  return full;
}

/**
 * @param {string} id
 * @param {Partial<DepositRecord>} patch
 * @returns {Promise<DepositRecord | null>}
 */
export async function updateDeposit(id, patch) {
  const state = await readState();
  const index = state.deposits.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const updated = { ...state.deposits[index], ...patch, updatedAt: new Date().toISOString() };
  state.deposits[index] = updated;
  await writeState(state);
  return updated;
}

/**
 * The deposit a bare `status` means: the newest one for this wallet.
 * @param {string} publicKey
 * @returns {Promise<DepositRecord | null>}
 */
export async function latestDeposit(publicKey) {
  const state = await readState();
  const mine = state.deposits.filter((entry) => entry.publicKey === publicKey);
  return mine.length > 0 ? mine[mine.length - 1] : null;
}

/**
 * @param {string} id
 * @returns {Promise<DepositRecord | null>}
 */
export async function findDeposit(id) {
  const state = await readState();
  return state.deposits.find((entry) => entry.id === id) ?? null;
}
