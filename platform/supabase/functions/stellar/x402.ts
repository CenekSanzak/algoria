// x402 v2 `exact` payments on Stellar for the provider: the 402 challenge, reading and checking a
// paid request, the facilitator client and how a settlement answer is read.
//
// Ported for Deno from @stellar-agent-services/provider-kit 0.1.0 (MIT, AlgoriaLabs):
// payments/x402-server.ts, payload-checks.ts, facilitator.ts and settlement.ts. The kit runs as a
// long-lived Node server; this provider runs as a Supabase Edge Function, so it keeps the kit's money
// rules and drops its process model.
//
// - The challenge is built from the manifest: one `accepts` entry, the manifest's plus `amount` [P4],
//   resource.url is the create-job URL [P5], and x402's Bazaar extension describes the call [P6].
// - A payment is checked locally before the facilitator sees it: exactly one USDC
//   transfer(payer, payTo, price), authorized by the payer's own signed auth entry. Anything else is
//   refused with a 402. The fingerprint is sha256(JCS({ network, payer, nonce })): Soroban accepts an
//   (address, nonce) once, so one signed payment can buy one job [P9].
// - The provider never signs. The facilitator verifies and settles; its answer is "settled" only with
//   a transaction hash, "failed" only when it says nothing was submitted, and "uncertain" otherwise,
//   which makes the job payment_uncertain, decided from the chain and never charged again [J13].

import { Address, Networks, scValToNative, Transaction, xdr } from 'npm:@stellar/stellar-sdk@16.2.0';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from 'npm:@x402/core@2.22.0/http';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from 'npm:@x402/core@2.22.0/types';
import {
  canonicalSha256,
  createJobUrl,
  type JsonObject,
  type PaymentReceipt,
  type ProviderManifest,
  type ServiceDescriptor,
  type StellarNetwork,
} from './protocol.ts';

export type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse };

/** Many HTTP stacks cap all headers together at 8–16 KiB, so the extension is left out above this. */
const MAX_CHALLENGE_HEADER_BYTES = 8 * 1024;
/** A signed transfer is about 1 KiB; anything far larger is not one. */
const MAX_TRANSACTION_BASE64_LENGTH = 16 * 1024;
const MAX_PAYMENT_HEADER_BYTES = 32 * 1024;

export function paymentRequirements(
  manifest: ProviderManifest,
  service: ServiceDescriptor,
): PaymentRequirements {
  const { scheme, network, asset, payTo, maxTimeoutSeconds, extra } = manifest.payment.accepts[0];
  return {
    scheme,
    network,
    asset,
    amount: service.price.amount,
    payTo,
    maxTimeoutSeconds,
    extra,
  } as PaymentRequirements;
}

export function paymentRequired(
  manifest: ProviderManifest,
  service: ServiceDescriptor,
  error?: string,
): PaymentRequired {
  const challenge: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: createJobUrl(manifest.baseUrl, service.name),
      description: service.description,
      mimeType: 'application/json',
    },
    accepts: [paymentRequirements(manifest, service)],
  };
  if (error !== undefined) challenge.error = error;
  const discoverable: PaymentRequired = { ...challenge, extensions: { bazaar: bazaar(service) } };
  return encodePaymentRequiredHeader(discoverable).length <= MAX_CHALLENGE_HEADER_BYTES
    ? discoverable
    : challenge;
}

/** x402's Bazaar extension (HTTP body form): an example request and response, and the input schema. */
function bazaar(service: ServiceDescriptor): JsonObject {
  const example = service.examples?.[0];
  const info: JsonObject = {
    input: { type: 'http', method: 'POST', bodyType: 'json', body: example?.input ?? {} },
  };
  const properties: JsonObject = {
    input: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'http' },
        method: { type: 'string', enum: ['POST'] },
        bodyType: { type: 'string', enum: ['json'] },
        body: service.inputSchema,
      },
      required: ['type', 'method', 'bodyType', 'body'],
      additionalProperties: false,
    },
  };
  if (example !== undefined) {
    info.output = { type: 'json', example: example.output };
    properties.output = {
      type: 'object',
      properties: { type: { type: 'string' }, example: service.outputSchema },
      required: ['type'],
    };
  }
  return {
    info,
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties,
      required: ['input'],
    },
  };
}

