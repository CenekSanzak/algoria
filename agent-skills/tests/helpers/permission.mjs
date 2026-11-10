import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalPermission } from '../../plugins/algoria/lib/services/permission-schema.mjs';
// Software fixture ONLY in the test harness, never shipped or used by live code.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
if (!jwk.x || !jwk.y) throw new Error('Invalid fixture key');
/** @param {any} policy */
export function signedPermission(policy) {
  const canonical = canonicalPermission(policy);
  return { policy, digest: '0x' + createHash('sha256').update(canonical).digest('hex'),
    publicKey: '0x04' + Buffer.from(String(jwk.x), 'base64url').toString('hex') + Buffer.from(String(jwk.y), 'base64url').toString('hex'),
    signature: '0x' + sign('sha256', Buffer.from(canonical), privateKey).toString('hex') };
}
