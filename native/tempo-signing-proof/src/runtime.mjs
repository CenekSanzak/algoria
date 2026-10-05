// JavaScriptCore has no browser TextEncoder/TextDecoder globals.
import './encoding.mjs';
import { prepareJSON as prepareProof, completeJSON as completeProof } from './transaction.mjs';
import { preparePurchaseJSON, completePurchaseJSON } from './purchase.mjs';
export { preparePermissionJSON } from './permissions.mjs';
export function prepareJSON(json, publicKey, now) {
  return JSON.parse(json).version === 2 ? preparePurchaseJSON(json, publicKey, now) : prepareProof(json, publicKey, now);
}
export function completeJSON(json, publicKey, der, now) {
  return JSON.parse(json).version === 2 ? completePurchaseJSON(json, publicKey, der, now) : completeProof(json, publicKey, der, now);
}
