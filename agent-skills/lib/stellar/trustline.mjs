/**
 * USDC trustlines.
 *
 * This is the one piece of Stellar that has no equivalent on Base or Solana: a
 * Stellar account cannot hold USDC at all until it has explicitly opted in with
 * a `changeTrust` operation. A freshly created wallet holds XLM and nothing
 * else, so every x402 flow is blocked until this runs.
 *
 * Signing and submitting a transaction needs real XDR, so this module — and
 * only this module — loads `@stellar/stellar-sdk`. It is imported lazily so
 * that creating a wallet, reading a balance, or exporting a seed keeps working
 * on a machine where dependencies were never installed.
 */

/**
 * @returns {Promise<typeof import('@stellar/stellar-sdk')>}
 */
async function loadSdk() {
  try {
    return await import('@stellar/stellar-sdk');
  } catch {
    throw new Error(
      'this command needs @stellar/stellar-sdk. Run `pnpm install` in the agent-skills directory, then try again.'
    );
  }
}

/**
 * Does this account already trust the network's USDC?
 * @param {import('./horizon.mjs').AccountSummary} account
 * @param {import('./network.mjs').NetworkProfile} network
 * @returns {boolean}
 */
export function hasUsdcTrustline(account, network) {
  const wanted = `${network.usdc.code}:${network.usdc.issuer}`;
  return account.balances.some((entry) => entry.asset === wanted);
}

/**
 * The USDC balance, or null when no trustline exists. `null` and `"0"` mean
 * different things and the caller is expected to tell the user which it is.
 * @param {import('./horizon.mjs').AccountSummary} account
 * @param {import('./network.mjs').NetworkProfile} network
 * @returns {string | null}
 */
export function usdcBalance(account, network) {
  const wanted = `${network.usdc.code}:${network.usdc.issuer}`;
  return account.balances.find((entry) => entry.asset === wanted)?.balance ?? null;
}

/**
 * Add a USDC trustline, signing locally and submitting to Horizon.
 *
 * `limit` is left at the Stellar maximum deliberately: a trustline limit is not
 * a spending control (it caps what the account can *hold*, not what it can
 * send), and a low one silently bounces incoming payments later.
 *
 * @param {object} options
 * @param {import('./network.mjs').NetworkProfile} options.network
 * @param {import('./keypair.mjs').StellarKeypair} options.keypair
 * @returns {Promise<{created: boolean, hash: string | null, asset: string}>}
 */
export async function addUsdcTrustline({ network, keypair }) {
  const { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } = await loadSdk();

  const asset = new Asset(network.usdc.code, network.usdc.issuer);
  const assetLabel = `${network.usdc.code}:${network.usdc.issuer}`;
  const server = new Horizon.Server(network.horizonUrl);

  const account = await server.loadAccount(keypair.publicKey).catch(() => {
    throw new Error(
      `account ${keypair.publicKey} does not exist on ${network.id} yet. It needs a starting XLM balance before it can add a trustline.`
    );
  });

  const alreadyTrusted = account.balances.some((entry) => {
    const line = /** @type {{asset_code?: string, asset_issuer?: string}} */ (entry);
    return line.asset_code === asset.getCode() && line.asset_issuer === asset.getIssuer();
  });
  if (alreadyTrusted) {
    return { created: false, hash: null, asset: assetLabel };
  }

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();

  transaction.sign(Keypair.fromSecret(keypair.secretSeed));

  try {
    const result = await server.submitTransaction(transaction);
    return { created: true, hash: result.hash, asset: assetLabel };
  } catch (error) {
    throw new Error(`trustline submission failed: ${describeHorizonError(error)}`);
  }
}

/**
 * Horizon buries the useful part of a failure several levels down. Surface it
 * rather than a bare "Request failed with status code 400".
 * @param {any} error
 * @returns {string}
 */
function describeHorizonError(error) {
  const data = error?.response?.data;
  const codes = data?.extras?.result_codes;
  if (codes) {
    const operations = Array.isArray(codes.operations) ? ` (${codes.operations.join(', ')})` : '';
    return `${codes.transaction ?? 'unknown'}${operations}`;
  }
  return data?.title ?? (error instanceof Error ? error.message : String(error));
}
