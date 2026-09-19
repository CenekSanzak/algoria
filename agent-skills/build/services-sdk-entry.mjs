import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

/** @param {any} challenge @param {string} seed */
export async function signChallenge(challenge, seed) {
  const signer = createEd25519Signer(seed, 'stellar:testnet');
  const client = new x402Client().register('stellar:testnet', new ExactStellarScheme(signer));
  return encodePaymentSignatureHeader(await client.createPaymentPayload(challenge));
}

/** Validate without defaults, coercion, or removing fields: retries keep exact input.
 * @param {object} schema @param {unknown} input
 */
export function validateInput(schema, input) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  // NodeNext models this CommonJS default as a namespace; esbuild unwraps it.
  const installFormats = /** @type {(instance: Ajv2020) => void} */ (/** @type {unknown} */ (addFormats));
  installFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(input)) throw new Error(`invalid service input: ${ajv.errorsText(validate.errors)}`);
}
