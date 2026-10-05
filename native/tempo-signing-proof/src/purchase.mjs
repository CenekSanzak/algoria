import { Bytes, Hash } from 'ox';
import { PaymentRequest } from 'mppx';
import * as AbiFunction from 'ox/AbiFunction';
import { TxEnvelopeTempo } from 'ox/tempo';
import * as Attribution from '../node_modules/mppx/dist/tempo/Attribution.js';
import { CHAIN_ID, TOKEN, prepare, completePrepared } from './transaction.mjs';

const resource = 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate';
const transfer = AbiFunction.from('function transferWithMemo(address to, uint256 amount, bytes32 memo) returns (bool)');

/** @param {any} request @param {any} publicKey @param {number} [now] */
export function preparePurchase(request, publicKey, now = Math.floor(Date.now() / 1000)) {
  const fields = ['version', 'chainId', 'nonce', 'maxFeePerGas', 'validBefore', 'challenge', 'input'];
  if (!request || Object.keys(request).length !== fields.length || Object.keys(request).some(k => !fields.includes(k))) throw new Error('Unexpected purchase fields');
  const { challenge: c, input } = request;
  const offer = c?.request;
  const meta = c?.meta;
  const correlation = c?.opaque ? PaymentRequest.deserialize(c.opaque) : null;
  if (!meta || !correlation || Object.keys(meta).length !== 3 || Object.keys(correlation).length !== 3 ||
      ['resource', 'job_id', 'input_hash'].some(k => meta[k] !== correlation[k])) throw new Error('Purchase correlation mismatch');
  if (request.version !== 2 || c?.method !== 'tempo' || c.intent !== 'charge' ||
      c.realm !== 'vqqbvydiehuwdzbgvmun.supabase.co' || meta?.resource !== resource ||
      !/^[0-9a-f-]{36}$/.test(meta?.job_id ?? '') ||
      !input || Object.keys(input).length !== 1 || typeof input.prompt !== 'string' ||
      !input.prompt.trim() || input.prompt.length > 4000 || input.prompt !== input.prompt.trim() ||
      offer?.currency?.toLowerCase() !== TOKEN || offer.methodDetails?.chainId !== CHAIN_ID ||
      Object.keys(offer).some(k => !['amount', 'currency', 'recipient', 'methodDetails'].includes(k)) ||
      Object.keys(offer.methodDetails).some(k => !['chainId', 'supportedModes'].includes(k)) ||
      JSON.stringify(offer.methodDetails.supportedModes) !== '["push"]' ||
      !/^0x[0-9a-fA-F]{40}$/.test(offer.recipient) || /^0x0{40}$/.test(offer.recipient) ||
      !/^[1-9][0-9]{0,6}$/.test(offer.amount) || BigInt(offer.amount) > 1_000_000n ||
      typeof c.id !== 'string' || c.id.length > 256 ||
      !Number.isFinite(Date.parse(c.expires)) || Date.parse(c.expires) / 1000 < request.validBefore ||
      Hash.sha256(Bytes.fromString(JSON.stringify({ service: 'image.generate', input })), { as: 'Hex' }).slice(2) !== meta.input_hash) {
    throw new Error('Invalid or changed image purchase');
  }
  const base = prepare({ version: 1, chainId: request.chainId, nonce: request.nonce,
    maxFeePerGas: request.maxFeePerGas, validBefore: request.validBefore }, publicKey, now);
  const memo = Attribution.encode({ challengeId: c.id, serverId: c.realm });
  const transaction = TxEnvelopeTempo.from({ ...base.transaction,
    calls: [{ to: TOKEN, value: 0n, data: AbiFunction.encodeData(transfer, [offer.recipient, BigInt(offer.amount), memo]) }] });
  return { transaction, digest: TxEnvelopeTempo.getSignPayload(transaction),
    summary: { ...base.summary, title: 'Algoria image purchase — TESTNET',
      action: `Generate one image for ${(Number(offer.amount) / 1e6).toFixed(6)} test PathUSD`,
      recipient: offer.recipient, prompt: input.prompt, jobId: meta.job_id,
      amount: offer.amount, challengeId: c.id } };
}

/** @param {string} json @param {any} publicKey @param {number} now */
export function preparePurchaseJSON(json, publicKey, now) {
  const { digest, summary } = preparePurchase(JSON.parse(json), publicKey, now);
  return JSON.stringify({ digest, summary });
}
/** @param {string} json @param {any} publicKey @param {any} der @param {number} now */
export function completePurchaseJSON(json, publicKey, der, now) {
  return JSON.stringify(completePrepared(preparePurchase(JSON.parse(json), publicKey, now), publicKey, der));
}
