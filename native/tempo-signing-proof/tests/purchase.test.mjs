import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P256 from 'ox/P256';
import * as PublicKey from 'ox/PublicKey';
import * as Signature from 'ox/Signature';
import * as AbiFunction from 'ox/AbiFunction';
import { Bytes, Hash } from 'ox';
import { TxEnvelopeTempo, SignatureEnvelope } from 'ox/tempo';
import { Challenge } from 'mppx';
import * as Attribution from '../node_modules/mppx/dist/tempo/Attribution.js';
import { preparePurchase, completePurchaseJSON } from '../src/purchase.mjs';

const privateKey = `0x${'1'.padStart(64, '0')}`;
const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }));
const now = Math.floor(Date.now() / 1000);
const input = { prompt: 'An orange cat' };
const challenge = Challenge.from({ secretKey: 'offline-test-secret'.repeat(3),
  method: 'tempo', intent: 'charge', realm: 'vqqbvydiehuwdzbgvmun.supabase.co',
  expires: new Date((now + 600) * 1000).toISOString(),
  meta: { resource: 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate',
    job_id: 'b773b640-c904-4b2c-879e-50b1c394c57d',
    input_hash: Hash.sha256(Bytes.fromString(JSON.stringify({ service: 'image.generate', input })), { as: 'Hex' }).slice(2) },
  request: { amount: '10000', currency: '0x20c0000000000000000000000000000000000000',
    recipient: '0x1111111111111111111111111111111111111111',
    methodDetails: { chainId: 42431, supportedModes: ['push'] } } });
const request = { version: 2, chainId: 42431, nonce: '0', maxFeePerGas: '20000000000', validBefore: now + 180, challenge, input };

test('native MPP purchase signs exactly one challenge-bound transfer and exposes an honest review', () => {
  const value = preparePurchase(request, publicKey, now);
  const transfer = AbiFunction.from('function transferWithMemo(address to, uint256 amount, bytes32 memo) returns (bool)');
  const [to, amount, memo] = AbiFunction.decodeData(transfer, value.transaction.calls[0].data);
  assert.equal(to.toLowerCase(), challenge.request.recipient);
  assert.equal(amount, 10000n);
  assert.ok(Attribution.verifyServer(memo, challenge.realm));
  assert.ok(Attribution.verifyChallengeBinding(memo, challenge.id));
  assert.equal(value.summary.prompt, input.prompt);
  assert.equal(value.summary.recipient, to);
  const der = Signature.toDerHex(P256.sign({ privateKey, payload: value.digest }));
  const output = JSON.parse(completePurchaseJSON(JSON.stringify(request), publicKey, der, now));
  const tx = TxEnvelopeTempo.deserialize(output.serializedTransaction);
  assert.ok(SignatureEnvelope.verify(tx.signature, { payload: value.digest, address: output.address }));
});

for (const [name, mutate] of Object.entries({
  input: r => { r.input.prompt = 'Substituted prompt'; },
  mainnet: r => { r.challenge.request.methodDetails.chainId = 4217; },
  token: r => { r.challenge.request.currency = '0x1111111111111111111111111111111111111111'; },
  splits: r => { r.challenge.request.methodDetails.splits = [{ amount: '1' }]; },
  pull: r => { r.challenge.request.methodDetails.supportedModes = ['pull']; },
  service: r => { r.challenge.meta.resource = 'https://evil.test'; },
  fee: r => { r.maxFeePerGas = '9999999999999999999'; },
  expiry: r => { r.validBefore = now; },
  arbitrarySigning: r => { r.digest = '0x00'; },
})) test(`native rejects purchase ${name} substitution`, () => {
  const copy = structuredClone(request); mutate(copy);
  assert.throws(() => preparePurchase(copy, publicKey, now));
});

test('cannot reuse an approved signature after changing the recipient', () => {
  const value = preparePurchase(request, publicKey, now);
  const der = Signature.toDerHex(P256.sign({ privateKey, payload: value.digest }));
  const copy = structuredClone(request);
  copy.challenge.request.recipient = '0x2222222222222222222222222222222222222222';
  assert.throws(() => completePurchaseJSON(JSON.stringify(copy), publicKey, der, now));
});
