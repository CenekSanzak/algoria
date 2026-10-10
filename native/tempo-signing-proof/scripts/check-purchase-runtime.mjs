import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Challenge } from 'mppx';
import { verifyPermissionReceipt } from '../../../agent-skills/plugins/algoria/lib/services/permission-approval.mjs';
import { tempoResource } from '../../../agent-skills/plugins/algoria/lib/services/tempo-services.mjs';

const now = Math.floor(Date.now() / 1000);
const executable = fileURLToPath(
  new URL('../.build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof', import.meta.url),
);
for (
  const [service, input, amount] of [
    ['image.generate', { prompt: 'Offline native image purchase fixture — İstanbul 🚀' }, '10000'],
    ['phone.call', {
      contact: 'berkin',
      goal: 'Confirm the demo — İstanbul 🚀',
      on_behalf_of: 'Dogukan',
      language: 'tr',
    }, '100000'],
  ]
) {
  const challenge = Challenge.from({
    secretKey: 'offline-sdk-check'.repeat(3),
    method: 'tempo',
    intent: 'charge',
    realm: 'vqqbvydiehuwdzbgvmun.supabase.co',
    expires: new Date((now + 600) * 1000).toISOString(),
    meta: {
      resource: tempoResource(service),
      job_id: randomUUID(),
      input_hash: createHash('sha256').update(JSON.stringify({ service, input })).digest('hex'),
    },
    request: {
      amount,
      currency: '0x20c0000000000000000000000000000000000000',
      recipient: '0x1111111111111111111111111111111111111111',
      methodDetails: { chainId: 42431, supportedModes: ['push'] },
    },
  });
  const policy = {
    version: 1,
    id: randomUUID(),
    budget: 'offline',
    agent: 'codex',
    service,
    resource: tempoResource(service),
    network: 'eip155:42431',
    token: challenge.request.currency,
    recipient: challenge.request.recipient,
    totalAtomic: '2000000',
    perCallAtomic: '1000000',
    validAfter: now - 1,
    validUntil: now + 600,
    previousId: null,
  };
  const approval = JSON.parse(execFileSync(executable, ['--self-test-permission'], {
    input: JSON.stringify(policy) + '\n',
    encoding: 'utf8',
    timeout: 15000,
  }));
  assert.equal(approval.status, 'self-test-permission');
  assert.equal(approval.provesTouchID, false);
  verifyPermissionReceipt(approval.receipt, policy);
  const request = {
    version: 2,
    chainId: 42431,
    nonce: '0',
    maxFeePerGas: '20000000000',
    validBefore: now + 180,
    challenge,
    input,
    permission: approval.receipt,
  };
  const output = JSON.parse(execFileSync(executable, ['--self-test-request'], {
    input: JSON.stringify(request) + '\n',
    encoding: 'utf8',
    timeout: 15000,
  }));
  assert.equal(output.status, 'self-test-passed');
  assert.equal(output.softwareTestKey, true);
  assert.equal(output.provesTouchID, false);
  console.log(
    `Native JavaScriptCore ${service} construction and signature verification passed (offline software test key).`,
  );
}
console.log(
  'Native permission approval digest/signature agrees with Node; covered purchase passed. No biometric or network activity.',
);
