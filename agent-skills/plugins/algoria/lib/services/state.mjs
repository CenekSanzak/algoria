import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { algoriaHome } from '../stellar/keystore.mjs';
import { withLock } from '../lock.mjs';
import { atomicAmount, displayAmount } from './policy.mjs';
import { deliveryFor } from './delivery.mjs';
import { journeyFor } from './journey.mjs';
import { approvePermission, verifyPermissionReceipt } from './permission-approval.mjs';
import { activePermission, permissionCovers, canonicalPermission, PERMISSION_RESOURCE } from './permission-schema.mjs';

/** @typedef {{total: string, perCall: string, reservations: Record<string, string>, protocol?: string, permission?: any, revokedAt?: string}} Budget */
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
  }, { waitMs: 5000 });
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

/** @param {string} name @param {string} total @param {string} perCall @param {string} [protocol]
 * @param {{agent?: string, recipient?: string, expires?: string}} [scope] */
export async function setBudget(name, total, perCall, protocol = 'x402', scope = {}) {
  budgetName(name);
  if (!['x402', 'mpp'].includes(protocol)) throw new Error('unsupported budget protocol');
  if (protocol === 'mpp' && (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(total) || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(perCall))) throw new Error('PathUSD amounts support at most six decimals');
  const totalAtomic = atomicAmount(total), perCallAtomic = atomicAmount(perCall);
  if (BigInt(perCallAtomic) > BigInt(totalAtomic)) throw new Error('per-call limit exceeds total budget');
  if (protocol === 'mpp') return withLock(`permission-${name}`, async () => {
    const previous = (await readLedger()).budgets[name];
    if (previous && (previous.protocol ?? 'x402') !== protocol) throw new Error('use a separate budget for each payment protocol');
    if (previous && committed(previous) > BigInt(totalAtomic)) throw new Error('budget is below already spent/reserved amount');
    const policy = { version: 1, id: randomUUID(), budget: name, agent: scope.agent,
      service: 'image.generate', resource: PERMISSION_RESOURCE, network: 'eip155:42431',
      token: '0x20c0000000000000000000000000000000000000', recipient: scope.recipient?.toLowerCase(),
      totalAtomic, perCallAtomic, validAfter: Math.floor(Date.now() / 1000),
      validUntil: Math.floor(Date.parse(scope.expires ?? '') / 1000), previousId: previous?.permission?.policy.id ?? null };
    canonicalPermission(policy); activePermission(policy);
    const receipt = await approvePermission(policy);
    verifyPermissionReceipt(receipt, policy); activePermission(policy);
    await editLedger(state => {
      const current = state.budgets[name];
      if (JSON.stringify(current?.permission) !== JSON.stringify(previous?.permission) || current?.revokedAt !== previous?.revokedAt) throw new Error('Permission changed during approval; review again');
      if (current && committed(current) > BigInt(totalAtomic)) throw new Error('budget is below already spent/reserved amount');
      state.budgets[name] = { total: totalAtomic, perCall: perCallAtomic,
        reservations: current?.reservations ?? {}, protocol: 'mpp', permission: receipt };
    });
    return getBudget(name);
  }, { waitMs: 5000 });
  await editLedger((state) => {
    const previous = Object.hasOwn(state.budgets, name) ? state.budgets[name] : null;
    if (previous && (previous.protocol ?? 'x402') !== protocol) throw new Error('use a separate budget for each payment protocol');
    if (previous && committed(previous) > BigInt(totalAtomic)) throw new Error('budget is below already spent/reserved amount');
    state.budgets[name] = { total: totalAtomic, perCall: perCallAtomic, reservations: previous?.reservations ?? {}, ...(protocol === 'mpp' ? { protocol: 'mpp' } : {}) };
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
  let permission;
  if (budget.protocol === 'mpp') {
    try { const p = verifyPermissionReceipt(budget.permission); activePermission(p);
      permission = { id: p.id, agent: p.agent, recipient: p.recipient, service: p.service,
        expiresAt: new Date(p.validUntil * 1000).toISOString(), state: budget.revokedAt ? 'revoked' : 'active', enforcement: 'local-only', purchaseTouchIDRequired: true };
    } catch { permission = { state: budget.permission ? 'expired-or-invalid' : 'approval-required', enforcement: 'local-only', purchaseTouchIDRequired: true }; }
    if (budget.revokedAt) permission.state = 'revoked';
  }
  return { name, total: displayAmount(budget.total), perCall: displayAmount(budget.perCall), spent: displayAmount(String(spent)), reserved: displayAmount(String(used - spent)), remaining: displayAmount(String(BigInt(budget.total) - used)), unit: budget.protocol === 'mpp' ? 'test PathUSD' : 'test USDC', ...(budget.protocol === 'mpp' ? { protocol: 'mpp', network: 'eip155:42431', token: '0x20c0000000000000000000000000000000000000', decimals: 6, permission } : {}) };
}

/** Local stop needs no biometric. Submitted payments/recovery are unaffected.
 * @param {string} name */
export async function revokeBudget(name) {
  budgetName(name);
  await editLedger(state => {
    const budget = state.budgets[name];
    if (!budget || budget.protocol !== 'mpp') throw new Error('unknown Tempo budget');
    budget.revokedAt ??= new Date().toISOString();
  });
  return { ...await getBudget(name), revocation: 'local-effective', onChainRevocation: 'not-applicable', note: 'Stops new signatures locally. Submitted payments and their recovery are unaffected.' };
}

/** @param {Budget} budget @param {any} job @param {string} amount @param {boolean} [rebind] */
function checkPermission(budget, job, amount, rebind = false) {
  if (budget.protocol !== 'mpp') return;
  if (budget.revokedAt) throw new Error('Spending permission revoked locally');
  const p = verifyPermissionReceipt(budget.permission);
  permissionCovers(p, job, amount);
  if (p.totalAtomic !== budget.total || p.perCallAtomic !== budget.perCall) throw new Error('Budget differs from biometric approval');
  if (job.permissionId && job.permissionId !== p.id && !rebind) throw new Error('Saved purchase permission changed; review this same task again');
  job.permissionId = p.id;
}

/** @param {string} id */
export async function purchasePermission(id) {
  return editLedger(state => {
    const job = state.jobs[id], budget = job && state.budgets[job.budget];
    if (!budget || !budget.reservations[id]) throw new Error('Missing spending reservation');
    checkPermission(budget, job, budget.reservations[id]);
    return budget.permission;
  });
}

/** Revocation/expiry check and dispatch record are one atomic write.
 * @param {string} id @param {any} record */
export async function saveTempoDispatch(id, record) {
  return editLedger(state => {
    const job = state.jobs[id], budget = job && state.budgets[job.budget];
    if (!budget || !budget.reservations[id]) throw new Error('Missing spending reservation');
    if (job.dispatchedAt) throw new Error('Payment dispatch already saved');
    checkPermission(budget, job, budget.reservations[id]);
    Object.assign(job, record, { uxStage: null, dispatchedAt: new Date().toISOString(), phase: 'dispatched' });
    return job;
  });
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
    if ((budget.protocol ?? 'x402') !== (job.protocol ?? 'x402')) throw new Error('budget payment protocol mismatch');
    // A fresh explicit same-task run may adopt a newly biometric-approved scope
    // only before dispatch. It still has to pass all caps/scope and Touch ID.
    if (job.protocol === 'mpp' && job.dispatchedAt) throw new Error('Payment dispatch already saved; recover this job');
    checkPermission(budget, job, amount, true);
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
    ...(job.permissionId ? { permissionId: job.permissionId } : {}),
    source: job.source ?? 'algoria',
    status: job.status, phase: job.phase,
    amount: offer?.amount ? displayAmount(String(BigInt(offer.amount) * (job.protocol === 'mpp' ? 10n : 1n))) : null, unit: job.transport === 'mcp' ? null : job.protocol === 'mpp' ? 'test PathUSD' : 'test USDC',
    ...(job.protocol === 'mpp' ? { protocol: 'mpp', network: 'eip155:42431', token: '0x20c0000000000000000000000000000000000000', decimals: 6 } : {}),
    ...(job.transport === 'mcp' ? { transport: 'mcp', tool: job.tool, protocol: job.protocol } : {}),
    payTo: offer?.payTo ?? null, expiresAt: job.expiresAt ?? null,
    payment: job.payment ?? null, output: job.output ?? null, error: job.error ?? null,
    delivery: deliveryFor(job),
    journey: journeyFor(job),
    requiresAttention: job.phase === 'uncertain' || String(job.status).endsWith('-uncertain'),
    ...(job.source === 'stellar8004' ? { endpoint: job.registeredEndpoint, method: job.method, registry: job.registry, statusSource: 'local', httpStatus: job.httpStatus ?? null } : {}),
    note: job.transport === 'mcp' ? 'MCP call, no x402 payment sent. Status is local only. Never redispatch an uncertain call; it may have performed a remote action.' : job.phase === 'uncertain' ? 'Do not pay again. Reconcile this existing job; its budget remains reserved.' : job.source === 'stellar8004' ? 'External service: status reads only the saved response. No automatic retry, remote polling or Algoria recovery token.' : undefined
  };
}
