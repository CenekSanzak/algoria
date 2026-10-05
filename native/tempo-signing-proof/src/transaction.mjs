import * as Address from 'ox/Address';
import * as AbiFunction from 'ox/AbiFunction';
import * as PublicKey from 'ox/PublicKey';
import * as Signature from 'ox/Signature';
import * as P256 from 'ox/P256';
import * as Hex from 'ox/Hex';
import { SignatureEnvelope, TxEnvelopeTempo } from 'ox/tempo';

export const CHAIN_ID = 42431;
export const TOKEN = '0x20c0000000000000000000000000000000000000';
export const GAS = 1_000_000n;
export const MAX_FEE_PER_GAS = 30_000_000_000n;
const transfer = AbiFunction.from('function transfer(address to, uint256 amount) returns (bool)');
const fields = ['version', 'chainId', 'nonce', 'maxFeePerGas', 'validBefore'];

export function addressFor(publicKey) {
  return Address.fromPublicKey(PublicKey.fromHex(publicKey));
}

// This exact module is bundled into the native application. Caller-supplied
// calldata, digests, destinations, amounts, labels and signer code are forbidden.
export function prepare(request, publicKey, now = Math.floor(Date.now() / 1000)) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Object.keys(request).length !== fields.length ||
      Object.keys(request).some((key) => !fields.includes(key))) throw new Error('Unexpected request fields.');
  if (request.version !== 1 || request.chainId !== CHAIN_ID) throw new Error('Only Moderato testnet is permitted.');
  const integer = (value, name, max) => {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error(`Invalid ${name}.`);
    const result = BigInt(value);
    if (result > max) throw new Error(`${name} exceeds proof limit.`);
    return result;
  };
  const nonce = integer(request.nonce, 'nonce', 2n ** 64n - 1n);
  const maxFeePerGas = integer(request.maxFeePerGas, 'fee', MAX_FEE_PER_GAS);
  if (maxFeePerGas === 0n) throw new Error('Fee must be positive.');
  if (!Number.isSafeInteger(request.validBefore) || request.validBefore <= now ||
      request.validBefore > now + 300) throw new Error('Request expired or expiry exceeds five minutes.');
  const address = addressFor(publicKey);
  const transaction = TxEnvelopeTempo.from({
    chainId: CHAIN_ID, nonce, nonceKey: 0n, gas: GAS,
    maxFeePerGas, maxPriorityFeePerGas: 0n, feeToken: TOKEN,
    validBefore: request.validBefore,
    calls: [{ to: TOKEN, value: 0n, data: AbiFunction.encodeData(transfer, [address, 1n]) }],
  });
  return {
    transaction, digest: TxEnvelopeTempo.getSignPayload(transaction),
    summary: {
      title: 'Algoria signing proof — TESTNET ONLY',
      network: 'Tempo Moderato (42431)',
      action: 'Transfer 0.000001 test PathUSD back to this same disposable account',
      address, token: TOKEN, gasLimit: GAS.toString(), maxFeePerGas: maxFeePerGas.toString(),
      maximumGasFeeUnits: (GAS * maxFeePerGas).toString(),
      expires: new Date(request.validBefore * 1000).toISOString(),
    },
  };
}

export function complete(request, publicKey, der, now) {
  const prepared = prepare(request, publicKey, now);
  const parsed = Signature.fromDerHex(der);
  // Apple can return either S form. Normalize with the SDK curve order.
  const n = P256.noble.Point.Fn.ORDER;
  const s = BigInt(parsed.s);
  const signature = { r: parsed.r, s: Hex.fromNumber(s > n / 2n ? n - s : s, { size: 32 }) };
  const envelope = SignatureEnvelope.from({
    type: 'p256', publicKey: PublicKey.fromHex(publicKey), signature, prehash: false,
  });
  if (!SignatureEnvelope.verify(envelope, { payload: prepared.digest, address: prepared.summary.address })) {
    throw new Error('Signature does not match the approved transaction.');
  }
  return {
    ...prepared.summary, digest: prepared.digest,
    serializedTransaction: TxEnvelopeTempo.serialize({ ...prepared.transaction, signature: envelope }),
  };
}

// JSON-only boundary for JavaScriptCore. Never evaluate request text as code.
export function prepareJSON(requestJSON, publicKey, now) {
  const { digest, summary } = prepare(JSON.parse(requestJSON), publicKey, now);
  return JSON.stringify({ digest, summary });
}
export function completeJSON(requestJSON, publicKey, der, now) {
  return JSON.stringify(complete(JSON.parse(requestJSON), publicKey, der, now));
}
