/**
 * SEP-10: proving to the anchor that we hold the wallet, without giving it
 * anything.
 *
 * The anchor hands out a challenge transaction. We verify it is really from
 * the pinned signing key, for our account, on testnet, then sign it locally
 * and hand it back for a JWT.
 *
 * Two things this must never do: submit the challenge to the network (it is a
 * signature, not a payment), and sign a challenge that failed verification.
 * Real XDR is involved, so this module loads the SDK, lazily, like
 * `lib/stellar/trustline.mjs` does.
 */

import { ANCHOR, anchorFetch } from './anchor.mjs';

/** @returns {Promise<typeof import('@stellar/stellar-sdk')>} */
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
 * Log in to the anchor and return a bearer token.
 *
 * The token is returned, never stored: a fresh login is two HTTP calls, and a
 * JWT on disk is one more secret to protect for no gain. It goes to the anchor
 * and nowhere else.
 *
 * @param {import('../stellar/keypair.mjs').StellarKeypair} keypair
 * @returns {Promise<string>}
 */
export async function authenticate(keypair) {
  const { Keypair, Networks, WebAuth } = await loadSdk();

  const challenge = await anchorFetch(`/auth?account=${encodeURIComponent(keypair.publicKey)}`);
  if (typeof challenge?.transaction !== 'string') {
    throw new Error('the anchor returned no SEP-10 challenge');
  }
  if (challenge.network_passphrase && challenge.network_passphrase !== ANCHOR.passphrase) {
    throw new Error(`the SEP-10 challenge is for ${challenge.network_passphrase}, not testnet`);
  }

  let read;
  try {
    read = WebAuth.readChallengeTx(
      challenge.transaction,
      ANCHOR.signingKey,
      Networks.TESTNET,
      ANCHOR.homeDomain,
      ANCHOR.homeDomain
    );
  } catch (error) {
    throw new Error(`the SEP-10 challenge did not verify: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (read.clientAccountID !== keypair.publicKey) {
    throw new Error('the SEP-10 challenge is for a different account');
  }
  if (read.matchedHomeDomain !== ANCHOR.homeDomain) {
    throw new Error(`the SEP-10 challenge names ${read.matchedHomeDomain}, not ${ANCHOR.homeDomain}`);
  }
  if (read.memo) {
    throw new Error('the SEP-10 challenge carries a memo; this integration does not use muxed accounts');
  }

  read.tx.sign(Keypair.fromSecret(keypair.secretSeed));
  const token = await anchorFetch('/auth', { method: 'POST', body: { transaction: read.tx.toXDR() } });
  if (typeof token?.token !== 'string') throw new Error('the anchor returned no session token');
  return token.token;
}
