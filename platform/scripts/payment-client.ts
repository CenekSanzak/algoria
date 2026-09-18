import { x402Client } from 'npm:@x402/core@2.22.0/client';
import { encodePaymentSignatureHeader } from 'npm:@x402/core@2.22.0/http';
import { type PaymentRequired } from 'npm:@x402/core@2.22.0/types';
import { createEd25519Signer } from 'npm:@x402/stellar@2.22.0';
import { ExactStellarScheme } from 'npm:@x402/stellar@2.22.0/exact/client';
import { Keypair } from 'npm:@stellar/stellar-sdk@16.2.0';
import { ASSET, NETWORK } from '../supabase/functions/api/payments.ts';

/** Local test helper only. It signs an auth entry but does not submit a payment.
 * The caller must pin the service's recipient and an explicit atomic spending cap.
 * Never log its returned header: it authorizes a transfer until ledger expiration.
 */
export async function signPaymentChallenge(
  challenge: PaymentRequired,
  walletPath: string,
  expectedPayTo: string,
  maxAmountAtomic: string,
): Promise<string> {
  if (challenge.x402Version !== 2 || !/^[1-9]\d*$/.test(maxAmountAtomic)) {
    throw new Error('Invalid challenge or budget');
  }
  const accepted = challenge.accepts.filter((offer) =>
    offer.scheme === 'exact' &&
    offer.network === NETWORK && offer.asset === ASSET && offer.payTo === expectedPayTo &&
    offer.extra?.areFeesSponsored === true && /^[1-9]\d*$/.test(offer.amount) &&
    BigInt(offer.amount) <= BigInt(maxAmountAtomic) && offer.maxTimeoutSeconds > 0 &&
    offer.maxTimeoutSeconds <= 120
  );
  if (accepted.length !== 1) {
    throw new Error('Challenge must have exactly one authorized testnet offer within the spending cap');
  }
  const wallet = JSON.parse(await Deno.readTextFile(walletPath));
  if (wallet.network !== NETWORK || Keypair.fromSecret(wallet.secretKey).publicKey() !== wallet.publicKey) {
    throw new Error('Local testnet wallet is invalid');
  }
  const client = new x402Client().register(
    NETWORK,
    new ExactStellarScheme(createEd25519Signer(wallet.secretKey, NETWORK)),
  );
  const payment = await client.createPaymentPayload({ ...challenge, accepts: accepted });
  return encodePaymentSignatureHeader(payment);
}
