/**
 * Network profiles. One wallet belongs to exactly one network, and the network
 * is always explicit: there is no default, because the difference between
 * testnet and pubnet is the difference between play money and real money.
 */

export const NETWORKS = {
  testnet: {
    id: 'testnet',
    caip2: 'stellar:testnet',
    passphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    friendbotUrl: 'https://friendbot.stellar.org',
    usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    explorer: 'https://stellar.expert/explorer/testnet',
    realValue: false
  },
  pubnet: {
    id: 'pubnet',
    caip2: 'stellar:pubnet',
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    friendbotUrl: null,
    usdcSac: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    explorer: 'https://stellar.expert/explorer/public',
    realValue: true
  }
};

/** @typedef {typeof NETWORKS[keyof typeof NETWORKS]} NetworkProfile */

/**
 * Resolve a network name. Accepts the aliases people actually type.
 * @param {string | undefined} value
 * @returns {NetworkProfile}
 */
export function resolveNetwork(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'testnet' || normalized === 'stellar:testnet' || normalized === 'test') {
    return NETWORKS.testnet;
  }
  if (
    normalized === 'pubnet' ||
    normalized === 'stellar:pubnet' ||
    normalized === 'mainnet' ||
    normalized === 'public'
  ) {
    return NETWORKS.pubnet;
  }
  throw new Error(
    `unknown network ${JSON.stringify(value ?? '')}. Pass --network testnet or --network pubnet explicitly.`
  );
}
