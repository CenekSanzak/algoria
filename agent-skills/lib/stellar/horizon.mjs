/**
 * The two read-only network calls the wallet skill needs: funding a testnet
 * account from Friendbot, and reading an account's balances from Horizon.
 * Both are plain fetch with a timeout; no SDK, no signing, no writes.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fund a testnet account. Friendbot exists on testnet only; pubnet has no
 * faucet and never will, so the caller must not reach here with a real network.
 *
 * @param {import('./network.mjs').NetworkProfile} network
 * @param {string} publicKey
 * @returns {Promise<{funded: boolean, alreadyFunded: boolean, detail: string}>}
 */
export async function fundWithFriendbot(network, publicKey) {
  if (!network.friendbotUrl) {
    throw new Error(`${network.id} has no faucet: fund this account by sending XLM to it yourself`);
  }
  const response = await fetchWithTimeout(`${network.friendbotUrl}/?addr=${encodeURIComponent(publicKey)}`);
  const body = await response.text();

  if (response.ok) return { funded: true, alreadyFunded: false, detail: 'funded by Friendbot' };
  if (body.includes('op_already_exists') || body.includes('createAccountAlreadyExist')) {
    return { funded: false, alreadyFunded: true, detail: 'account already exists and is funded' };
  }
  throw new Error(`Friendbot refused (${response.status}): ${body.slice(0, 400)}`);
}

/**
 * @typedef {object} AccountSummary
 * @property {boolean} exists
 * @property {string | null} xlm
 * @property {Array<{asset: string, balance: string}>} balances
 */

/**
 * @param {import('./network.mjs').NetworkProfile} network
 * @param {string} publicKey
 * @returns {Promise<AccountSummary>}
 */
export async function loadAccount(network, publicKey) {
  const response = await fetchWithTimeout(`${network.horizonUrl}/accounts/${encodeURIComponent(publicKey)}`);
  if (response.status === 404) return { exists: false, xlm: null, balances: [] };
  if (!response.ok) {
    throw new Error(`Horizon returned ${response.status} for ${publicKey}`);
  }
  /** @type {{balances?: Array<Record<string, string | undefined>>}} */
  const account = await response.json();
  const balances = (account.balances ?? []).map((entry) => ({
    asset:
      entry.asset_type === 'native'
        ? 'XLM'
        : entry.asset_code
          ? `${entry.asset_code}:${entry.asset_issuer}`
          : (entry.asset_type ?? 'unknown'),
    balance: entry.balance ?? '0'
  }));
  return {
    exists: true,
    xlm: balances.find((entry) => entry.asset === 'XLM')?.balance ?? '0',
    balances
  };
}
