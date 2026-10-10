import { Bytes, Hash, Hex, P256, PublicKey, Signature } from 'ox';
import { canonicalPermission, activePermission } from '../../../agent-skills/plugins/algoria/lib/services/permission-schema.mjs';
import { tempoResource } from '../../../agent-skills/plugins/algoria/lib/services/tempo-services.mjs';

/** @param {string} json @param {number} now */
export function preparePermissionJSON(json, now) {
  const policy = JSON.parse(json);
  activePermission(policy, now);
  const digest = Hash.sha256(Bytes.fromString(canonicalPermission(policy)), { as: 'Hex' });
  return JSON.stringify({ digest, summary: { policyId: policy.id, budget: policy.budget,
    agent: policy.agent, service: policy.service, resource: policy.resource,
    network: 'Tempo Moderato (42431)', token: policy.token, recipient: policy.recipient,
    total: (Number(policy.totalAtomic) / 1e7).toFixed(6), perCall: (Number(policy.perCallAtomic) / 1e7).toFixed(6),
    expires: new Date(policy.validUntil * 1000).toISOString(), replacement: policy.previousId } });
}

/** @param {any} receipt @param {any} offer @param {number} now @param {string} [service] */
export function checkPurchasePermission(receipt, offer, now, service = 'image.generate') {
  activePermission(receipt?.policy, now);
  const p = receipt.policy;
  const digest = Hash.sha256(Bytes.fromString(canonicalPermission(p)), { as: 'Hex' });
  // Apple may produce high-S DER; noble's verifier requires normalized low-S.
  const parsed = Signature.fromDerHex(receipt.signature);
  const order = P256.noble.Point.Fn.ORDER, s = BigInt(parsed.s);
  const signature = { r: parsed.r, s: Hex.fromNumber(s > order / 2n ? order - s : s, { size: 32 }) };
  if (digest !== receipt.digest ||
      !P256.verify({ payload: digest, publicKey: PublicKey.fromHex(receipt.publicKey), signature }) ||
      p.service !== service || p.resource !== tempoResource(service) ||
      offer.recipient.toLowerCase() !== p.recipient || offer.currency.toLowerCase() !== p.token ||
      BigInt(offer.amount) * 10n > BigInt(p.perCallAtomic)) throw new Error('Invalid or out-of-scope spending permission');
  return { id: p.id, budget: p.budget, agent: p.agent, expires: new Date(p.validUntil * 1000).toISOString(),
    total: (Number(p.totalAtomic) / 1e7).toFixed(6), perCall: (Number(p.perCallAtomic) / 1e7).toFixed(6) };
}
