import { spawn } from 'node:child_process';
import { createPublicKey, verify, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withLock } from '../lock.mjs';
import { tempoReadiness } from './tempo-readiness.mjs';
import { canonicalPermission, activePermission } from './permission-schema.mjs';

/** An approval receipt is evidence from the configured local companion, NOT a
 * hardware attestation or protection against a malicious same-user host.
 * @param {any} receipt @param {any} [expected] */
export function verifyPermissionReceipt(receipt, expected) {
  const canonical = canonicalPermission(receipt?.policy);
  if (expected && !isDeepStrictEqual(receipt.policy, expected)) throw new Error('Biometric permission changed');
  if (!/^0x04[0-9a-f]{128}$/i.test(receipt.publicKey ?? '') || !/^0x[0-9a-f]{128,160}$/i.test(receipt.signature ?? '') ||
      receipt.digest !== '0x' + createHash('sha256').update(canonical).digest('hex')) throw new Error('Invalid biometric permission receipt');
  const key = Buffer.from(receipt.publicKey.slice(4), 'hex');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.subarray(0, 32).toString('base64url'), y: key.subarray(32).toString('base64url') }, format: 'jwk' });
  if (!verify('sha256', Buffer.from(canonical), publicKey, Buffer.from(receipt.signature.slice(2), 'hex'))) throw new Error('Invalid biometric permission signature');
  return receipt.policy;
}

/** No faucet/RPC/payment. Native UI builds its own summary and requires Secure
 * Enclave key use with biometryCurrentSet. No live software fallback.
 * @param {any} policy */
export async function approvePermission(policy) {
  activePermission(policy);
  return withLock('tempo-wallet-approval', async () => {
    activePermission(policy);
    const readiness = tempoReadiness();
    if (!readiness.ready) throw new Error(readiness.nextAction);
    const app = process.env.ALGORIA_TEMPO_SIGNER_APP;
    return new Promise((resolve, reject) => {
      const child = spawn(`${app}/Contents/MacOS/AlgoriaSigningProof`, ['--approve-permission'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => child.kill(), 300000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) child.kill(); });
      child.stdin.on('error', () => child.kill());
      child.on('error', () => { clearTimeout(timer); reject(new Error('Permission companion unavailable')); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          if (code !== 0 || output.length > 32768) throw new Error('denied');
          const message = JSON.parse(output);
          if (message.status !== 'permission-approved') throw new Error('denied');
          verifyPermissionReceipt(message.receipt, policy);
          activePermission(policy);
          resolve(message.receipt);
        } catch { reject(new Error('Biometric budget approval cancelled, expired or unavailable; budget unchanged')); }
      });
      child.stdin.end(JSON.stringify(policy) + '\n');
    });
  }, { waitMs: 300000 });
}
