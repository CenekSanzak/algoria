import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from 'npm:@x402/core@2.22.0/http';
import {
  type FacilitatorClient,
  FacilitatorTimeoutError,
  HTTPFacilitatorClient,
} from 'npm:@x402/core@2.22.0/server';
import {
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  VerifyError,
} from 'npm:@x402/core@2.22.0/types';
import { PaymentPayloadV2Schema } from 'npm:@x402/core@2.22.0/schemas';
import { ExactStellarScheme } from 'npm:@x402/stellar@2.22.0/exact/server';
import { Address, Networks, scValToNative, StrKey, Transaction } from 'npm:@stellar/stellar-sdk@16.2.0';

export type { PaymentPayload, PaymentRequired, PaymentRequirements };
export const NETWORK = 'stellar:testnet' as const;
// SAC for USDC issued by GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5.
export const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
export const DEFAULT_FACILITATOR_URL = 'https://www.x402.org/facilitator';
const MAX_PAYMENT_HEADER_BYTES = 32_768;
const FACILITATOR_TIMEOUT_MS = 20_000;

export class PaymentInputError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PaymentInputError';
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')
    }}`;
  }
  return JSON.stringify(value);
}

function assertRequirements(requirements: PaymentRequirements): void {
  if (
    requirements?.scheme !== 'exact' || requirements.network !== NETWORK ||
    requirements.asset !== ASSET || !StrKey.isValidEd25519PublicKey(requirements.payTo) ||
    typeof requirements.amount !== 'string' ||
    !/^[1-9]\d*$/.test(requirements.amount) ||
    BigInt(requirements.amount) > (1n << 127n) - 1n ||
    !Number.isInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds < 1 || requirements.maxTimeoutSeconds > 120 ||
    requirements.extra?.areFeesSponsored !== true
  ) throw new PaymentInputError('unsupported_payment_requirements');
}

function assertAccepted(payload: PaymentPayload, requirements: PaymentRequirements): void {
  assertRequirements(requirements);
  if (payload?.x402Version !== 2 || canonical(payload.accepted) !== canonical(requirements)) {
    throw new PaymentInputError('accepted_requirements_mismatch');
  }
}

/** Parse the authorization, independently of client-supplied JSON claims.
 * Only a single standard account's single SAC transfer is accepted in this MVP.
 * Facilitator verification still checks signatures, expiration, simulation and balances.
 */
function authorization(payload: PaymentPayload, requirements: PaymentRequirements) {
  assertAccepted(payload, requirements);
  const encoded = payload.payload?.transaction;
  if (typeof encoded !== 'string' || encoded.length > MAX_PAYMENT_HEADER_BYTES) {
    throw new PaymentInputError('invalid_stellar_transaction');
  }
  try {
    const tx = new Transaction(encoded, Networks.TESTNET);
    if (tx.operations.length !== 1) throw new Error();
    const op = tx.operations[0];
    if (op.type !== 'invokeHostFunction' || op.func.switch().name !== 'hostFunctionTypeInvokeContract') {
      throw new Error();
    }
    const invocation = op.func.invokeContract();
    const args = invocation.args();
    if (
      Address.fromScAddress(invocation.contractAddress()).toString() !== ASSET ||
      invocation.functionName().toString() !== 'transfer' || args.length !== 3 ||
      args[0].switch().name !== 'scvAddress' || args[1].switch().name !== 'scvAddress' ||
      args[2].switch().name !== 'scvI128'
    ) throw new Error();
    const payer = scValToNative(args[0]) as string;
    if (
      !StrKey.isValidEd25519PublicKey(payer) ||
      scValToNative(args[1]) !== requirements.payTo ||
      scValToNative(args[2]) !== BigInt(requirements.amount)
    ) throw new Error();
    if (op.auth?.length !== 1) throw new Error();
    const auth = op.auth[0];
    if (auth.credentials().switch().name !== 'sorobanCredentialsAddress') throw new Error();
    const credentials = auth.credentials().address();
    const root = auth.rootInvocation();
    if (
      Address.fromScAddress(credentials.address()).toString() !== payer ||
      credentials.signature().switch().name === 'scvVoid' ||
      root.subInvocations().length !== 0 ||
      root.function().switch().name !== 'sorobanAuthorizedFunctionTypeContractFn' ||
      root.function().contractFn().toXDR('base64') !== invocation.toXDR('base64')
    ) throw new Error();
    return { payer, nonce: credentials.nonce().toString() };
  } catch {
    throw new PaymentInputError('invalid_stellar_authorization');
  }
}

function failure(errorReason: string, payer?: string): Record<string, unknown> {
  return { success: false, network: NETWORK, transaction: '', errorReason, ...(payer ? { payer } : {}) };
}

function facilitatorPayload(payload: PaymentPayload, requirements: PaymentRequirements): PaymentPayload {
  // Discovery stays on our API. In particular, never echo a Bazaar extension to
  // a facilitator that might use it to register this service in its catalogue.
  return {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: payload.payload.transaction },
  };
}

function definitelyNotSubmitted(reason: string | undefined): boolean {
  return !!reason && (
    reason.startsWith('invalid_exact_stellar_') ||
    [
      'invalid_x402_version',
      'unsupported_scheme',
      'network_mismatch',
      'invalid_network',
      'verification_failed',
      'settle_exact_stellar_signer_selection_failed',
      'settle_exact_stellar_transaction_signing_failed',
      'settle_exact_stellar_fee_bump_signing_failed',
    ]
      .includes(reason)
  );
}

export class PaymentGateway {
  private readonly facilitator: FacilitatorClient;
  private readonly scheme = new ExactStellarScheme();
  private supportedUntil = 0;
  private supportCheck?: Promise<void>;

  constructor(
    facilitatorUrl = DEFAULT_FACILITATOR_URL,
    options: { facilitator?: FacilitatorClient; timeoutMs?: number } = {},
  ) {
    const url = new URL(facilitatorUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Facilitator URL must use HTTPS');
    }
    this.facilitator = options.facilitator ?? new HTTPFacilitatorClient({
      url: url.toString().replace(/\/$/, ''),
      timeoutMs: Math.min(options.timeoutMs ?? FACILITATOR_TIMEOUT_MS, FACILITATOR_TIMEOUT_MS),
    });
  }

  async requirements(payTo: string, amountAtomic: string): Promise<PaymentRequirements> {
    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network: NETWORK,
      asset: ASSET,
      amount: amountAtomic,
      payTo,
      maxTimeoutSeconds: 120,
      extra: { areFeesSponsored: true },
    };
    assertRequirements(requirements);
    if (Date.now() >= this.supportedUntil) {
      this.supportCheck ??= this.facilitator.getSupported().then((supported) => {
        if (
          !supported.kinds.some((kind) =>
            kind.x402Version === 2 && kind.scheme === 'exact' &&
            kind.network === NETWORK && kind.extra?.areFeesSponsored === true
          )
        ) {
          throw new Error('Facilitator does not support sponsored Stellar testnet exact payments');
        }
        this.supportedUntil = Date.now() + 300_000;
      }).finally(() => {
        this.supportCheck = undefined;
      });
      await this.supportCheck;
    }
    return this.scheme.enhancePaymentRequirements(requirements, {
      x402Version: 2,
      scheme: 'exact',
      network: NETWORK,
      extra: { areFeesSponsored: true },
    }, []);
  }

  challenge(
    requirements: PaymentRequirements,
    resourceUrl: string,
    description: string,
    bazaarExtensions?: Record<string, unknown>,
  ): { body: PaymentRequired; header: string } {
    assertRequirements(requirements);
    const body: PaymentRequired = {
      x402Version: 2,
      resource: { url: resourceUrl, description, mimeType: 'application/json' },
      accepts: [structuredClone(requirements)],
      ...(bazaarExtensions ? { extensions: bazaarExtensions } : {}),
    };
    return { body, header: encodePaymentRequiredHeader(body) };
  }

  parse(header: string): PaymentPayload {
    if (!header || header.length > MAX_PAYMENT_HEADER_BYTES) {
      throw new PaymentInputError('invalid_payment_header');
    }
    try {
      const parsed = PaymentPayloadV2Schema.parse(decodePaymentSignatureHeader(header));
      const payload = parsed as PaymentPayload;
      assertRequirements(payload.accepted);
      return payload;
    } catch {
      throw new PaymentInputError('invalid_payment_header');
    }
  }

  async fingerprint(payload: PaymentPayload): Promise<string> {
    const { payer, nonce } = authorization(payload, payload.accepted);
    // Soroban replay protection consumes address + nonce. Hashing a JSON payload or
    // envelope would let cosmetic changes or new signatures bypass our unique DB key.
    const identity = new TextEncoder().encode(`${NETWORK}:${payer}:${nonce}`);
    const digest = await crypto.subtle.digest('SHA-256', identity);
    return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{
    valid: boolean;
    payer?: string;
    reason?: string;
  }> {
    let payer: string;
    try {
      payer = authorization(payload, requirements).payer;
    } catch (error) {
      return { valid: false, reason: error instanceof PaymentInputError ? error.code : 'invalid_payment' };
    }
    try {
      const result = await this.facilitator.verify(facilitatorPayload(payload, requirements), requirements);
      if (!result.isValid) {
        return { valid: false, payer, reason: result.invalidReason ?? 'verification_failed' };
      }
      if (result.payer && result.payer !== payer) {
        return { valid: false, reason: 'facilitator_payer_mismatch' };
      }
      return { valid: true, payer };
    } catch (error) {
      if (error instanceof VerifyError && error.statusCode < 500 && error.statusCode !== 429) {
        return { valid: false, payer, reason: error.invalidReason ?? 'verification_failed' };
      }
      return {
        valid: false,
        payer,
        reason: error instanceof FacilitatorTimeoutError ? 'facilitator_timeout' : 'facilitator_unavailable',
      };
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{
    outcome: 'success' | 'failed' | 'uncertain';
    receipt: Record<string, unknown>;
  }> {
    let payer: string;
    try {
      payer = authorization(payload, requirements).payer;
    } catch (error) {
      return {
        outcome: 'failed',
        receipt: failure(error instanceof PaymentInputError ? error.code : 'invalid_payment'),
      };
    }
    try {
      const result = await this.facilitator.settle(facilitatorPayload(payload, requirements), requirements);
      return this.classifySettlement(result, payer, requirements);
    } catch (error) {
      if (error instanceof SettleError) {
        const result: SettleResponse = {
          success: false,
          transaction: error.transaction ?? '',
          network: error.network ?? NETWORK,
          payer: error.payer,
          errorReason: error.errorReason,
        };
        // A 5xx/429 error cannot establish that no side effect happened remotely.
        if (error.statusCode >= 500 || error.statusCode === 429) {
          return { outcome: 'uncertain', receipt: { ...result } };
        }
        return this.classifySettlement(result, payer, requirements);
      }
      return {
        outcome: 'uncertain',
        receipt: failure(
          error instanceof FacilitatorTimeoutError ? 'settlement_timeout' : 'settlement_unconfirmed',
          payer,
        ),
      };
    }
  }

  private classifySettlement(result: SettleResponse, payer: string, requirements: PaymentRequirements): {
    outcome: 'success' | 'failed' | 'uncertain';
    receipt: Record<string, unknown>;
  } {
    if (
      result.network !== NETWORK || (result.payer && result.payer !== payer) ||
      (result.amount !== undefined && result.amount !== requirements.amount)
    ) {
      return { outcome: 'uncertain', receipt: failure('invalid_settlement_receipt', payer) };
    }
    const receipt: Record<string, unknown> = { ...result, payer };
    if (result.success && /^[a-f\d]{64}$/i.test(result.transaction)) return { outcome: 'success', receipt };
    if (!result.success && !result.transaction && definitelyNotSubmitted(result.errorReason)) {
      return { outcome: 'failed', receipt };
    }
    // The upstream Stellar scheme reports the same error for a confirmed failure
    // and exhausted confirmation polling. Keep capacity/payment reserved for review.
    return { outcome: 'uncertain', receipt };
  }
}

export function receiptHeader(receipt: Record<string, unknown>): string {
  return encodePaymentResponseHeader(receipt as SettleResponse);
}
