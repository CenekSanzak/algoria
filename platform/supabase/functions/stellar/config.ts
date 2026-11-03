// Configuration of the Stellar provider, read once at startup. Everything that touches money fails
// closed: a missing or malformed setting stops the function before it can take a payment.
//
// Supabase secrets are shared by every function in the project, so this provider's settings carry a
// STELLAR_ prefix and never reuse the demo API's names (FACILITATOR_URL, PHONE_CALL_PAY_TO, ...).
// The provider holds no Stellar secret key: only its public payTo address [§12].

import { StrKey } from 'npm:@stellar/stellar-sdk@16.2.0';
import type { PhoneConfig } from '../api/config.ts';
import { DEFAULT_RETENTION_SECONDS, type StellarNetwork, USDC_ASSET } from './protocol.ts';

export interface StellarConfig {
  network: StellarNetwork;
  /** The USDC Stellar Asset Contract on `network`. */
  asset: string;
  /** Public G... address paid for every job. It must hold a USDC trustline [P2]. */
  payTo: string;
  /** Stellar 8004 agent id, once registered [I2]. */
  agentId?: number;
  /** Job endpoints live under it [M5]; the manifest is at `${baseUrl}/.well-known/stellar-agent-services.json`. */
  baseUrl: string;
  manifestUrl: string;
  facilitatorUrl: string;
  /** Sent with every facilitator call: OpenZeppelin's mainnet facilitator wants an API key. */
  facilitatorHeaders: Record<string, string>;
  /** Soroban RPC for reconciliation [J13] and the ledger clock. */
  rpcUrl: string;
  /** A call's price in USDC base units (7 decimals). */
  priceAmount: string;
  maxTimeoutSeconds: number;
  retentionSeconds: number;
  /** Calls placed at the same time. */
  concurrency: number;
  /** Calls to one number in 24 hours. */
  callsPerNumber: number;
  /** Bearer secret of /internal/sweep, which pg_cron calls every minute. */
  sweepSecret?: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  phone: PhoneConfig;
}

export const FACILITATORS: Readonly<Record<StellarNetwork, string>> = {
  'stellar:testnet': 'https://www.x402.org/facilitator',
  // Stellar's docs list OpenZeppelin's for mainnet; it wants an API key from channels.openzeppelin.com/gen.
  'stellar:pubnet': 'https://channels.openzeppelin.com/x402',
};

/** The RPC the Stellar 8004 SDK uses on mainnet. For production traffic, an RPC provider's is safer. */
export const RPC_URLS: Readonly<Record<StellarNetwork, string>> = {
  'stellar:testnet': 'https://soroban-testnet.stellar.org',
  'stellar:pubnet': 'https://mainnet.sorobanrpc.com',
};

/** "1.5" USDC -> "15000000" base units. USDC has 7 decimals on Stellar. */
export function usdcToBaseUnits(usdc: string): string {
  const match = /^(\d{1,12})(?:\.(\d{1,7}))?$/.exec(usdc.trim());
  if (!match) throw new Error('Invalid STELLAR_PHONE_PRICE_USDC');
  const units = BigInt(match[1]) * 10_000_000n + BigInt((match[2] ?? '').padEnd(7, '0'));
  if (units <= 0n) throw new Error('Invalid STELLAR_PHONE_PRICE_USDC');
  return units.toString();
}

function httpsUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an https:// URL without credentials, query or fragment`);
  }
  return url.toString().replace(/\/+$/, '');
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function parseNetwork(value: string | undefined): StellarNetwork {
  const network = value?.trim().toLowerCase();
  if (network === 'stellar:pubnet' || network === 'pubnet' || network === 'mainnet') return 'stellar:pubnet';
  if (network === 'stellar:testnet' || network === 'testnet') return 'stellar:testnet';
  // No default: a provider must say which network takes its payments.
  throw new Error('STELLAR_NETWORK must be stellar:pubnet (mainnet) or stellar:testnet');
}

