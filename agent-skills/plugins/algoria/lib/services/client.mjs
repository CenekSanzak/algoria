import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withLock } from '../lock.mjs';
import { unlockWallet } from '../stellar/keystore.mjs';
import { API_BASE, apiError, apiFetch, jobUrl, serviceUrl } from './api.mjs';
import { getService } from './discovery.mjs';
import { validateChallenge } from './policy.mjs';
import { loadServicesSdk } from './sdk.mjs';
import { editLedger, getBudget, publicJob, readJob, readLedger, reserveBudget, updateJob } from './state.mjs';
import { quoteExternal, runExternal } from './external-client.mjs';

/** @param {string} service @param {unknown} input @param {string} budget @param {string} [id] @param {string} [method] */
export async function quote(service, input, budget, id = randomUUID(), method) {
  if (service.startsWith('stellar8004:')) return quoteExternal(service, input, budget, id, method);
  if (method && method !== 'POST') throw new Error('Algoria services require POST');
  jobUrl(id);
  return withLock(`job-${id}`, async () => {
    await getBudget(budget);
    const body = JSON.stringify(input);
    if (body === undefined || Buffer.byteLength(body) > 32768) throw new Error('service input must be JSON of at most 32768 bytes');
    const saved = (await readLedger()).jobs[id];
    if (saved && (saved.service !== service || saved.budget !== budget || saved.body !== body)) throw new Error('job identity already has different input, service or budget');
    if (saved) return publicJob(await requestQuote(saved));
    const contract = await getService(service);
    const { validateInput } = await loadServicesSdk();
    validateInput(contract.input_schema, input);
    const job = {
      id, token: randomBytes(32).toString('base64url'), apiBase: API_BASE,
      service, serviceVersion: contract.version, resource: serviceUrl(service),
      body, budget, expectedOffer: contract.accepts[0], outputSchema: contract.output_schema,
      phase: 'prepared', status: 'awaiting_payment', createdAt: new Date().toISOString()
    };
    // Persist identity before any POST; even a failed quote can be resumed by ID.
    await editLedger((state) => { state.jobs[id] = job; });
    try { return publicJob(await requestQuote(job)); }
    catch (error) { throw new Error(`Job ${id} saved. ${error instanceof Error ? error.message : 'quote failed'}. Resume this ID.`); }
  });
}

/** @param {any} job @param {string} [signature] */
function post(job, signature) {
  if (job.apiBase !== API_BASE || job.resource !== serviceUrl(job.service)) throw new Error('saved job uses an untrusted API');
  return apiFetch(`${job.resource}?mode=sync&wait_ms=45000`, {
    method: 'POST', headers: {
      'content-type': 'application/json', 'Idempotency-Key': job.id, 'X-Recovery-Token': job.token,
      ...(signature ? { 'PAYMENT-SIGNATURE': signature } : {})
    }, body: job.body
  }, 90_000);
}

/** @param {any} job */
async function requestQuote(job) {
  if (job.dispatchedAt || job.signature) throw new Error('payment attempt already exists; use status/run on the saved job');
  const { response, body } = await post(job);
  if (response.status !== 402) {
    if (body?.job_id === job.id && body.status) return acceptResult(job, response, body);
    throw apiError(response, body);
  }
  const validated = await validateChallenge(job, response, body);
  return updateJob(job.id, { ...validated, phase: 'quoted', status: 'awaiting_payment' });
}

/** @param {any} job @param {Response} response @param {any} body */
async function acceptResult(job, response, body) {
  if (body?.job_id !== job.id || body.service_id !== job.service || body.service_version !== job.serviceVersion ||
      body.status_url !== jobUrl(job.id) || typeof body.status !== 'string') throw new Error('job response identity mismatch');
  let payment = body.payment ?? job.payment ?? null;
  const encoded = response.headers.get('PAYMENT-RESPONSE');
  if (encoded) {
    const { decodePaymentResponseHeader } = await loadServicesSdk();
    if (!isDeepStrictEqual(decodePaymentResponseHeader(encoded), body.payment)) throw new Error('payment receipt header/body mismatch');
  }
  if (payment) {
    if (payment.network !== 'stellar:testnet' ||
        (payment.amount !== undefined && payment.amount !== (job.offer ?? job.expectedOffer).amount) ||
        (payment.payer && job.payer && payment.payer !== job.payer) ||
        (payment.success === true && !/^[a-f0-9]{64}$/i.test(payment.transaction))) throw new Error('payment receipt mismatch');
    // Keep only protocol receipt fields, not arbitrary server-provided extras.
    payment = { success: payment.success, network: payment.network, transaction: payment.transaction, ...(payment.payer ? { payer: payment.payer } : {}), ...(payment.amount ? { amount: payment.amount } : {}) };
  }
  if (body.status === 'succeeded') {
    if (payment?.success !== true || !body.output) throw new Error('successful job is missing its receipt or output');
    const { validateInput } = await loadServicesSdk();
    validateInput(job.outputSchema, body);
  }
  const uncertain = body.status.endsWith('-uncertain') || (body.status === 'awaiting_payment' && job.dispatchedAt);
  return updateJob(job.id, {
    status: body.status, payment, output: body.output ?? null,
    error: body.error?.code ? { code: String(body.error.code).slice(0, 100) } : null,
    phase: uncertain ? 'uncertain' : body.status === 'succeeded' ? 'complete' : body.status === 'failed' ? 'failed' : payment?.success === true ? 'settled' : job.phase,
    pollAfterMs: Number.isFinite(body.poll_after_ms) ? Math.max(1000, Math.min(30_000, body.poll_after_ms)) : 3000
  });
}

