// Test support for the Stellar provider: the real migration on PostgreSQL WASM, offline x402
// payments, and fake Twilio, facilitator and chain. No network, no keys, no money.

import { Buffer } from 'node:buffer';
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from 'npm:@stellar/stellar-sdk@16.2.0';
import { encodePaymentSignatureHeader } from 'npm:@x402/core@2.22.0/http';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from 'npm:@x402/core@2.22.0/types';
import type { CallPatch, CallRepository, CallRow } from '../api/phone.ts';
import { TwilioError } from '../api/phone.ts';
import type { StellarConfig } from './config.ts';
import type { Directory } from './phone.ts';
import { USDC_ASSET } from './protocol.ts';
import { SqlJobStore, type StellarJob } from './store.ts';
import type { Facilitator, VerifyResult } from './x402.ts';

export const PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
export const PAY_TO = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
export const ASSET = USDC_ASSET['stellar:pubnet'];
export const BASE_URL = 'https://ref.supabase.co/functions/v1/stellar';

export const CONFIG: StellarConfig = {
  network: 'stellar:pubnet',
  asset: ASSET,
  payTo: PAY_TO,
  agentId: 7,
  baseUrl: BASE_URL,
  manifestUrl: `${BASE_URL}/.well-known/stellar-agent-services.json`,
  facilitatorUrl: 'https://channels.openzeppelin.com/x402',
  facilitatorHeaders: { Authorization: 'Bearer test' },
  rpcUrl: 'https://rpc.example',
  priceAmount: '10000000',
  maxTimeoutSeconds: 60,
  retentionSeconds: 86400,
  concurrency: 2,
  callsPerNumber: 3,
  sweepSecret: 's'.repeat(43),
  supabaseUrl: 'https://ref.supabase.co',
  serviceRoleKey: 'service-role',
  phone: {
    accountSid: 'AC00000000000000000000000000000000',
    authToken: 'twilio-test-token',
    from: '+15550001111',
    openaiKey: 'sk-test',
    realtimeModel: 'gpt-realtime-mini',
    voice: 'marin',
    contacts: {},
  },
};

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value;

function normalize(row: Record<string, unknown> | undefined): StellarJob | null {
  if (!row) return null;
  const job = { ...row } as Record<string, unknown>;
  for (const key of ['created_at', 'updated_at', 'finished_at', 'settling_since', 'checked_at']) {
    job[key] = iso(job[key]);
  }
  job.expiration_ledger = Number(job.expiration_ledger);
  return job as unknown as StellarJob;
}

/** The real migration on PGlite, behind the same store class production uses. */
export async function database() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(
    await Deno.readTextFile(new URL('../../migrations/202611020001_stellar_services.sql', import.meta.url)),
  );
  const store = new SqlJobStore(
    async <T>(name: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      const result = await db.query<{ r: T }>(
        `select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) as r`,
        keys.map((key) => args[key]),
      );
      return result.rows[0].r;
    },
    async (filter, limit, olderThan) => {
      const result = filter === 'uncertain'
        ? await db.query<Record<string, unknown>>(
          `select * from public.stellar_jobs where status = 'payment_uncertain'
             and (checked_at is null or checked_at < $1) order by created_at limit $2`,
          [olderThan, limit],
        )
        : await db.query<Record<string, unknown>>(
          `select * from public.stellar_jobs where status in ('queued', 'running') and created_at < $1
             order by created_at limit $2`,
          [olderThan, limit],
        );
      return result.rows.map((row) => normalize(row)!);
    },
    async (jobId) =>
      normalize(
        (await db.query<Record<string, unknown>>('select * from public.stellar_jobs where job_id = $1', [
          jobId,
        ]))
          .rows[0],
      ),
  );
  const calls: CallRepository = {
    note: () => Promise.resolve(),
    get: async (jobId) => {
      const row =
        (await db.query<CallRow>('select * from public.stellar_phone_calls where job_id = $1', [jobId]))
          .rows[0];
      if (!row) return null;
      return {
        ...row,
        ended_at: iso(row.ended_at) as string | null,
        created_at: iso(row.created_at) as string,
        updated_at: iso(row.updated_at) as string,
      };
    },
    create: async (jobId) => {
      await db.query('insert into public.stellar_phone_calls (job_id) values ($1) on conflict do nothing', [
        jobId,
      ]);
    },
    update: async (jobId, patch: CallPatch) => {
      const entries = Object.entries(patch);
      await db.query(
        `update public.stellar_phone_calls set ${
          entries.map(([key], i) => `${key} = $${i + 2}`).join(', ')
        }, updated_at = now() where job_id = $1`,
        [jobId, ...entries.map(([, value]) => key(value))],
      );
    },
  };
  function key(value: unknown) {
    return Array.isArray(value) ? JSON.stringify(value) : value;
  }
  /** Moves a job's clock back, for deadlines. */
  async function age(jobId: string, seconds: number) {
    await db.exec(
      `alter table public.stellar_jobs disable trigger stellar_jobs_guard;
       update public.stellar_jobs set created_at = created_at - make_interval(secs => ${seconds}) where job_id = '${jobId}';
       alter table public.stellar_jobs enable trigger stellar_jobs_guard;`.replace(/\n\s+/g, ' '),
    );
  }
  return { db, store, calls, age };
}