/** Decodes PAYMENT-SIGNATURE: a v2 payload whose `accepted` matches these requirements, else undefined. */
export function readPayment(header: string, requirements: PaymentRequirements): PaymentPayload | undefined {
  if (header.length > MAX_PAYMENT_HEADER_BYTES) return undefined;
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return undefined;
  }
  const accepted = payload?.accepted as Partial<PaymentRequirements> | undefined;
  const fields = ['scheme', 'network', 'asset', 'amount', 'payTo'] as const;
  if (payload?.x402Version !== 2 || accepted === undefined || accepted === null) return undefined;
  return fields.every((field) => accepted[field] === requirements[field]) ? payload : undefined;
}

/** What the local checks learned about a payment that passed them. */
export interface CheckedPayment {
  payer: string;
  /** The payer's auth-entry nonce, as a decimal string. */
  nonce: string;
  /** The last ledger at which the payer's signature is valid. Reconciliation needs it. */
  expirationLedger: number;
  /** sha256(JCS({ network, payer, nonce })): one per signed payment [P9]. */
  fingerprint: string;
}

export interface RefusedPayment {
  reason: string;
}

const PASSPHRASES: Readonly<Record<StellarNetwork, string>> = {
  'stellar:testnet': Networks.TESTNET,
  'stellar:pubnet': Networks.PUBLIC,
};

const refused = (reason: string): RefusedPayment => ({ reason: `invalid_exact_stellar_payload_${reason}` });

/** Checks a decoded payload against the requirements this provider issued, before any facilitator call. */
export async function checkPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<CheckedPayment | RefusedPayment> {
  const network = requirements.network as StellarNetwork;
  const passphrase = PASSPHRASES[network];
  if (passphrase === undefined) return { reason: 'invalid_network' };
  const encoded = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof encoded !== 'string' || encoded.length > MAX_TRANSACTION_BASE64_LENGTH) {
    return refused('malformed');
  }

  let transaction: Transaction;
  try {
    transaction = new Transaction(encoded, passphrase);
  } catch {
    return refused('malformed');
  }

  // One operation: invokeHostFunction calling the asset's contract.
  if (transaction.operations.length !== 1) return refused('wrong_operation');
  const operation = transaction.operations[0];
  if (operation.type !== 'invokeHostFunction') return refused('wrong_operation');
  if (operation.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return refused('wrong_operation');
  }
  const call = operation.func.invokeContract();

  // transfer(payer, payTo, amount) on the USDC contract, for exactly the price.
  let from: string;
  let to: string;
  let amount: unknown;
  try {
    if (Address.fromScAddress(call.contractAddress()).toString() !== requirements.asset) {
      return refused('wrong_asset');
    }
    if (call.functionName().toString() !== 'transfer' || call.args().length !== 3) {
      return refused('wrong_function_name');
    }
    [from, to, amount] = call.args().map((arg) => scValToNative(arg)) as [string, string, unknown];
  } catch {
    return refused('malformed');
  }
  if (to !== requirements.payTo) return refused('wrong_recipient');
  if (typeof amount !== 'bigint' || amount !== BigInt(requirements.amount)) return refused('wrong_amount');
  if (from === requirements.payTo) return refused('wrong_payer');

  // Exactly one auth entry: the payer's signature over this same transfer and nothing else.
  const auth = operation.auth ?? [];
  if (auth.length === 0) return refused('no_auth_entries');
  if (auth.length > 1) return refused('multiple_auth_entries');
  const entry = auth[0];
  const credentials = addressCredentials(entry.credentials());
  if (credentials === undefined) return refused('unsupported_credential_type');
  if (Address.fromScAddress(credentials.address()).toString() !== from) return refused('auth_not_by_payer');
  if (credentials.signature().switch() === xdr.ScValType.scvVoid()) return refused('missing_payer_signature');
  const root = entry.rootInvocation();
  if (root.subInvocations().length > 0) return refused('has_subinvocations');
  const authorized = root.function();
  if (authorized.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    return refused('auth_mismatch');
  }
  if (!authorized.contractFn().toXDR().equals(call.toXDR())) return refused('auth_mismatch');

  const nonce = credentials.nonce().toString();
  return {
    payer: from,
    nonce,
    expirationLedger: credentials.signatureExpirationLedger(),
    fingerprint: await canonicalSha256({ network, payer: from, nonce }),
  };
}

