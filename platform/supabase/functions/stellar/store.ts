// The provider's job store: public.stellar_jobs, through the SQL functions in
// migrations/202611020001_stellar_services.sql. Every state change is one atomic statement there, so
// any isolate of the Edge Function can serve any request for a job.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';
import type { JobFailureCode, JsonObject, PaymentReceipt, Problem, StellarNetwork } from './protocol.ts';

/** "pending" is internal: claimed, settlement in flight. Requests for it get 409 request_in_progress [J7]. */
export type StoredStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'payment_uncertain';

export type StellarJob = {
  job_id: string;
  service: string;
  charge: 'upfront';
  binding_hash: string;
  token_hash: string;
  status: StoredStatus;
  network: StellarNetwork;
  payer: string;
  nonce: string;
  expiration_ledger: number;
  fingerprint: string;
  destination_hash: string | null;
  input: JsonObject | null;
  output: JsonObject | null;
  error: Problem<JobFailureCode> | null;
  payment: PaymentReceipt | null;
  settlement: { reason?: string; transaction?: string; last_check?: string } | null;
  settling_since: string | null;
  checked_at: string | null;
  dial_state: 'none' | 'dialing' | 'dialed' | 'unknown';
  call_sid: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type NewJob = Pick<
  StellarJob,
  | 'job_id'
  | 'service'
  | 'charge'
  | 'binding_hash'
  | 'token_hash'
  | 'network'
  | 'payer'
  | 'nonce'
  | 'expiration_ledger'
  | 'fingerprint'
  | 'destination_hash'
  | 'input'
>;

export type Admission = 'ok' | 'busy' | 'opted_out' | 'number_busy' | 'number_limited';

export type ClaimResult =
  | { outcome: 'created' | 'existing'; job: StellarJob }
  | { outcome: 'conflict' | 'payment_used' | Exclude<Admission, 'ok'> };

export type SettlementRecord =
  | { outcome: 'settled'; receipt: PaymentReceipt }
  | { outcome: 'failed'; error: Problem<JobFailureCode>; reason: string }
  | { outcome: 'uncertain'; reason: string; transaction?: string };

export interface Limits {
  maxActive: number;
  maxPerNumber: number;
}

export interface JobStore {
  get(jobId: string): Promise<StellarJob | null>;
  admission(service: string, numberHash: string | null, limits: Limits): Promise<Admission>;
  claim(job: NewJob, limits: Limits): Promise<ClaimResult>;
  /** Null when the job was no longer waiting for this answer. */
  settlement(jobId: string, record: SettlementRecord): Promise<StellarJob | null>;
  checked(jobId: string, reason: string): Promise<void>;
  startDial(jobId: string): Promise<{ claimed: boolean; job: StellarJob }>;
  dialed(jobId: string, callSid: string | null): Promise<StellarJob>;
  fail(jobId: string, error: Problem<JobFailureCode>): Promise<StellarJob>;
  claimCompletion(jobId: string): Promise<{ claimed: boolean; lease?: string; job: StellarJob }>;
  complete(jobId: string, lease: string, output: JsonObject): Promise<StellarJob>;
  releaseCompletion(jobId: string, lease: string): Promise<StellarJob>;
  optOut(jobId: string): Promise<boolean>;
  sweep(
    retentionSeconds: number,
    settleTimeoutSeconds: number,
  ): Promise<{ uncertain: number; deleted: number }>;
  /** Uncertain jobs not looked at for `quietSeconds`, oldest first. */
  uncertain(limit: number, quietSeconds: number): Promise<StellarJob[]>;
  /** Paid jobs older than `ageSeconds` still queued or running: a dial or a call end nobody moved on. */
  stale(limit: number, ageSeconds: number): Promise<StellarJob[]>;
}

/** Calls the SQL functions by name with positional arguments: PostgREST here, PGlite in tests. */
export type Rpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
export type Select = (
  filter: 'uncertain' | 'stale',
  limit: number,
  olderThan: string,
) => Promise<StellarJob[]>;

export class SqlJobStore implements JobStore {
  constructor(
    private readonly rpc: Rpc,
    private readonly select: Select,
    private readonly read: (jobId: string) => Promise<StellarJob | null>,
  ) {}

  get(jobId: string) {
    return this.read(jobId);
  }

  admission(service: string, numberHash: string | null, limits: Limits) {
    return this.rpc<Admission>('stellar_admission', {
      service_name: service,
      number_hash: numberHash,
      max_active: limits.maxActive,
      max_per_number: limits.maxPerNumber,
    });
  }

  claim(job: NewJob, limits: Limits) {
    return this.rpc<ClaimResult>('stellar_claim_job', {
      candidate: job,
      max_active: limits.maxActive,
      max_per_number: limits.maxPerNumber,
    });
  }

  settlement(jobId: string, record: SettlementRecord) {
    return this.rpc<StellarJob | null>('stellar_settlement', {
      job: jobId,
      outcome: record.outcome,
      receipt: record.outcome === 'settled' ? record.receipt : null,
      failure: record.outcome === 'failed' ? record.error : null,
      detail: record.outcome === 'settled' ? null : {
        reason: record.reason,
        ...(record.outcome === 'uncertain' && record.transaction ? { transaction: record.transaction } : {}),
      },
    });
  }

  async checked(jobId: string, reason: string) {
    await this.rpc<null>('stellar_checked', { job: jobId, detail: { last_check: reason.slice(0, 300) } });
  }

  startDial(jobId: string) {
    return this.rpc<{ claimed: boolean; job: StellarJob }>('stellar_start_dial', { job: jobId });
  }

  dialed(jobId: string, callSid: string | null) {
    return this.rpc<StellarJob>('stellar_dialed', { job: jobId, sid: callSid, known: callSid !== null });
  }

  fail(jobId: string, error: Problem<JobFailureCode>) {
    return this.rpc<StellarJob>('stellar_fail', { job: jobId, failure: error });
  }

  claimCompletion(jobId: string) {
    return this.rpc<{ claimed: boolean; lease?: string; job: StellarJob }>('stellar_claim_completion', {
      job: jobId,
    });
  }

  complete(jobId: string, lease: string, output: JsonObject) {
    return this.rpc<StellarJob>('stellar_complete', { job: jobId, lease, result: output });
  }

  releaseCompletion(jobId: string, lease: string) {
    return this.rpc<StellarJob>('stellar_release_completion', { job: jobId, lease });
  }

  optOut(jobId: string) {
    return this.rpc<boolean>('stellar_opt_out', { job: jobId });
  }

  sweep(retentionSeconds: number, settleTimeoutSeconds: number) {
    return this.rpc<{ uncertain: number; deleted: number }>('stellar_sweep', {
      retention_seconds: retentionSeconds,
      settle_timeout_seconds: settleTimeoutSeconds,
    });
  }

  uncertain(limit: number, quietSeconds: number) {
    return this.select('uncertain', limit, new Date(Date.now() - quietSeconds * 1000).toISOString());
  }

  stale(limit: number, ageSeconds: number) {
    return this.select('stale', limit, new Date(Date.now() - ageSeconds * 1000).toISOString());
  }
}

const COLUMNS = [
  'job_id',
  'service',
  'charge',
  'binding_hash',
  'token_hash',
  'status',
  'network',
  'payer',
  'nonce',
  'expiration_ledger',
  'fingerprint',
  'destination_hash',
  'input',
  'output',
  'error',
  'payment',
  'settlement',
  'settling_since',
  'checked_at',
  'dial_state',
  'call_sid',
  'created_at',
  'updated_at',
  'finished_at',
].join(',');

/** The store over PostgREST with the service-role key. */
export function supabaseJobStore(url: string, serviceRoleKey: string): JobStore {
  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const fail = (error: { message: string; code?: string }) =>
    Object.assign(new Error(error.message), { code: error.code });
  return new SqlJobStore(
    async <T>(name: string, args: Record<string, unknown>) => {
      const { data, error } = await client.rpc(name, args);
      if (error) throw fail(error);
      return data as T;
    },
    async (filter, limit, olderThan) => {
      let query = client.from('stellar_jobs').select(COLUMNS);
      query = filter === 'uncertain'
        ? query.eq('status', 'payment_uncertain').or(`checked_at.is.null,checked_at.lt."${olderThan}"`)
        : query.in('status', ['queued', 'running']).lt('created_at', olderThan);
      const { data, error } = await query.order('created_at', { ascending: true }).limit(limit);
      if (error) throw fail(error);
      return (data ?? []) as unknown as StellarJob[];
    },
    async (jobId) => {
      const { data, error } = await client.from('stellar_jobs').select(COLUMNS).eq('job_id', jobId)
        .maybeSingle();
      if (error) throw fail(error);
      return data as unknown as StellarJob | null;
    },
  );
}
