import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempoSecretPlan } from './tempo-config-plan.mjs';

const recipient = '0x1111111111111111111111111111111111111111';
const secret = 'a'.repeat(43);
const plan = tempoSecretPlan(recipient, secret);
const deployed = plan.map(({ name, value }) => ({ name, digest: createHash('sha256').update(value).digest('hex') }));

test('sets only three Tempo settings at the approved testnet price', () => {
  assert.deepEqual(plan.map(x => x.name), ['TEMPO_IMAGE_RECIPIENT', 'TEMPO_IMAGE_PRICE_ATOMIC', 'MPP_SECRET_KEY']);
  assert.equal(plan[1].value, '10000');
  assert.equal(plan.some(x => x.name === 'FAL_KEY'), false);
});
test('matching deployed settings can be safely reapplied', () => {
  assert.deepEqual(tempoSecretPlan(recipient, secret, deployed), plan);
});
test('accepts Management API digests under value, without replacing them', () => {
  assert.deepEqual(tempoSecretPlan(recipient, secret, deployed.map(({ name, digest }) => ({ name, value: digest }))), plan);
});
for (const name of ['TEMPO_IMAGE_RECIPIENT', 'TEMPO_IMAGE_PRICE_ATOMIC', 'MPP_SECRET_KEY']) {
  test(`refuses to overwrite a different deployed ${name}`, () => {
    assert.throws(() => tempoSecretPlan(recipient, secret, [{ name, digest: 'mismatch' }]), /refusing/);
  });
}
test('rejects zero/malformed recipients and short secrets', () => {
  assert.throws(() => tempoSecretPlan('0x' + '0'.repeat(40), secret), /receiver/);
  assert.throws(() => tempoSecretPlan('not-an-address', secret), /receiver/);
  assert.throws(() => tempoSecretPlan(recipient, 'short'), /secret/);
});
