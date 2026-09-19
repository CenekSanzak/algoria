import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withLock } from '../lock.mjs';
import { unlockWallet } from '../stellar/keystore.mjs';
import { jobUrl } from './api.mjs';
import { externalRequest, externalUrl } from './external-http.mjs';
import { getStellar8004Service } from './stellar8004.mjs';
import { loadServicesSdk } from './sdk.mjs';
import { validateOffer } from './policy.mjs';
import { editLedger, getBudget, publicJob, readJob, readLedger, reserveBudget, updateJob } from './state.mjs';

/** Exact request saved before probing. GET uses scalar query values; POST JSON.
 * @param {any} service @param {any} input @param {string} [method]
 */
export function externalInvocation(service, input, method) {
  const selected = method ?? service.method;
  if (!['GET', 'POST'].includes(selected)) throw new Error('external service needs --method GET or POST from its API documentation');
  if (service.method && selected !== service.method) throw new Error('method differs from registered service metadata');
  const endpoint = externalUrl(service.resource);
  const json = JSON.stringify(input);
  if (json === undefined || Buffer.byteLength(json) > 32768) throw new Error('service input must be JSON of at most 32768 bytes');
  if (selected === 'GET') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('GET input must be an object of scalar query values');
    for (const [key, value] of Object.entries(input)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || endpoint.searchParams.has(key)) throw new Error('GET input must use scalar values without overwriting registered query parameters');
      endpoint.searchParams.append(key, String(value));
    }
  }
  const resource = externalUrl(endpoint.href).href;
  return { method: selected, resource, body: selected === 'POST' ? json : undefined, inputJson: json };
}

/** Reverse proxies sometimes advertise http in resource.url. Permit only an
 * exact http->https normalization; requests and signatures always go via TLS.
 * @param {string} advertised @param {string} requested
 */
function sameResource(advertised, requested) {
  try {
    const url = new URL(advertised);
    if (url.protocol === 'http:' && !url.port) url.protocol = 'https:';
    return externalUrl(url.href).href === requested;
  } catch { return false; }
}

/** External providers need not mirror the challenge in the response body.
 * @param {any} job @param {Response} response
 */
export async function externalChallenge(job, response) {
  const encoded = response.headers.get('payment-required');
  if (response.status !== 402 || !encoded || encoded.length > 100_000) throw new Error('external service did not return a valid x402 challenge');
  const sdk = await loadServicesSdk();
  const challenge = sdk.decodePaymentRequiredHeader(encoded);
  if (challenge.x402Version !== 2 || !sameResource(challenge.resource?.url, job.resource) || !Array.isArray(challenge.accepts) || challenge.accepts.length > 20) throw new Error('external x402 resource mismatch');
  const eligible = challenge.accepts.filter((/** @type {any} */ offer) => {
    try { validateOffer(offer); return true; } catch { return false; }
  });
  if (eligible.length !== 1) throw new Error('expected exactly one sponsored testnet USDC offer');
  const offer = eligible[0];
  if (job.offer && !isDeepStrictEqual(job.offer, offer)) throw new Error('external price or payment terms changed; review a new quote before paying');
  return { challenge: { ...challenge, accepts: [offer] }, offer };
}

/** @param {any} job @param {string} [signature] */
function invoke(job, signature) {
  return externalRequest(job.resource, { method: job.method, body: job.body, signature, timeoutMs: signature ? 90_000 : 30_000 });
}

/** @param {string} service @param {unknown} input @param {string} budget @param {string} [id] @param {string} [method] */
export async function quoteExternal(service, input, budget, id = randomUUID(), method) {
  jobUrl(id);
  return withLock(`job-${id}`, async () => {
    await getBudget(budget);
    const saved = (await readLedger()).jobs[id];
    if (saved) {
      if (saved.source !== 'stellar8004' || saved.service !== service || saved.budget !== budget || saved.inputJson !== JSON.stringify(input) || (method && method !== saved.method)) throw new Error('job identity already has different input, service or budget');
      return publicJob(saved); // No probe/retry of an existing external call.
    }
    const contract = await getStellar8004Service(service);
    if (!contract.supported) throw new Error('registered service is not a supported public x402 HTTP endpoint');
    if (contract.input_schema) (await loadServicesSdk()).validateInput(contract.input_schema, input);
    const invocation = externalInvocation(contract, input, method);
    const job = { id, source: 'stellar8004', service, serviceVersion: contract.version, budget, ...invocation,
      registry: contract.registry, metadataFingerprint: contract.metadataFingerprint,
      registeredEndpoint: contract.resource, phase: 'prepared', status: 'awaiting_quote', createdAt: new Date().toISOString() };
    await editLedger((state) => { state.jobs[id] = job; });
    try {
      const { response } = await invoke(job);
      const validated = await externalChallenge(job, response);
      return publicJob(await updateJob(id, { ...validated, phase: 'quoted', status: 'awaiting_payment', expiresAt: new Date(Date.now() + 300_000).toISOString() }));
    } catch {
      await updateJob(id, { phase: 'failed', status: 'quote-failed' });
      throw new Error(`External job ${id}: quote failed; no payment authorization sent. Check service/method/network before creating another quote.`);
    }
  });
}

