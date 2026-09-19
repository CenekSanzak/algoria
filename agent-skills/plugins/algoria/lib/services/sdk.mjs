import { silenceBufferDeprecation } from '../stellar/sdk.mjs';

/** @returns {Promise<{readRegistry: (contractId: string, method: 'total_agents' | 'agent_uri', agentId?: number) => Promise<any>, signChallenge: (challenge: any, seed: string) => Promise<string>, validateInput: (schema: object, input: unknown) => void, decodePaymentRequiredHeader: (header: string) => any, decodePaymentResponseHeader: (header: string) => any}>} */
export async function loadServicesSdk() {
  silenceBufferDeprecation();
  return import(new URL('../vendor/services-sdk.mjs', import.meta.url).href);
}
