import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.3';

export type JobStatus =
  | 'awaiting_payment'
  | 'settling'
  | 'payment_uncertain'
  | 'paid'
  | 'submitting'
  | 'queued'
  | 'running'
  | 'saving'
  | 'succeeded'
  | 'failed';

export type Job = {
  id: string;
  service_id: string;
  service_version: string;
  input: { prompt: string };
  input_hash: string;
  recovery_token_hash: string;
  requirements: Record<string, unknown>;
  resource_url: string;
  status: JobStatus;
  payer: string | null;
  payment_receipt: Record<string, unknown> | null;
  provider_request_id: string | null;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
};

export type NewJob = Pick<
  Job,
  | 'id'
  | 'service_id'
  | 'service_version'
  | 'input'
  | 'input_hash'
  | 'recovery_token_hash'
  | 'requirements'
  | 'resource_url'
  | 'expires_at'
>;

export type Capacity = {
  available: boolean;
  totalUsed: number;
  active: number;
  maxTotal: number;
  maxConcurrent: number;
};

export type ClaimResult = { claimed: boolean; reason?: string; job: Job };
export type CompletionClaim = {
  claimed: boolean;
  leaseToken?: string;
  job: Job;
};

const JOB_COLUMNS = [
  'id',
  'service_id',
  'service_version',
  'input',
  'input_hash',
  'recovery_token_hash',
  'requirements',
  'resource_url',
  'status',
  'payer',
  'payment_receipt',
  'provider_request_id',
  'output',
  'error',
  'created_at',
  'expires_at',
  'updated_at',
].join(',');

type DatabaseError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

function databaseError(error: DatabaseError): Error {
  return Object.assign(new Error(error.message), {
    code: error.code,
    details: error.details,
    hint: error.hint,
  });
}

/** Service-role repository. All state transitions happen in atomic SQL RPCs. */
export class Store {
  private readonly client: SupabaseClient;

  constructor(url: string, key: string) {
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  private async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw databaseError(error);
    if (data === null) throw new Error(`${name} returned no result`);
    return data as T;
  }

  async get(id: string): Promise<Job | null> {
    const { data, error } = await this.client.from('jobs').select(JOB_COLUMNS)
      .eq('id', id).maybeSingle();
    if (error) throw databaseError(error);
    return data as unknown as Job | null;
  }

  async getByProviderId(id: string): Promise<Job | null> {
    const { data, error } = await this.client.from('jobs').select(JOB_COLUMNS)
      .eq('provider_request_id', id).maybeSingle();
    if (error) throw databaseError(error);
    return data as unknown as Job | null;
  }

  create(candidate: NewJob): Promise<{ job: Job; created: boolean }> {
    return this.rpc('platform_create_job', { candidate });
  }

  capacity(): Promise<Capacity> {
    return this.rpc('platform_capacity');
  }

  claimPayment(
    id: string,
    fingerprint: string,
    payer: string,
    payload: Record<string, unknown>,
  ): Promise<ClaimResult> {
    return this.rpc('platform_claim_payment', {
      job_id: id,
      payment_fingerprint: fingerprint,
      payment_payer: payer,
      payment_payload: payload,
    });
  }

  finishPayment(
    id: string,
    outcome: 'success' | 'failed' | 'uncertain',
    receipt: Record<string, unknown>,
  ): Promise<Job> {
    return this.rpc('platform_finish_payment', { job_id: id, outcome, receipt });
  }

  claimSubmission(id: string): Promise<ClaimResult> {
    return this.rpc('platform_claim_submission', { job_id: id });
  }

  setSubmitted(id: string, providerId: string): Promise<Job> {
    return this.rpc('platform_set_submitted', { job_id: id, provider_id: providerId });
  }

  failJob(id: string, code: string, message: string): Promise<Job> {
    return this.rpc('platform_fail_job', {
      job_id: id,
      error_code: code,
      error_message: message,
    });
  }

  claimCompletion(id: string): Promise<CompletionClaim> {
    return this.rpc('platform_claim_completion', { job_id: id });
  }

  complete(id: string, leaseToken: string, output: Record<string, unknown>): Promise<Job> {
    return this.rpc('platform_complete_job', {
      job_id: id,
      lease_token: leaseToken,
      job_output: output,
    });
  }

  releaseCompletion(id: string, leaseToken: string): Promise<Job> {
    return this.rpc('platform_release_completion', { job_id: id, lease_token: leaseToken });
  }

  markRunning(id: string): Promise<Job> {
    return this.rpc('platform_mark_running', { job_id: id });
  }

  recordWebhook(eventKey: string, providerId: string): Promise<boolean> {
    return this.rpc('platform_record_webhook', {
      event_key: eventKey,
      provider_id: providerId,
    });
  }
}
