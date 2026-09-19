/** @returns {Promise<{signChallenge: (challenge: any, seed: string) => Promise<string>, validateInput: (schema: object, input: unknown) => void, decodePaymentRequiredHeader: (header: string) => any, decodePaymentResponseHeader: (header: string) => any}>} */
export async function loadServicesSdk() {
  return import(new URL('../vendor/services-sdk.mjs', import.meta.url).href);
}
