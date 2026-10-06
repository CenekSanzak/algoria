import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { P256, Signature } from 'ox';
import { signedPermission } from '../../../agent-skills/tests/helpers/permission.mjs';
import { PERMISSION_RESOURCE } from '../../../agent-skills/plugins/algoria/lib/services/permission-schema.mjs';
import { verifyPermissionReceipt } from '../../../agent-skills/plugins/algoria/lib/services/permission-approval.mjs';
import { preparePermissionJSON, checkPurchasePermission } from '../src/permissions.mjs';
const now = Math.floor(Date.now() / 1000);
const policy = { version: 1, id: randomUUID(), budget: 'test', agent: 'claude', service: 'image.generate',
  resource: PERMISSION_RESOURCE, network: 'eip155:42431', token: '0x20c0000000000000000000000000000000000000',
  recipient: '0x1111111111111111111111111111111111111111', totalAtomic: '300000', perCallAtomic: '200000',
  validAfter: now - 1, validUntil: now + 600, previousId: null };
const offer = { recipient: policy.recipient, currency: policy.token, amount: '10000' };
test('native permission digest agrees with the Node receipt verifier and trusted UI summary', () => {
  const receipt = signedPermission(policy);
  verifyPermissionReceipt(receipt, policy);
  const prepared = JSON.parse(preparePermissionJSON(JSON.stringify(policy), now));
  assert.equal(prepared.digest, receipt.digest);
  assert.equal(prepared.summary.total, '0.030000');
  assert.equal(prepared.summary.perCall, '0.020000');
  assert.equal(checkPurchasePermission(receipt, offer, now).id, policy.id);
});
test('native permission scope rejects changed limits, destination and expiry', () => {
  const receipt = signedPermission(policy);
  assert.throws(() => checkPurchasePermission({ ...receipt, policy: { ...policy, totalAtomic: '400000' } }, offer, now));
  assert.throws(() => checkPurchasePermission(receipt, { ...offer, amount: '21000' }, now));
  assert.throws(() => checkPurchasePermission(receipt, { ...offer, recipient: '0x' + '2'.repeat(40) }, now));
  assert.throws(() => checkPurchasePermission(receipt, offer, now + 600));
  assert.throws(() => preparePermissionJSON(JSON.stringify({ ...policy, hidden: true }), now));
});
test('native accepts both Apple high-S and low-S permission DER signatures', () => {
  const receipt = signedPermission(policy);
  const parsed = Signature.fromDerHex(receipt.signature);
  const order = P256.noble.Point.Fn.ORDER, s = BigInt(parsed.s);
  for (const value of [s, order - s]) {
    const varied = { ...receipt, signature: Signature.toDerHex({ r: BigInt(parsed.r), s: value }) };
    verifyPermissionReceipt(varied, policy);
    assert.equal(checkPurchasePermission(varied, offer, now).id, policy.id);
  }
});
