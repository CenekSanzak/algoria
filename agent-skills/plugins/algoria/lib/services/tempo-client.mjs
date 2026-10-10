import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withLock } from '../lock.mjs';
import { API_BASE, apiFetch, apiError, serviceUrl, jobUrl } from './api.mjs';
import { getBudget, readLedger, editLedger, updateJob, readJob, publicJob, reserveBudget, saveTempoDispatch } from './state.mjs';
import { loadTempoSdk } from './tempo-sdk.mjs';
import { signAndPayTempo } from './tempo-signer.mjs';
import { loadServicesSdk } from './sdk.mjs';
import { normalizeTempoInput, tempoResource } from './tempo-services.mjs';
import { TempoFundingError } from './tempo-funding.mjs';

/** @param {any} job @param {string} [credential] @param {boolean} [asynchronous] */
async function post(job, credential, asynchronous = false) {
  if (job.apiBase !== API_BASE || job.resource !== tempoResource(job.service) || job.resource !== serviceUrl(job.service)) throw new Error('Untrusted MPP endpoint');
  return apiFetch(`${job.resource}${asynchronous ? '?mode=async' : '?mode=sync&wait_ms=45000'}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Payment-Protocol': 'mpp',
      'Idempotency-Key': job.id, 'X-Recovery-Token': job.token,
      ...(credential ? { Authorization: credential } : {}) }, body: job.body }, 90000);
}

/** @param {any} job @param {Response} response @param {any} body */
export async function validateMppQuote(job, response, body) {
  const sdk = await loadTempoSdk();
  const header = response.headers.get('WWW-Authenticate');
  if (response.status !== 402 || !header || header.length > 32768 || body.protocol !== 'mpp' || body.job_id !== job.id) throw new Error('Invalid MPP quote');
  const challenge = sdk.Challenge.deserialize(header);
  // The wire carries correlation data in opaque, not a separate meta field.
  challenge.meta = sdk.PaymentRequest.deserialize(challenge.opaque);
  if (!isDeepStrictEqual(challenge.meta, body.challenge?.meta)) throw new Error('MPP quote correlation mismatch');
  if (sdk.Challenge.serialize(challenge) !== sdk.Challenge.serialize(body.challenge) ||
      challenge.method !== 'tempo' || challenge.intent !== 'charge' ||
      challenge.realm !== new URL(job.resource).host || challenge.meta?.resource !== job.resource ||
      challenge.meta?.job_id !== job.id || challenge.meta?.input_hash !== job.inputHash ||
      Date.parse(body.expires_at) !== Date.parse(challenge.expires) ||
      !Number.isFinite(Date.parse(challenge.expires)) || Date.parse(challenge.expires) <= Date.now()) throw new Error('MPP quote identity mismatch');
  const offer = challenge.request;
  const expected = job.expectedOffer;
  if (offer.amount !== expected.amount || offer.currency.toLowerCase() !== expected.token ||
      offer.recipient.toLowerCase() !== expected.recipient || offer.methodDetails?.chainId !== 42431 ||
      JSON.stringify(offer.methodDetails.supportedModes) !== '["push"]' ||
      Object.keys(offer).some(k => !['amount', 'currency', 'recipient', 'methodDetails'].includes(k)) ||
      Object.keys(offer.methodDetails).some(k => !['chainId', 'supportedModes'].includes(k)) ||
      (job.challenge && sdk.Challenge.serialize(job.challenge) !== sdk.Challenge.serialize(challenge))) throw new Error('MPP quote price or destination changed');
  return { challenge: body.challenge, offer: { amount: offer.amount, payTo: offer.recipient }, expiresAt: challenge.expires };
}

/** @param {any} job */
async function requestQuote(job) {
  if (job.dispatchedAt || job.credential) throw new Error('Payment attempt already saved; recover this job');
  const result = await post(job);
  return updateJob(job.id, { ...await validateMppQuote(job, result.response, result.body), phase: 'quoted', status: 'awaiting_payment' });
}

/** @param {string} service @param {any} input @param {string} budget @param {string} [id] */
export async function quoteTempo(service, input, budget, id = randomUUID()) {
  jobUrl(id);
  const body = JSON.stringify(normalizeTempoInput(service, input));
  return withLock(`job-${id}`, async () => {
    if ((await getBudget(budget)).protocol !== 'mpp') throw new Error('Configure a separate --protocol mpp budget first');
    let job = (await readLedger()).jobs[id];
    if (job) {
      if (job.protocol !== 'mpp' || job.service !== service || job.body !== body || job.budget !== budget) throw new Error('Saved job identity conflict');
      return publicJob(await requestQuote(job));
    }
    const result = await apiFetch(serviceUrl(service), { headers: { 'X-Payment-Protocol': 'mpp' } });
    if (!result.response.ok) throw apiError(result.response, result.body);
    const contract = result.body;
    const offer = contract.mpp;
    if (contract.id !== service || contract.resource !== serviceUrl(service) ||
        offer?.protocol !== 'mpp' || offer.chain !== 'eip155:42431' || offer.decimals !== 6 ||
        offer.token !== '0x20c0000000000000000000000000000000000000' ||
        !/^0x[0-9a-f]{40}$/.test(offer.recipient) || !/^[1-9][0-9]{0,6}$/.test(offer.amount)) throw new Error('Unsupported MPP service metadata');
    const { validateInput } = await loadServicesSdk();
    validateInput(contract.input_schema, JSON.parse(body));
    if (service === 'phone.call' && (!Array.isArray(contract.preparation?.contacts) ||
        !contract.preparation.contacts.includes(JSON.parse(body).contact))) throw new Error('Choose an operator-approved phone contact');
    job = { id, protocol: 'mpp', chain: 'eip155:42431', tokenAsset: offer.token, decimals: 6,
      token: randomBytes(32).toString('base64url'), apiBase: API_BASE, resource: serviceUrl(service),
      service, serviceVersion: contract.version, body, budget, expectedOffer: offer,
      inputHash: createHash('sha256').update(JSON.stringify({ service, input: JSON.parse(body) })).digest('hex'),
      outputSchema: contract.output_schema, phase: 'prepared', status: 'awaiting_payment', createdAt: new Date().toISOString() };
    await editLedger(state => { state.jobs[id] = job; });
    return publicJob(await requestQuote(job));
  });
}

/** @param {any} job @param {Response} response @param {any} body */
async function accept(job, response, body) {
  if (body?.job_id !== job.id || body.service_id !== job.service || body.service_version !== job.serviceVersion ||
      body.status_url !== jobUrl(job.id) || typeof body.status !== 'string') throw new Error('MPP job identity mismatch');
  let payment = body.payment;
  if (payment) {
    const sdk = await loadTempoSdk();
    if (payment.success !== true || payment.protocol !== 'mpp' || payment.network !== 'eip155:42431' ||
        payment.token !== job.tokenAsset || payment.decimals !== 6 || payment.amount !== job.offer.amount ||
        payment.transaction !== job.transaction || payment.payer.toLowerCase() !== job.payer.toLowerCase() ||
        payment.mpp?.reference !== job.transaction || payment.mpp?.status !== 'success' || payment.mpp?.method !== 'tempo' ||
        !isDeepStrictEqual(sdk.Receipt.deserialize(response.headers.get('Payment-Receipt') ?? ''), payment.mpp)) throw new Error('MPP receipt mismatch');
    if (!Number.isFinite(Date.parse(payment.mpp.timestamp))) throw new Error('MPP receipt timestamp mismatch');
    payment = { success: true, protocol: 'mpp', network: 'eip155:42431',
      token: job.tokenAsset, decimals: 6, amount: job.offer.amount, payer: job.payer,
      transaction: job.transaction, mpp: { method: 'tempo', status: 'success',
        reference: job.transaction, timestamp: payment.mpp.timestamp } };
  }
  if (body.status === 'succeeded') {
    if (!payment || !body.output) throw new Error('Paid service result is incomplete');
    const { validateInput } = await loadServicesSdk();
    validateInput(job.outputSchema, body);
  }
  return updateJob(job.id, { payment, status: body.status, uxStage: null, output: body.output ?? null,
    error: body.error?.code ? { code: String(body.error.code).slice(0, 100) } : null,
    phase: body.status.endsWith('-uncertain') || (body.status === 'awaiting_payment' && job.dispatchedAt) ? 'uncertain' : body.status === 'succeeded' ? 'complete' : body.status === 'failed' ? 'failed' : payment ? 'settled' : job.phase });
}

/** @param {string} id @param {import('./tempo-signer.mjs').SignOptions & {approve?: boolean}} [options] */
export async function runTempo(id, options = {}) {
  return withLock(`job-${id}`, async () => {
    let job = await readJob(id);
    if (job.protocol !== 'mpp') throw new Error('Saved job is not MPP');
    const status = await apiFetch(jobUrl(id), { headers: { Authorization: `Bearer ${job.token}` } });
    if (!status.response.ok) throw apiError(status.response, status.body);
    if (status.body.status !== 'awaiting_payment') {
      job = await accept(job, status.response, status.body);
      if (job.status === 'paid') {
        const result = await post(job, undefined, Boolean(options.onWalletSession));
        job = await accept(job, result.response, result.body);
      }
      return publicJob(job);
    }
    if (job.dispatchedAt && !job.credential) throw new Error('Payment uncertain; reconcile the saved Tempo transaction');
    if (!job.dispatchedAt) {
      if (!options.approve) throw new Error('Review the saved quote and run with --approve; Touch ID approves the exact purchase');
      job = await requestQuote(job);
      await reserveBudget(id, String(BigInt(job.offer.amount) * 10n));
      await updateJob(id, { fundingIssue: null });
      try {
        await signAndPayTempo(job, { ...options, onStage: async uxStage => { await updateJob(id, { uxStage }); } }, async record => {
          job = await saveTempoDispatch(id, record);
        });
      } catch (error) {
        if (job.dispatchedAt) {
          await updateJob(id, { phase: 'uncertain', status: 'payment-uncertain' });
          throw new Error(`Job ${id}: Tempo submission uncertain. Recover this ID; its budget remains reserved.`);
        }
        await editLedger(state => {
          delete state.budgets[job.budget].reservations[id]; state.jobs[id].uxStage = null;
          delete state.jobs[id].permissionId;
          state.jobs[id].fundingIssue = error instanceof TempoFundingError ? error.code : null;
        });
        if (error instanceof TempoFundingError) throw error;
        throw new Error(`Job ${id}: native purchase approval cancelled or unavailable; no payment dispatched.`);
      }
    }
    // Sending a saved hash credential cannot pay again. Backend claims it once.
    try {
      const result = await post(job, job.credential, Boolean(options.onWalletSession));
      if (!result.body?.status) throw apiError(result.response, result.body);
      return publicJob(await accept(job, result.response, result.body));
    } catch {
      await updateJob(id, { phase: 'uncertain' });
      throw new Error(`Job ${id}: payment unconfirmed; recover this ID with run/status. Do not create another purchase.`);
    }
  });
}

/** @param {string} id @param {{wait?: boolean, timeout?: number, onUpdate?: (job: any) => void}} [options] */
export async function statusTempo(id, { wait = false, timeout = 180, onUpdate } = {}) {
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600) throw new Error('Invalid status timeout');
  return withLock(`job-${id}`, async () => {
    let job = await readJob(id);
    const deadline = Date.now() + timeout * 1000;
    do {
      const result = await apiFetch(jobUrl(id), { headers: { Authorization: `Bearer ${job.token}` } });
      if (!result.response.ok) throw apiError(result.response, result.body);
      job = await accept(job, result.response, result.body);
      try { onUpdate?.(publicJob(job)); } catch { /* Read-only UI is best effort. */ }
      if (!wait || !['settling', 'submitting', 'queued', 'running', 'saving', 'result-ready'].includes(job.status) || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(3000, deadline - Date.now())));
    } while (Date.now() < deadline);
    return publicJob(job);
  });
}
