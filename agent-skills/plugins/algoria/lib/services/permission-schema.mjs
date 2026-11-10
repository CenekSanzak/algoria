// Shared by the plugin and the trusted native bundle. Fixed field ordering binds
// the biometric approval to exact limits, not caller-authored display strings.
export const PERMISSION_RESOURCE = 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate';
const fields = ['version', 'id', 'budget', 'agent', 'service', 'resource', 'network', 'token', 'recipient', 'totalAtomic', 'perCallAtomic', 'validAfter', 'validUntil', 'previousId'];
/** @param {any} p */
export function canonicalPermission(p) {
  if (!p || Object.keys(p).length !== fields.length || Object.keys(p).some(k => !fields.includes(k))) throw new Error('Invalid permission fields');
  if (p.version !== 1 || !/^[0-9a-f-]{36}$/.test(p.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(p.budget) ||
      !['claude', 'codex'].includes(p.agent) || p.service !== 'image.generate' || p.resource !== PERMISSION_RESOURCE ||
      p.network !== 'eip155:42431' || p.token !== '0x20c0000000000000000000000000000000000000' ||
      !/^0x[0-9a-f]{40}$/.test(p.recipient) || /^0x0{40}$/.test(p.recipient) ||
      ![p.totalAtomic, p.perCallAtomic].every(v => typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && BigInt(v) % 10n === 0n) ||
      BigInt(p.totalAtomic) > 1_000_000_000n || BigInt(p.perCallAtomic) > BigInt(p.totalAtomic) ||
      !Number.isSafeInteger(p.validAfter) || !Number.isSafeInteger(p.validUntil) || p.validAfter < 0 ||
      p.validUntil <= p.validAfter || p.validUntil - p.validAfter > 30 * 86400 ||
      !(p.previousId === null || typeof p.previousId === 'string' && /^[0-9a-f-]{36}$/.test(p.previousId))) throw new Error('Invalid permission scope or limits');
  return JSON.stringify(Object.fromEntries(fields.map(k => [k, p[k]])));
}
/** @param {any} p @param {number} [now] */
export function activePermission(p, now = Math.floor(Date.now() / 1000)) {
  canonicalPermission(p);
  if (now < p.validAfter || now >= p.validUntil) throw new Error('Spending permission is not active or has expired');
}
/** @param {any} p @param {any} job @param {string} amount */
export function permissionCovers(p, job, amount) {
  activePermission(p);
  if (job.budget !== p.budget || job.service !== p.service || job.resource !== p.resource || job.chain !== p.network ||
      job.tokenAsset !== p.token || job.offer?.payTo?.toLowerCase() !== p.recipient ||
      BigInt(amount) > BigInt(p.perCallAtomic)) throw new Error('Purchase is outside the approved spending permission');
}
