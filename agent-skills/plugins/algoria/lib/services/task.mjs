import { randomUUID } from 'node:crypto';
import { withLock } from '../lock.mjs';
import { readJob, publicJob, getBudget } from './state.mjs';
import { quoteTempo } from './tempo-client.mjs';
import { runJob, statusJob } from './client.mjs';
import { tempoReadiness } from './tempo-readiness.mjs';

/** Prepare/execute/recover one durable image task. Budgets are never invented.
 * No --approve means read-only recovery (or an unpaid quote for a new task).
 * @param {{id?: string, input?: any, budget?: string, approve?: boolean, fundTestnet?: boolean, wait?: boolean, timeout?: number}} options
 */
export async function imageTask(options) {
  if (options.input && (Object.keys(options.input).length !== 1 || typeof options.input.prompt !== 'string' || !options.input.prompt.trim() || options.input.prompt.length > 4000)) throw new Error('An image task needs one prompt, at most 4000 characters');
  const id = options.id ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('task ID must be a UUID v4');
  if (!Number.isFinite(options.timeout ?? 180) || (options.timeout ?? 180) < 0 || (options.timeout ?? 180) > 3600) throw new Error('timeout must be 0–3600 seconds');
  return withLock(`task-${id}`, async () => {
    let saved;
    try { saved = await readJob(id); } catch (error) {
      if (!String(error).includes('no local job')) throw error;
    }
    if (saved && (saved.protocol !== 'mpp' || saved.service !== 'image.generate')) throw new Error('This task is not a Tempo image purchase');
    if (saved && ((options.input && JSON.stringify({ prompt: options.input.prompt?.trim() }) !== saved.body) || (options.budget && options.budget !== saved.budget))) throw new Error('Saved task input/budget changed; recover the original task');
    if (!saved && (!options.input || !options.budget)) throw new Error('A new image task requires input and an approved named budget');
    try {
      let job = saved ? (saved.phase === 'prepared' && !saved.dispatchedAt
        ? await quoteTempo('image.generate', JSON.parse(saved.body), saved.budget, id)
        : publicJob(saved)) : await quoteTempo('image.generate', options.input, /** @type {string} */ (options.budget), id);
      const readiness = tempoReadiness();
      if (options.approve) {
        const needsSigner = !(await readJob(id)).dispatchedAt && job.status === 'awaiting_payment';
        const spending = await getBudget(/** @type {string} */ (job.budget));
        if (needsSigner && spending.permission?.state !== 'active') return { ...job, readiness, spending,
          interrupted: false, paymentAttempted: false, nextAction: 'review-spending-permission',
          message: 'This budget needs a new Touch ID-approved permission before spending. Keep this same task; review its scope and expiry.' };
        if (needsSigner && (!readiness.ready || !options.fundTestnet)) return { ...job, readiness, interrupted: false,
          nextAction: !readiness.ready ? readiness.nextAction : 'Confirm disposable Tempo testnet faucet funding; then approve this same task.', paymentAttempted: false };
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
      return { ...job, interrupted: true, nextAction: 'resume-same-task',
        message: job.requiresAttention ? 'This task needs reconciliation. Keep its receipt and reserved budget; do not pay again.' : 'The task could not finish this step. Resume this same task; no automatic replacement purchase was created.' };
    }
  });
}