/** External services have no Algoria recovery contract. Send the paid request
 * at most once, then expose only the saved reply; never invent a status URL.
 * @param {string} id @param {{approve?: boolean}} [options]
 */
export async function runExternal(id, { approve = false } = {}) {
  jobUrl(id);
  return withLock(`job-${id}`, async () => {
    let job = await readJob(id);
    if (job.source !== 'stellar8004') throw new Error('not an external job');
    if (job.dispatchedAt || job.status !== 'awaiting_payment') return publicJob(job);
    if (!approve) throw new Error('payment needs --approve within the user-approved named budget; review the saved external quote first');
    if (Date.parse(job.expiresAt) <= Date.now()) throw new Error('external quote expired; review a new quote before paying');
    const current = await getStellar8004Service(job.service);
    if (!current.supported || current.metadataFingerprint !== job.metadataFingerprint || current.resource !== job.registeredEndpoint) throw new Error('registered service changed since quote; review a new quote');
    // Only re-probe before a signature exists. The saved signature is never
    // refreshed or re-signed after a crash, and dispatch intent precedes I/O.
    if (!job.signature) {
      const { response } = await invoke(job);
      const validated = await externalChallenge(job, response);
      job = await updateJob(id, validated);
    }
    const { keypair } = await unlockWallet('testnet', null);
    if (job.payer && job.payer !== keypair.publicKey) throw new Error('wallet changed since authorization');
    await reserveBudget(id, job.offer.amount);
    job = await updateJob(id, { payer: keypair.publicKey });
    if (!job.signature) {
      let signature;
      try { signature = await (await loadServicesSdk()).signChallenge(job.challenge, keypair.secretSeed); }
      catch { throw new Error(`External job ${id}: local signing failed; no payment authorization sent`); }
      if (typeof signature !== 'string' || !signature || signature.length > 32768) throw new Error('invalid payment authorization size');
      job = await updateJob(id, { signature, phase: 'signed' });
    }
    job = await updateJob(id, { phase: 'uncertain', status: 'payment-uncertain', dispatchedAt: new Date().toISOString() });
    try {
      const { response, body } = await invoke(job, job.signature);
      // Keep received data even if its receipt is missing or invalid. It may be
      // useful for reconciliation, but it is not proof that payment succeeded.
      const output = JSON.parse(JSON.stringify(body).split(job.signature).join('[redacted payment authorization]'));
      await updateJob(id, { output, httpStatus: response.status });
      const encoded = response.headers.get('payment-response');
      if (!encoded || encoded.length > 100_000) throw new Error('missing receipt');
      const receipt = (await loadServicesSdk()).decodePaymentResponseHeader(encoded);
      if (receipt.success !== true || receipt.network !== 'stellar:testnet' || !/^[a-f0-9]{64}$/i.test(receipt.transaction) ||
          (receipt.payer && receipt.payer !== job.payer) || (receipt.amount !== undefined && receipt.amount !== job.offer.amount)) throw new Error('receipt mismatch');
      const payment = { success: true, network: receipt.network, transaction: receipt.transaction, payer: job.payer, amount: job.offer.amount };
      const complete = response.ok && response.status !== 202;
      return publicJob(await updateJob(id, { payment, output, httpStatus: response.status,
        status: complete ? 'succeeded' : response.status === 202 ? 'submission-uncertain' : 'failed',
        phase: complete ? 'complete' : response.status === 202 ? 'uncertain' : 'failed' }));
    } catch {
      throw new Error(`External job ${id}: payment/result is uncertain. Do not retry or pay again; status shows the local record and the budget remains reserved.`);
    }
  });
}
