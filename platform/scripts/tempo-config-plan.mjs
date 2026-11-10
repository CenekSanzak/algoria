import { createHash } from 'node:crypto';

export function tempoSecretPlan(recipient, secret, remote = []) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) {
    throw new Error('Invalid Tempo testnet service receiver');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('Invalid MPP secret');
  const values = { TEMPO_IMAGE_RECIPIENT: recipient, TEMPO_IMAGE_PRICE_ATOMIC: '10000', MPP_SECRET_KEY: secret };
  for (const [name, value] of Object.entries(values)) {
    const existing = remote.find(x => x.name === name);
    // Management API calls the SHA-256 digest `value`; CLI reports call it
    // `digest`. Never log either field or accept an unknown metadata shape.
    const digest = existing?.digest ?? existing?.value;
    if (existing && (typeof digest !== 'string' || !/^[0-9a-f]{64}$/i.test(digest) ||
        digest.toLowerCase() !== createHash('sha256').update(value).digest('hex'))) {
      throw new Error(`Deployed ${name} differs; refusing replacement or secret rotation`);
    }
  }
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}
