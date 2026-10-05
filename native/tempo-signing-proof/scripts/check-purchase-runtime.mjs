import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Challenge } from 'mppx';

const input = { prompt: 'Offline native image purchase fixture — İstanbul 🚀' };
const now = Math.floor(Date.now() / 1000);
const challenge = Challenge.from({ secretKey: 'offline-sdk-check'.repeat(3),
  method: 'tempo', intent: 'charge', realm: 'vqqbvydiehuwdzbgvmun.supabase.co',
  expires: new Date((now + 600) * 1000).toISOString(),
  meta: { resource: 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate',
    job_id: randomUUID(), input_hash: createHash('sha256').update(JSON.stringify({ service: 'image.generate', input })).digest('hex') },
  request: { amount: '10000', currency: '0x20c0000000000000000000000000000000000000',
    recipient: '0x1111111111111111111111111111111111111111',
    methodDetails: { chainId: 42431, supportedModes: ['push'] } } });
const executable = fileURLToPath(new URL('../.build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof', import.meta.url));
const request = { version: 2, chainId: 42431, nonce: '0', maxFeePerGas: '20000000000', validBefore: now + 180, challenge, input };
const output = JSON.parse(execFileSync(executable, ['--self-test-request'], {
  input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 15000 }));
assert.equal(output.status, 'self-test-passed');
assert.equal(output.softwareTestKey, true);
assert.equal(output.provesTouchID, false);
console.log('Native JavaScriptCore MPP purchase construction and signature verification passed (offline software test key).');