/** An x402 `exact` payment for USDC on pubnet, signed offline; the fake facilitator checks it. */
export function payment(
  requirements: PaymentRequirements,
  options: { nonce?: string; amount?: string; payTo?: string; expiration?: number } = {},
): { payload: PaymentPayload; header: string; transaction: Transaction } {
  const args = [
    nativeToScVal(PAYER.publicKey(), { type: 'address' }),
    nativeToScVal(options.payTo ?? requirements.payTo, { type: 'address' }),
    nativeToScVal(options.amount ?? requirements.amount, { type: 'i128' }),
  ];
  const invocation = new xdr.InvokeContractArgs({
    contractAddress: new Address(requirements.asset).toScAddress(),
    functionName: 'transfer',
    args,
  });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(PAYER.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString(options.nonce ?? '424242'),
        signatureExpirationLedger: options.expiration ?? 1000,
        signature: nativeToScVal('fixture-signature'),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invocation),
      subInvocations: [],
    }),
  });
  const transaction = new TransactionBuilder(new Account(PAYER.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: requirements.asset,
        function: 'transfer',
        args,
        auth: [auth],
      }),
    )
    .setTimeout(60)
    .build();
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: transaction.toXDR() },
  };
  return { payload, header: encodePaymentSignatureHeader(payload), transaction };
}

export const TX_HASH = 'b'.repeat(64);

/** A facilitator that answers as told and records what it was asked. */
export function facilitator(
  settle: () => Promise<SettleResponse> = () =>
    Promise.resolve({
      success: true,
      transaction: TX_HASH,
      network: 'stellar:pubnet',
      payer: PAYER.publicKey(),
    }),
) {
  const calls = { verify: 0, settle: 0 };
  const fake: Facilitator & { calls: typeof calls; verifyResult: VerifyResult } = {
    calls,
    verifyResult: { isValid: true, payer: PAYER.publicKey() },
    verify() {
      calls.verify++;
      return Promise.resolve(fake.verifyResult);
    },
    settle() {
      calls.settle++;
      return settle();
    },
    supported: () =>
      Promise.resolve({
        kinds: [{
          x402Version: 2,
          scheme: 'exact',
          network: 'stellar:pubnet',
          extra: { areFeesSponsored: true },
        }],
      }),
  };
  return fake;
}

/** Twilio's call API, recorded. `reject` makes the next dial fail as Twilio would. */
export function twilio() {
  const placed: { to: string; url: string; statusCallback: string }[] = [];
  const hungUp: string[] = [];
  let reject: TwilioError | undefined;
  return {
    placed,
    hungUp,
    rejectNext(code: number) {
      reject = new TwilioError('The number is not allowed.', true, code);
    },
    placeCall(options: { to: string; url: string; statusCallback: string }) {
      if (reject) {
        const error = reject;
        reject = undefined;
        return Promise.reject(error);
      }
      placed.push(options);
      return Promise.resolve(`CA${String(placed.length).padStart(32, '0')}`);
    },
    hangup(sid: string) {
      hungUp.push(sid);
      return Promise.resolve();
    },
  };
}

export function directory(overrides: Partial<Directory> = {}): Directory {
  return {
    accountType: () => Promise.resolve('Full'),
    countryEnabled: () => Promise.resolve(true),
    verified: () => Promise.resolve(true),
    ...overrides,
  };
}

/** The ledger of a fake chain that saw `transaction` succeed, or nothing at all. */
export function chain(
  options: { latest: number; transaction?: Transaction; amount?: string; payTo?: string },
) {
  const events = options.transaction
    ? [
      new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: StrKey.decodeContract(ASSET) as unknown as xdr.Hash,
        type: xdr.ContractEventType.contract(),
        body: new xdr.ContractEventBody(
          0,
          new xdr.ContractEventV0({
            topics: [
              xdr.ScVal.scvSymbol('transfer'),
              nativeToScVal(PAYER.publicKey(), { type: 'address' }),
              nativeToScVal(options.payTo ?? PAY_TO, { type: 'address' }),
              nativeToScVal('USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
            ],
            data: nativeToScVal(options.amount ?? '10000000', { type: 'i128' }),
          }),
        ),
      }),
    ]
    : [];
  return {
    getLatestLedger: () => Promise.resolve({ id: 'x', sequence: options.latest, protocolVersion: 23 }),
    getHealth: () =>
      Promise.resolve({
        status: 'healthy',
        latestLedger: options.latest,
        oldestLedger: 1,
        ledgerRetentionWindow: 17280,
      }),
    getEvents: () =>
      Promise.resolve({
        latestLedger: options.latest,
        events: options.transaction ? [{ ledger: 900, txHash: TX_HASH }] : [],
        cursor: '',
      }),
    getTransaction: (hash: string) =>
      Promise.resolve(
        options.transaction && hash === TX_HASH
          ? {
            status: 'SUCCESS',
            envelopeXdr: options.transaction.toEnvelope(),
            events: { contractEventsXdr: [events] },
            createdAt: 1_793_000_000,
          }
          : { status: 'NOT_FOUND' },
      ),
  } as unknown as import('./onchain.ts').ChainReader;
}
