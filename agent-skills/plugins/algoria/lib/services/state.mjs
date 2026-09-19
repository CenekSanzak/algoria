import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { algoriaHome } from '../stellar/keystore.mjs';
import { withLock } from '../lock.mjs';
import { atomicAmount, displayAmount } from './policy.mjs';
import { deliveryFor } from './delivery.mjs';

/** @typedef {{total: string, perCall: string, reservations: Record<string, string>}} Budget */
/** @typedef {{version: number, budgets: Record<string, Budget>, jobs: Record<string, any>}} Ledger */
export const ledgerPath = () => join(algoriaHome(), 'services.json');

/** @returns {Promise<Ledger>} */
export async function readLedger() {
  let raw;
  try { raw = await readFile(ledgerPath(), 'utf8'); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return { version: 1, budgets: {}, jobs: {} };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.version !== 1 || !state.budgets || !state.jobs) throw new Error('invalid services state; preserve this file for recovery');
  return state;
}

/** @template T @param {(state: Ledger) => T} update @returns {Promise<T>} */
export async function editLedger(update) {
  return withLock('services-state', async () => {
    const state = await readLedger();
    const result = update(state);
    await mkdir(algoriaHome(), { recursive: true, mode: 0o700 });
    await chmod(algoriaHome(), 0o700);
    const temp = `${ledgerPath()}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, ledgerPath());
    return result;
  });
}

/** @param {string} name */
export function budgetName(name) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('budget name must use lowercase letters, digits and hyphens');
  return name;
}

/** @param {Budget} budget */
function committed(budget) {
  return Object.values(budget.reservations).reduce((sum, amount) => sum + BigInt(amount), 0n);
}

/** @param {string} name @param {string} total @param {string} perCall */
export async function setBudget(name, total, perCall) {
  budgetName(name);
  const totalAtomic = atomicAmount(total), perCallAtomic = atomicAmount(perCall);
  if (BigInt(perCallAtomic) > BigInt(totalAtomic)) throw new Error('per-call limit exceeds total budget');
  await editLedger((state) => {
    const previous = Object.hasOwn(state.budgets, name) ? state.budgets[name] : null;
    if (previous && committed(previous) > BigInt(totalAtomic)) throw new Error('budget is below already spent/reserved amount');
    state.budgets[name] = { total: totalAtomic, perCall: perCallAtomic, reservations: previous?.reservations ?? {} };
  });
  return getBudget(name);
}

/** @param {string} name */
export async function getBudget(name) {
  const state = await readLedger();
  if (!Object.hasOwn(state.budgets, name)) throw new Error(`unknown budget ${name}; configure it before paying`);
  const budget = state.budgets[name];
  const spent = Object.entries(budget.reservations).reduce((sum, [id, amount]) => sum + (state.jobs[id]?.payment?.success === true ? BigInt(amount) : 0n), 0n);
  const used = committed(budget);
  return { name, total: displayAmount(budget.total), perCall: displayAmount(budget.perCall), spent: displayAmount(String(spent)), reserved: displayAmount(String(used - spent)), remaining: displayAmount(String(BigInt(budget.total) - used)), unit: 'test USDC' };
}

/** @param {string} id */
export async function readJob(id) {
  const state = await readLedger();
  if (!Object.hasOwn(state.jobs, id)) throw new Error(`no local job ${id}; its recovery token is required`);
  return state.jobs[id];
}

/** @param {string} id @param {Record<string, any>} patch */
export async function updateJob(id, patch) {
  return editLedger((state) => {
    if (!Object.hasOwn(state.jobs, id)) throw new Error('job is missing');
    Object.assign(state.jobs[id], patch, { updatedAt: new Date().toISOString() });
    return state.jobs[id];
  });
}

/** Reserve atomically across every process/job sharing this named budget.
 * @param {string} id @param {string} amount
 */
export async function reserveBudget(id, amount) {
  await editLedger((state) => {
    const job = state.jobs[id];
    const budget = job && Object.hasOwn(state.budgets, job.budget) ? state.budgets[job.budget] : null;
    if (!budget) throw new Error('saved budget is missing');
    if (budget.reservations[id]) {
      if (budget.reservations[id] !== amount) throw new Error('payment reservation changed');
      return;
    }
    if (BigInt(amount) > BigInt(budget.perCall) || committed(budget) + BigInt(amount) > BigInt(budget.total)) {
      throw new Error('payment exceeds the per-call or remaining total budget');
    }
    budget.reservations[id] = amount;
  });
}

/** Explicit public projection: neither token nor payment authorization escapes.
 * @param {any} job
 */
export function publicJob(job) {
  const offer = job.offer ?? job.expectedOffer;
  return {
    id: job.id, service: job.service, serviceVersion: job.serviceVersion, budget: job.budget,
    source: job.source ?? 'algoria',
    status: job.status, phase: job.phase,
    amount: offer?.amount ? displayAmount(offer.amount) : null, unit: job.transport === 'mcp' ? null : 'test USDC',
    ...(job.transport === 'mcp' ? { transport: 'mcp', tool: job.tool, protocol: job.protocol } : {}),
    payTo: offer?.payTo ?? null, expiresAt: job.expiresAt ?? null,
    payment: job.payment ?? null, output: job.output ?? null, error: job.error ?? null,
    delivery: deliveryFor(job),
    requiresAttention: job.phase === 'uncertain' || String(job.status).endsWith('-uncertain'),
    ...(job.source === 'stellar8004' ? { endpoint: job.registeredEndpoint, method: job.method, registry: job.registry, statusSource: 'local', httpStatus: job.httpStatus ?? null } : {}),
    note: job.transport === 'mcp' ? 'MCP call, no x402 payment sent. Status is local only. Never redispatch an uncertain call; it may have performed a remote action.' : job.phase === 'uncertain' ? 'Do not pay again. Reconcile this existing job; its budget remains reserved.' : job.source === 'stellar8004' ? 'External service: status reads only the saved response. No automatic retry, remote polling or Algoria recovery token.' : undefined
  };
}