export function readStellarConfig(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): StellarConfig {
  const required = (name: string) => {
    const value = env(name)?.trim();
    if (!value) throw new Error(`Missing configuration: ${name}`);
    return value;
  };
  const network = parseNetwork(env('STELLAR_NETWORK'));
  const payTo = required('STELLAR_PAY_TO');
  // A muxed M... address or a contract is not a payout account here [P11].
  if (!StrKey.isValidEd25519PublicKey(payTo)) throw new Error('STELLAR_PAY_TO must be a G... address');
  const agent = env('STELLAR_AGENT_ID')?.trim();
  const agentId = agent ? integer(agent, 0, 0, 4294967295, 'STELLAR_AGENT_ID') : undefined;

  const supabaseUrl = httpsUrl(required('SUPABASE_URL'), 'SUPABASE_URL');
  const baseUrl = httpsUrl(
    env('STELLAR_PUBLIC_BASE_URL') || `${supabaseUrl}/functions/v1/stellar`,
    'STELLAR_PUBLIC_BASE_URL',
  );
  const facilitatorUrl = httpsUrl(
    env('STELLAR_FACILITATOR_URL') || FACILITATORS[network],
    'STELLAR_FACILITATOR_URL',
  );
  const auth = env('STELLAR_FACILITATOR_AUTH')?.trim();
  if (!auth && new URL(facilitatorUrl).hostname === 'channels.openzeppelin.com') {
    throw new Error(
      'Missing configuration: STELLAR_FACILITATOR_AUTH ("Bearer <key>" from channels.openzeppelin.com/gen)',
    );
  }
  if (auth && /[\r\n]/.test(auth)) throw new Error('Invalid STELLAR_FACILITATOR_AUTH');

  const accountSid = required('TWILIO_ACCOUNT_SID');
  const authToken = required('TWILIO_AUTH_TOKEN');
  const from = required('TWILIO_FROM_NUMBER');
  if (!/^\+[1-9][0-9]{6,14}$/.test(from)) throw new Error('TWILIO_FROM_NUMBER must be E.164');
  const sweepSecret = env('STELLAR_SWEEP_SECRET')?.trim() || undefined;
  if (sweepSecret !== undefined && !/^[A-Za-z0-9_-]{43,128}$/.test(sweepSecret)) {
    throw new Error('Invalid STELLAR_SWEEP_SECRET');
  }

  return {
    network,
    asset: USDC_ASSET[network],
    payTo,
    ...(agentId === undefined ? {} : { agentId }),
    baseUrl,
    manifestUrl: `${baseUrl}/.well-known/stellar-agent-services.json`,
    facilitatorUrl,
    facilitatorHeaders: auth ? { Authorization: auth } : {},
    rpcUrl: httpsUrl(env('STELLAR_RPC_URL') || RPC_URLS[network], 'STELLAR_RPC_URL'),
    priceAmount: usdcToBaseUnits(env('STELLAR_PHONE_PRICE_USDC') || '1'),
    maxTimeoutSeconds: 60,
    retentionSeconds: DEFAULT_RETENTION_SECONDS,
    concurrency: integer(env('STELLAR_PHONE_CONCURRENCY'), 2, 1, 20, 'STELLAR_PHONE_CONCURRENCY'),
    callsPerNumber: integer(
      env('STELLAR_PHONE_CALLS_PER_NUMBER'),
      3,
      1,
      50,
      'STELLAR_PHONE_CALLS_PER_NUMBER',
    ),
    ...(sweepSecret === undefined ? {} : { sweepSecret }),
    supabaseUrl,
    // Same override as the demo API: a platform key change can leave the injected key unusable.
    serviceRoleKey: env('ALGORIA_SERVICE_ROLE_KEY') || required('SUPABASE_SERVICE_ROLE_KEY'),
    phone: {
      accountSid,
      authToken,
      from,
      openaiKey: required('OPENAI_API_KEY'),
      realtimeModel: env('PHONE_CALL_REALTIME_MODEL') || 'gpt-realtime-mini',
      voice: env('PHONE_CALL_VOICE') || 'marin',
      // Any number can be called here; the demo API's contact list does not apply.
      contacts: {},
    },
  };
}
