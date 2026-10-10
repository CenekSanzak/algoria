import { randomUUID } from 'node:crypto';
import { withLock } from '../lock.mjs';
import { readJob, publicJob, getBudget } from './state.mjs';
import { quoteTempo } from './tempo-client.mjs';
import { runJob, statusJob } from './client.mjs';
import { tempoReadiness } from './tempo-readiness.mjs';
import { normalizeTempoInput } from './tempo-services.mjs';

/** Prepare/execute/recover one durable Tempo task. Budgets are never invented.
 * No --approve means read-only recovery (or an unpaid quote for a new task).
 * @param {{id?: string, service?: string, input?: any, budget?: string, approve?: boolean, fundTestnet?: boolean, wait?: boolean, timeout?: number}} options
 */
export async function tempoTask(options) {
  const id = options.id ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('task ID must be a UUID v4');
  if (!Number.isFinite(options.timeout ?? 180) || (options.timeout ?? 180) < 0 || (options.timeout ?? 180) > 3600) throw new Error('timeout must be 0–3600 seconds');
  return withLock(`task-${id}`, async () => {
    let saved;
    try { saved = await readJob(id); } catch (error) {
      if (!String(error).includes('no local job')) throw error;
    }
    const service = options.service ?? saved?.service ?? 'image.generate';
    const input = options.input === undefined ? undefined : normalizeTempoInput(service, options.input);
    if (saved && (saved.protocol !== 'mpp' || saved.service !== service)) throw new Error('Saved task service changed; recover the original Tempo task');
    if (saved && ((input && JSON.stringify(input) !== saved.body) || (options.budget && options.budget !== saved.budget))) throw new Error('Saved task input/budget changed; recover the original task');
    if (!saved && (!input || !options.budget)) throw new Error('A new Tempo task requires input and an approved named budget');
    try {
      let job = saved ? (saved.phase === 'prepared' && !saved.dispatchedAt
        ? await quoteTempo(service, JSON.parse(saved.body), saved.budget, id)
        : publicJob(saved)) : await quoteTempo(service, input, /** @type {string} */ (options.budget), id);
      const readiness = tempoReadiness();
      if (options.approve) {
        const needsSigner = !(await readJob(id)).dispatchedAt && job.status === 'awaiting_payment';
        const spending = await getBudget(/** @type {string} */ (job.budget));
        if (needsSigner && (spending.permission?.state !== 'active' || spending.permission?.service !== job.service ||
            spending.permission?.recipient !== job.payTo?.toLowerCase())) return { ...job, readiness, spending,
          interrupted: false, paymentAttempted: false, nextAction: 'review-spending-permission',
          message: 'This budget needs a Touch ID-approved permission for this exact service and recipient before spending. Keep this same task; review its scope and expiry.' };
        if (needsSigner && !readiness.ready) return { ...job, readiness, interrupted: false,
          nextAction: readiness.nextAction, paymentAttempted: false };
        job = await runJob(id, { approve: true, fundTestnet: options.fundTestnet });
      } else if (saved) {
        // Only the same identity may repair a lost initial unpaid quote POST.
        job = await statusJob(id);
      }
      if (options.wait && ['settling', 'submitting', 'queued', 'running', 'saving', 'result-ready'].includes(job.status)) job = await statusJob(id, { wait: true, timeout: options.timeout });
      return { ...job, readiness, interrupted: false, spending: await getBudget(/** @type {string} */ (job.budget)), nextAction: job.journey.nextAction };
    } catch (error) {
      // Recoverable failures still return the task identity; never leak HTTP/IPC data.
      let recovered;
      try { recovered = await readJob(id); } catch { throw error; }
      const job = publicJob(recovered);
      if (job.fundingIssue && !recovered.dispatchedAt) return { ...job, interrupted: true,
        paymentAttempted: false, nextAction: 'retry-wallet-funding',
        message: 'Wallet funding stopped before signing. Retry this same task when ready. Only send test PathUSD to the address shown in the currently open wallet; a closed temporary wallet cannot receive a usable top-up.' };
      return { ...job, interrupted: true, nextAction: 'resume-same-task',
        message: job.requiresAttention ? 'This task needs reconciliation. Keep its receipt and reserved budget; do not pay again.' : 'The task could not finish this step. Resume this same task; no automatic replacement purchase was created.' };
    }
  });
}

/** Backwards-compatible image-only coordinator.
 * @param {Parameters<typeof tempoTask>[0]} options */
export function imageTask(options) {
  return tempoTask({ ...options, service: 'image.generate' });
}
