import { isDeepStrictEqual } from 'node:util';
import { NETWORKS } from '../stellar/network.mjs';
import { decodePublicKey } from '../stellar/strkey.mjs';
import { loadServicesSdk } from './sdk.mjs';

/** @param {string} value */
export function atomicAmount(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(value)) throw new Error('USDC amount must be a positive decimal with at most 7 decimal places');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
  if (result <= 0n || result >= 1n << 127n) throw new Error('USDC amount is out of range');
  return result.toString();
}

/** @param {string} value */
export function displayAmount(value) {
  const n = BigInt(value);
  return `${n / 10_000_000n}.${String(n % 10_000_000n).padStart(7, '0')}`;
}

/** @param {any} offer */
export function validateOffer(offer) {
  if (offer?.scheme !== 'exact' || offer.network !== NETWORKS.testnet.caip2 ||
      offer.asset !== NETWORKS.testnet.usdcSac || offer.extra?.areFeesSponsored !== true ||
      typeof offer.amount !== 'string' || !/^[1-9]\d*$/.test(offer.amount) ||
      BigInt(offer.amount) >= 1n << 127n || !Number.isInteger(offer.maxTimeoutSeconds) ||
      offer.maxTimeoutSeconds < 1 || offer.maxTimeoutSeconds > 120) {
    throw new Error('unsupported x402 offer: expected sponsored exact testnet USDC');
  }
  decodePublicKey(offer.payTo);
}

/** Header and body are distinct: Algoria adds job_id/expiry only to the body.
 * @param {any} job @param {Response} response @param {any} body
 */
export async function validateChallenge(job, response, body) {
  const encoded = response.headers.get('PAYMENT-REQUIRED');
  if (response.status !== 402 || !encoded || encoded.length > 100_000) throw new Error('response is not an x402 payment offer');
  const { decodePaymentRequiredHeader } = await loadServicesSdk();
  const challenge = decodePaymentRequiredHeader(encoded);
  for (const key of ['x402Version', 'resource', 'accepts', 'extensions']) {
    if (!isDeepStrictEqual(challenge[key], body[key])) throw new Error('payment header/body mismatch');
  }
  if (body.job_id !== job.id || challenge.x402Version !== 2 || challenge.resource?.url !== job.resource ||
      !Array.isArray(challenge.accepts) || challenge.accepts.length !== 1 ||
      !Number.isFinite(Date.parse(body.expires_at)) || Date.parse(body.expires_at) <= Date.now()) {
    throw new Error('invalid or expired payment offer for this job');
  }
  const offer = challenge.accepts[0];
  validateOffer(offer);
  // Preserve the full actual offer, but do not allow price/recipient drift from metadata.
  for (const key of ['scheme', 'network', 'asset', 'payTo', 'amount']) {
    if (offer[key] !== job.expectedOffer[key]) throw new Error(`payment offer changed ${key}; quote a new job only after reviewing the change`);
  }
  if (job.offer && !isDeepStrictEqual(job.offer, offer)) throw new Error('saved payment offer changed');
  return { challenge, offer, expiresAt: body.expires_at };
}
