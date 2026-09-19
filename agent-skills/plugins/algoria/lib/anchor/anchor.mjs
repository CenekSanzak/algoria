/**
 * The TR mock anchor: TRY in, testnet USDC out.
 *
 * It is a sandbox. No real bank, no real lira, no mainnet. The USDC that comes
 * out is real testnet USDC, which is worth nothing and is the point.
 *
 * Everything here is pinned. The host, the SEP-10 signing key and the USDC
 * issuer are constants, checked against the anchor's own `stellar.toml` and
 * `/health` before a challenge is ever signed. If any of them has moved, the
 * integration stops instead of signing something for an unknown party.
 */

/** Everything this skill trusts about the anchor, pinned. */
export const ANCHOR = {
  base: 'https://tr-mock-anchor.fly.dev',
  homeDomain: 'tr-mock-anchor.fly.dev',
  signingKey: 'GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M',
  usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  passphrase: 'Test SDF Network ; September 2015'
};

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * This anchor exists on testnet only. Reaching it with a pubnet wallet would
 * mean signing a challenge for a real-money account against a sandbox, so it
 * is refused rather than handled.
 * @param {import('../stellar/network.mjs').NetworkProfile} network
 */
export function assertAnchorNetwork(network) {
  if (network.id !== 'testnet') {
    throw new Error(`the TR mock anchor is testnet-only; ${network.id} wallets cannot use it`);
  }
  if (network.usdc.issuer !== ANCHOR.usdcIssuer) {
    throw new Error('this wallet’s USDC issuer is not the one the anchor pays out');
  }
}

/**
 * One HTTP call to the anchor, with a timeout and a readable failure.
 *
 * @param {string} path absolute path under the anchor base, e.g. `/sep6/info`
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {string} [options.jwt]
 * @param {unknown} [options.body] JSON-encoded when present
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any>}
 */
export async function anchorFetch(path, { method = 'GET', jwt, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${ANCHOR.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(`anchor unreachable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  /** @type {any} */
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = parsed?.error ?? parsed?.message ?? text.slice(0, 300);
    const error = new Error(`anchor ${method} ${path} failed (${response.status}): ${detail}`);
    Object.assign(error, { status: response.status, body: parsed });
    throw error;
  }
  return parsed;
}

/**
 * @typedef {object} AnchorStatus
 * @property {string} environment
 * @property {{min: string, max: string}} tryLimits mock TRY per deposit
 * @property {string} buyRate TRY per USDC, including the anchor's spread
 * @property {number} feePercent
 */

/**
 * Check the anchor is who we think it is, and read its live limits.
 *
 * The limits are read rather than hardcoded: `/sep6/info` and `/health` state
 * them in different units (USDC vs TRY), and only `/health` is in the unit a
 * deposit is denominated in.
 *
 * @returns {Promise<AnchorStatus>}
 */
export async function verifyAnchor() {
  const toml = await fetchToml();
  const health = await anchorFetch('/health');

  const mismatches = [];
  if (toml.SIGNING_KEY !== ANCHOR.signingKey) mismatches.push('SEP-10 signing key');
  if (toml.NETWORK_PASSPHRASE !== ANCHOR.passphrase) mismatches.push('network passphrase');
  if (toml.WEB_AUTH_ENDPOINT !== `${ANCHOR.base}/auth`) mismatches.push('web auth endpoint');
  if (toml.TRANSFER_SERVER !== `${ANCHOR.base}/sep6`) mismatches.push('transfer server');
  if (health?.asset?.issuer !== ANCHOR.usdcIssuer) mismatches.push('USDC issuer');
  if (health?.network_passphrase !== ANCHOR.passphrase) mismatches.push('health network passphrase');
  if (mismatches.length > 0) {
    throw new Error(
      `the anchor at ${ANCHOR.base} no longer matches what this skill pinned (${mismatches.join(', ')}). ` +
        'Stopping rather than signing for an unknown party.'
    );
  }

  const feePercent = Number(health?.sep6_fee_percent ?? 0.5);
  return {
    environment: String(health?.environment ?? 'unknown'),
    tryLimits: {
      min: String(health?.limits?.min_onramp_try ?? '50'),
      max: String(health?.limits?.max_onramp_try ?? '3000')
    },
    buyRate: String(health?.rates?.buy_rate ?? ''),
    feePercent: Number.isFinite(feePercent) ? feePercent : 0.5
  };
}

/**
 * The handful of `KEY="value"` lines this integration cares about. A full TOML
 * parser would be a dependency for six regex matches.
 * @returns {Promise<Record<string, string>>}
 */
async function fetchToml() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let text;
  try {
    const response = await fetch(`${ANCHOR.base}/.well-known/stellar.toml`, { signal: controller.signal });
    if (!response.ok) throw new Error(`stellar.toml returned ${response.status}`);
    text = await response.text();
  } catch (error) {
    throw new Error(`cannot read the anchor’s stellar.toml: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  /** @type {Record<string, string>} */
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)\s*=\s*"([^"]*)"/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * Validate a mock TRY amount against the anchor's live limits.
 * @param {string} amount
 * @param {AnchorStatus} status
 * @returns {string} the amount normalised to two decimals
 */
export function normaliseTryAmount(amount, status) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--try expects a positive amount of mock lira, got ${JSON.stringify(amount)}`);
  }
  const min = Number(status.tryLimits.min);
  const max = Number(status.tryLimits.max);
  if (value < min || value > max) {
    throw new Error(`the anchor accepts ${min}–${max} TRY per deposit; ${value} is outside that`);
  }
  return value.toFixed(2);
}

/**
 * What a deposit of this many lira is worth, roughly. The anchor prices at
 * settlement, so this is for showing the user, never for accounting.
 * @param {string} amountTry
 * @param {AnchorStatus} status
 * @returns {string | null}
 */
export function estimateUsdc(amountTry, status) {
  const rate = Number(status.buyRate);
  const lira = Number(amountTry);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(lira)) return null;
  return ((lira * (1 - status.feePercent / 100)) / rate).toFixed(7);
}