export function isRefused(result: CheckedPayment | RefusedPayment): result is RefusedPayment {
  return 'reason' in result;
}

/** Address credentials, in either encoding the x402 facilitator accepts. */
export function addressCredentials(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | undefined {
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress():
      return credentials.address();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2():
      return credentials.addressV2();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------
// The facilitator

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  supported?(): Promise<{ kinds: SupportedKind[] }>;
}

export class FacilitatorError extends Error {
  override name = 'FacilitatorError';
}

const VERIFY_TIMEOUT_SECONDS = 20;
const SETTLE_TIMEOUT_MARGIN_SECONDS = 30;
const SUPPORTED_TIMEOUT_SECONDS = 15;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** How long a settle call may take before the job is treated as payment_uncertain. */
export function settleTimeoutSeconds(maxTimeoutSeconds: number): number {
  return maxTimeoutSeconds + SETTLE_TIMEOUT_MARGIN_SECONDS;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The facilitator over HTTPS. Redirects are refused, so a payment only goes where the operator
 * configured; every call has a deadline; only the fields the scheme needs are sent; answers are
 * size-bounded and shape-checked. `headers` carries an API key, never a Stellar secret.
 */
export function httpFacilitator(
  url: string,
  options: { headers?: Record<string, string>; fetcher?: typeof fetch } = {},
): Facilitator {
  const base = new URL(url);
  if (base.protocol !== 'https:') throw new TypeError('the facilitator URL must be https://');
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError('the facilitator URL must not have user info, a query or a fragment');
  }
  const root = base.toString().replace(/\/+$/, '');
  const fetcher = options.fetcher ?? fetch;

  const call = async (path: string, init: { method: string; body?: unknown; timeoutSeconds: number }) => {
    const response = await fetcher(`${root}/${path}`, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(init.timeoutSeconds * 1000),
    });
    const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
    if (bytes === undefined) {
      throw new FacilitatorError(`${path} answered with more than ${MAX_RESPONSE_BYTES} bytes`);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new FacilitatorError(`${path} answered ${response.status} without JSON`);
    }
    return { status: response.status, body: isObject(body) ? body : {} };
  };

  // Only what the scheme needs: no resource description, no extensions.
  const request = (payload: PaymentPayload, requirements: PaymentRequirements) => ({
    x402Version: 2,
    paymentPayload: {
      x402Version: payload.x402Version,
      accepted: payload.accepted,
      payload: payload.payload,
    },
    paymentRequirements: requirements,
  });

  return {
    async verify(payload, requirements) {
      const { status, body } = await call('verify', {
        method: 'POST',
        body: request(payload, requirements),
        timeoutSeconds: VERIFY_TIMEOUT_SECONDS,
      });
      // A facilitator may answer an invalid payment with 400 and a verify body.
      if (typeof body.isValid !== 'boolean') throw new FacilitatorError(`verify answered ${status}`);
      const result: VerifyResult = { isValid: body.isValid };
      if (typeof body.invalidReason === 'string') result.invalidReason = body.invalidReason;
      if (typeof body.payer === 'string') result.payer = body.payer;
      return result;
    },

    async settle(payload, requirements) {
      const { status, body } = await call('settle', {
        method: 'POST',
        body: request(payload, requirements),
        timeoutSeconds: settleTimeoutSeconds(requirements.maxTimeoutSeconds),
      });
      if (typeof body.success !== 'boolean') throw new FacilitatorError(`settle answered ${status}`);
      const response: SettleResponse = {
        success: body.success,
        transaction: typeof body.transaction === 'string' ? body.transaction : '',
        network: (typeof body.network === 'string' ? body.network : '') as SettleResponse['network'],
      };
      if (typeof body.payer === 'string') response.payer = body.payer;
      if (typeof body.errorReason === 'string') response.errorReason = body.errorReason;
      return response;
    },

    async supported() {
      const { status, body } = await call('supported', {
        method: 'GET',
        timeoutSeconds: SUPPORTED_TIMEOUT_SECONDS,
      });
      // The first call the provider makes, so a missing or wrong API key shows here, before any payment.
      if (status === 401 || status === 403) {
        throw new FacilitatorError(
          `supported answered ${status}: the facilitator wants an API key or refused it`,
        );
      }
      if (status !== 200 || !Array.isArray(body.kinds)) {
        throw new FacilitatorError(`supported answered ${status}`);
      }
      return { kinds: body.kinds.filter(isObject) as unknown as SupportedKind[] };
    },
  };
}

