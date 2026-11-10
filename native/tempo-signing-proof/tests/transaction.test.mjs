import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P256 from 'ox/P256';
import * as PublicKey from 'ox/PublicKey';
import * as Signature from 'ox/Signature';
import { TxEnvelopeTempo, SignatureEnvelope } from 'ox/tempo';
import { Transaction } from 'viem/tempo';
import { keccak256 } from 'viem';
import { prepare, complete, TOKEN, MAX_FEE_PER_GAS } from '../src/transaction.mjs';

// Public test vector only; never used for network calls or user state.
const privateKey = `0x${'1'.padStart(64, '0')}`;
const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
const now = 1_800_000_000;
const request = { version: 1, chainId: 42431, nonce: '0', maxFeePerGas: '20000000000', validBefore: now + 120 };
const sign = (digest) => Signature.toDerHex(P256.sign({ privateKey, payload: digest }));

test('SDK transaction is testnet-only, fixed token, one micro-unit to its own address', async () => {
  const value = prepare(request, publicKey, now);
  assert.equal(value.transaction.chainId, 42431);
  assert.equal(value.transaction.calls.length, 1);
  assert.equal(value.transaction.calls[0].to, TOKEN);
  assert.equal(value.transaction.calls[0].data.slice(0, 10), '0xa9059cbb');
  assert.equal(BigInt(`0x${value.transaction.calls[0].data.slice(-64)}`), 1n);
  assert.equal(value.transaction.calls[0].data.slice(34, 74).toLowerCase(), value.summary.address.slice(2).toLowerCase());
  assert.equal(value.digest, keccak256(await Transaction.serialize(value.transaction)));
});
test('DER signature round trips through Tempo and verifies', () => {
  const { digest } = prepare(request, publicKey, now);
  const result = complete(request, publicKey, sign(digest), now);
  const tx = TxEnvelopeTempo.deserialize(result.serializedTransaction);
  assert.equal(tx.signature.type, 'p256');
  assert.equal(tx.signature.prehash, false);
  assert.ok(SignatureEnvelope.verify(tx.signature, { payload: digest, address: result.address }));
});
test('normalizes Apple high-S signatures', () => {
  const { digest } = prepare(request, publicKey, now);
  const sig = Signature.from(P256.sign({ privateKey, payload: digest }));
  const n = P256.noble.Point.Fn.ORDER;
  const s = BigInt(sig.s);
  const der = Signature.toDerHex({ r: BigInt(sig.r), s: s <= n / 2n ? n - s : s });
  const tx = TxEnvelopeTempo.deserialize(complete(request, publicKey, der, now).serializedTransaction);
  assert.ok(tx.signature.signature.s <= n / 2n);
});
for (const [label, patch] of Object.entries({
  mainnet: { chainId: 4217 }, destination: { to: '0x0000000000000000000000000000000000000001' },
  arbitraryDigest: { digest: '0x00' }, callerLabel: { title: 'free gift' }, calldata: { data: '0x' },
  fee: { maxFeePerGas: (MAX_FEE_PER_GAS + 1n).toString() }, zeroFee: { maxFeePerGas: '0' },
  expired: { validBefore: now }, longExpiry: { validBefore: now + 301 },
  badNonce: { nonce: '-1' }, numericNonce: { nonce: 1 }, leadingZero: { nonce: '01' },
  overflowNonce: { nonce: (2n ** 64n).toString() },
})) test(`rejects ${label}`, () => assert.throws(() => prepare({ ...request, ...patch }, publicKey, now)));
test('rejects signature after request substitution or expiry', () => {
  const der = sign(prepare(request, publicKey, now).digest);
  assert.throws(() => complete({ ...request, nonce: '1' }, publicKey, der, now));
  assert.throws(() => complete({ ...request, maxFeePerGas: '1' }, publicKey, der, now));
  assert.throws(() => complete(request, publicKey, der, now + 121));
});
test('rejects double hashing, invalid DER and a different key', () => {
  const { digest } = prepare(request, publicKey, now);
  const doubleHashed = Signature.toDerHex(P256.sign({ privateKey, payload: digest, hash: true }));
  assert.throws(() => complete(request, publicKey, doubleHashed, now));
  assert.throws(() => complete(request, publicKey, '0x00', now));
  const other = PublicKey.toHex(P256.getPublicKey({ privateKey: `0x${'2'.padStart(64, '0')}` }));
  assert.throws(() => complete(request, other, sign(digest), now));
});
