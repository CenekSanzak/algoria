// Match the pinned viem Tempo Moderato chain, never the mainnet explorer.
export const TEMPO_EXPLORER = 'https://explore.testnet.tempo.xyz';
export const TEMPO_TOKEN = '0x20c0000000000000000000000000000000000000';

/** Only local, validated transaction identities become links.
 * @param {unknown} transaction @returns {string | null} */
export function tempoTransactionUrl(transaction) {
  return typeof transaction === 'string' && /^0x[0-9a-fA-F]{64}$/.test(transaction)
    ? `${TEMPO_EXPLORER}/tx/${transaction}` : null;
}