/** The facilitator settles x402 v2 `exact` payments on the network, with fees sponsored as promised. */
export async function checkFacilitator(facilitator: Facilitator, network: StellarNetwork): Promise<void> {
  if (facilitator.supported === undefined) return;
  const { kinds } = await facilitator.supported();
  const kind = kinds.find((candidate) =>
    candidate.x402Version === 2 && candidate.scheme === 'exact' && candidate.network === network
  );
  if (kind === undefined) {
    throw new FacilitatorError(`the facilitator does not support x402 v2 "exact" on ${network}`);
  }
  if (kind.extra?.areFeesSponsored !== true) {
    throw new FacilitatorError(`the facilitator does not sponsor fees on ${network}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Settlement

export type Settlement =
  | { outcome: 'settled'; receipt: PaymentReceipt; response: SettleResponse }
  | { outcome: 'failed'; reason: string }
  /** `transaction`: a hash the facilitator named, which reconciliation checks first. */
  | { outcome: 'uncertain'; reason: string; transaction?: string };

/**
 * Reasons the @x402/stellar facilitator gives before it submits anything. Any reason starting with
 * "invalid_" is a verify failure too. A reason not listed is uncertain, so a facilitator with other
 * wording never makes the provider drop a payment that may have landed.
 */
const NOT_SUBMITTED: ReadonlySet<string> = new Set([
  'unsupported_scheme',
  'network_mismatch',
  'verification_failed',
  'unexpected_verify_error',
  'settle_exact_stellar_signer_selection_failed',
  'settle_exact_stellar_transaction_signing_failed',
  'settle_exact_stellar_fee_bump_signing_failed',
  // sendTransaction did not accept it (ERROR, TRY_AGAIN_LATER): it never reached a ledger.
  'settle_exact_stellar_transaction_submission_failed',
]);

export function neverSubmitted(reason: string): boolean {
  return reason.startsWith('invalid_') || NOT_SUBMITTED.has(reason);
}

const TRANSACTION_HASH = /^[0-9a-f]{64}$/;

/** Settles once. `payer` is the address the provider's own payment checks found. */
export async function settle(
  facilitator: Facilitator,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  payer: string,
): Promise<Settlement> {
  let response: SettleResponse;
  try {
    response = await facilitator.settle(payload, requirements);
  } catch (error) {
    return { outcome: 'uncertain', reason: error instanceof Error ? error.name : 'settlement error' };
  }

  const transaction = typeof response.transaction === 'string' ? response.transaction.toLowerCase() : '';
  const uncertain = (reason: string): Settlement =>
    TRANSACTION_HASH.test(transaction)
      ? { outcome: 'uncertain', reason, transaction }
      : { outcome: 'uncertain', reason };

  if (response.success === true) {
    if (!TRANSACTION_HASH.test(transaction)) return uncertain('settled without a transaction hash');
    if (response.payer !== undefined && response.payer !== payer) {
      return uncertain('the facilitator named another payer');
    }
    if (response.network !== requirements.network) return uncertain('the facilitator named another network');
    const receipt: PaymentReceipt = {
      network: requirements.network as StellarNetwork,
      asset: requirements.asset,
      amount: requirements.amount,
      payTo: requirements.payTo,
      payer,
      transaction,
      settledAt: new Date().toISOString(),
    };
    return { outcome: 'settled', receipt, response };
  }

  const reason = response.errorReason ?? 'settlement failed';
  if (transaction === '' && neverSubmitted(reason)) return { outcome: 'failed', reason };
  return uncertain(reason);
}
