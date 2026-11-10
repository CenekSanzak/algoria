/** Load only for an explicit Tempo/MPP operation. Bundled for installed hosts. */
/** @returns {Promise<any>} */
export function loadTempoSdk() { return import(new URL('../vendor/tempo-sdk.mjs', import.meta.url).href); }