/** @param {any} job */
async function fetchStatus(job) {
  const { response, body } = await apiFetch(jobUrl(job.id), { headers: { authorization: `Bearer ${job.token}` } });
  if (response.status === 404) {
    if (job.dispatchedAt) return updateJob(job.id, { phase: 'uncertain', status: 'payment-uncertain' });
    // Only an unpaid saved identity may recover a lost initial POST.
    return requestQuote(job);
  }
  if (!response.ok) throw apiError(response, body);
  return acceptResult(job, response, body);
}

/** Pay at most once for this job. --approve represents the user's approved budget.
 * @param {string} id @param {{approve?: boolean}} [options]
 */
export async function runJob(id, { approve = false } = {}) {
  jobUrl(id);
  if ((await readJob(id)).source === 'stellar8004') return runExternal(id, { approve });
  return withLock(`job-${id}`, async () => {
    let job = await fetchStatus(await readJob(id));
    if (job.status === 'paid') {
      const result = await post(job);
      return publicJob(await acceptResult(job, result.response, result.body));
    }
    if (job.status !== 'awaiting_payment' || job.dispatchedAt) return publicJob(job);
    if (!approve) throw new Error('payment needs --approve within the user-approved named budget; review the saved quote first');
    if (!job.signature) job = await requestQuote(job);
    if (job.status !== 'awaiting_payment') return publicJob(job);
    if (Date.parse(job.expiresAt) <= Date.now()) throw new Error('quote expired; do not pay this job');
    const { keypair } = await unlockWallet('testnet', null);
    if (job.payer && job.payer !== keypair.publicKey) throw new Error('wallet changed since this job was authorized');
    await reserveBudget(id, job.offer.amount);
    job = await updateJob(id, { payer: keypair.publicKey });
    if (!job.signature) {
      const { signChallenge } = await loadServicesSdk();
      let signature;
      try { signature = await signChallenge(job.challenge, keypair.secretSeed); }
      catch { throw new Error(`Job ${id}: local payment signing failed; no authorization was dispatched`); }
      if (typeof signature !== 'string' || signature.length > 32768) throw new Error('invalid payment authorization size');
      job = await updateJob(id, { signature, phase: 'signed' });
    }
    // Written before fetch. A crash anywhere afterwards must never sign again.
    job = await updateJob(id, { phase: 'dispatched', dispatchedAt: new Date().toISOString() });
    try {
      const result = await post(job, job.signature);
      if (!result.body?.status) {
        await updateJob(id, { phase: 'uncertain', status: 'payment-uncertain' });
        throw apiError(result.response, result.body);
      }
      return publicJob(await acceptResult(job, result.response, result.body));
    } catch {
      await updateJob(id, { phase: 'uncertain' });
      throw new Error(`Job ${id}: payment response is uncertain. Use status for this ID; do not start or sign another payment. Its budget remains reserved.`);
    }
  });
}

/** Bounded status-only recovery; never signs or submits a new generation.
 * @param {string} id @param {{wait?: boolean, timeout?: number}} [options]
 */
export async function statusJob(id, { wait = false, timeout = 180 } = {}) {
  jobUrl(id);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600) throw new Error('timeout must be 0–3600 seconds');
  const saved = await readJob(id);
  if (saved.source === 'stellar8004') return publicJob(saved);
  return withLock(`job-${id}`, async () => {
    const deadline = Date.now() + timeout * 1000;
    let job = await fetchStatus(await readJob(id));
    const pending = new Set(['settling', 'submitting', 'queued', 'running', 'saving', 'result-ready']);
    while (wait && pending.has(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(job.pollAfterMs ?? 3000, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      job = await fetchStatus(job);
    }
    return publicJob(job);
  });
}

export async function listJobs() {
  return Object.values((await readLedger()).jobs).map(publicJob);
}
