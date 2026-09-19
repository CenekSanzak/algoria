import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Account, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative } from '@stellar/stellar-sdk';

export { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';

/** Read-only simulation: no wallet, signature or transaction submission.
 * @param {string} contractId @param {'total_agents' | 'agent_uri'} method @param {number} [agentId]
 */
export async function readRegistry(contractId, method, agentId) {
  const server = new rpc.Server('https://soroban-testnet.stellar.org', { timeout: 15_000 });
  const args = agentId === undefined ? [] : [nativeToScVal(agentId, { type: 'u32' })];
  const tx = new TransactionBuilder(new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contractId).call(method, ...args)).setTimeout(30).build();
  const result = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result) || !result.result) throw new Error('testnet registry read failed');
  return scValToNative(result.result.retval);
}

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
