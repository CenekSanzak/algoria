-- Stellar Agent Services provider (Provider Standard v1, stellar-agent-services/provider@1).
--
-- Jobs of the `stellar` Edge Function, which sells AI phone calls for USDC on Stellar. They live apart
-- from the demo tables (public.jobs): no demo cap, the standard's job states, and its own admission
-- limits. Only service_role reaches them, through the functions below. Rule ids such as [J4] refer to
-- docs/provider-standard.md in AlgoriaLabs/stellar-agent-services.
--
-- Money rules:
-- - A job id is bound forever to one binding hash and one sha256(Job-Token) [J4]. One payment (the
--   payer's auth-entry nonce) buys at most one job [P9]. Both are claimed in the same statement.
-- - An upfront job is `pending` while its settlement is in flight. A settlement nobody can decide is
--   `payment_uncertain`, decided later from the chain and never charged again [J13].
-- - succeeded and failed are final [J12]: the input is dropped, the output stays until retention ends.

create table public.stellar_jobs (
  job_id uuid primary key,
  service text not null check (service ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  charge text not null check (charge = 'upfront'),
  binding_hash text not null check (binding_hash ~ '^[0-9a-f]{64}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('pending', 'queued', 'running', 'succeeded', 'failed', 'payment_uncertain')),
  network text not null check (network in ('stellar:testnet', 'stellar:pubnet')),
  payer text not null check (payer ~ '^[GC][A-Z2-7]{55}$'),
  nonce text not null check (nonce ~ '^-?[0-9]{1,20}$'),
  expiration_ledger bigint not null check (expiration_ledger > 0),
  fingerprint text not null unique check (fingerprint ~ '^[0-9a-f]{64}$'),
  -- sha256 of the dialed number with a fixed prefix: admission limits and opt-outs, not the number.
  destination_hash text check (destination_hash is null or destination_hash ~ '^[0-9a-f]{64}$'),
  input jsonb check (input is null or jsonb_typeof(input) = 'object'),
  output jsonb check (output is null or jsonb_typeof(output) = 'object'),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  payment jsonb check (payment is null or jsonb_typeof(payment) = 'object'),
  settlement jsonb check (settlement is null or jsonb_typeof(settlement) = 'object'),
  settling_since timestamptz,
  checked_at timestamptz,
  dial_state text not null default 'none' check (dial_state in ('none', 'dialing', 'dialed', 'unknown')),
  call_sid text unique check (call_sid is null or length(call_sid) between 1 and 64),
  completion_lease uuid,
  completion_lease_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((status = 'pending') = (settling_since is not null)),
  check (status not in ('succeeded', 'failed') or (finished_at is not null and input is null))
);
create index stellar_jobs_active_idx on public.stellar_jobs (service, status)
  where status in ('pending', 'queued', 'running');
create index stellar_jobs_destination_idx on public.stellar_jobs (destination_hash, created_at)
  where destination_hash is not null;
create index stellar_jobs_sweep_idx on public.stellar_jobs (status, created_at);
create index stellar_jobs_finished_idx on public.stellar_jobs (finished_at) where finished_at is not null;

-- Live state of a phone-call job, written by Twilio callbacks and the voice bridge.
create table public.stellar_phone_calls (
  job_id uuid primary key references public.stellar_jobs (job_id) on delete cascade,
  call_sid text unique check (call_sid is null or length(call_sid) between 1 and 64),
  call_status text not null default 'queued' check (length(call_status) between 1 and 32),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  transcript jsonb not null default '[]' check (jsonb_typeof(transcript) = 'array'),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Numbers whose owner asked, on a call, not to be called again. Checked before any payment.
create table public.stellar_phone_optouts (
  destination_hash text primary key check (destination_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.stellar_jobs enable row level security;
alter table public.stellar_jobs force row level security;
alter table public.stellar_phone_calls enable row level security;
alter table public.stellar_phone_calls force row level security;
alter table public.stellar_phone_optouts enable row level security;
alter table public.stellar_phone_optouts force row level security;
revoke all on public.stellar_jobs, public.stellar_phone_calls, public.stellar_phone_optouts
  from public, anon, authenticated;
grant select on public.stellar_jobs to service_role;
grant select, insert, update on public.stellar_phone_calls to service_role;
grant select on public.stellar_phone_optouts to service_role;
create policy stellar_jobs_service_role on public.stellar_jobs for all to service_role using (true) with check (true);
create policy stellar_phone_calls_service_role on public.stellar_phone_calls for all to service_role
  using (true) with check (true);
create policy stellar_phone_optouts_service_role on public.stellar_phone_optouts for all to service_role
  using (true) with check (true);

-- The job's identity never changes, only the standard's transitions happen (§5.6), and a final job
-- is never changed again [J12].
create function public.stellar_job_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if row(new.job_id, new.service, new.charge, new.binding_hash, new.token_hash, new.network, new.payer,
    new.nonce, new.expiration_ledger, new.fingerprint, new.destination_hash, new.created_at)
    is distinct from row(old.job_id, old.service, old.charge, old.binding_hash, old.token_hash, old.network,
    old.payer, old.nonce, old.expiration_ledger, old.fingerprint, old.destination_hash, old.created_at) then
    raise exception 'stellar-job-identity-immutable' using errcode = '23514';
  end if;
  if old.status in ('succeeded', 'failed') then
    raise exception 'stellar-job-final' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'pending' and new.status in ('queued', 'failed', 'payment_uncertain')) or
    (old.status = 'queued' and new.status = 'running') or
    (old.status = 'running' and new.status in ('succeeded', 'failed')) or
    (old.status = 'payment_uncertain' and new.status in ('queued', 'succeeded', 'failed'))
  ) then
    raise exception 'stellar-job-transition-forbidden' using errcode = '23514';
  end if;
  new.updated_at := clock_timestamp();
  if new.status <> 'pending' then new.settling_since := null; end if;
  if new.status in ('succeeded', 'failed') then
    new.input := null;
    new.completion_lease := null;
    new.completion_lease_until := null;
    new.finished_at := coalesce(new.finished_at, clock_timestamp());
    if new.status = 'failed' then new.output := null; end if;
  end if;
  return new;
end;
$$;
create trigger stellar_jobs_guard before update on public.stellar_jobs
for each row execute function public.stellar_job_guard();

-- Admission before the 402 (§5.8): nobody signs a payment for a call that can't be placed now.
create function public.stellar_admission(
  service_name text, number_hash text, max_active integer, max_per_number integer
) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if number_hash is not null then
    if exists (select 1 from public.stellar_phone_optouts where destination_hash = number_hash) then
      return 'opted_out';
    end if;
    if exists (select 1 from public.stellar_jobs where destination_hash = number_hash
      and status in ('pending', 'queued', 'running')) then
      return 'number_busy';
    end if;
    if (select count(*) from public.stellar_jobs where destination_hash = number_hash
      and created_at > clock_timestamp() - interval '24 hours'
      and not (status = 'failed' and error->>'code' = 'payment_failed')) >= max_per_number then
      return 'number_limited';
    end if;
  end if;
  if (select count(*) from public.stellar_jobs where service = service_name
    and status in ('pending', 'queued', 'running')) >= max_active then
    return 'busy';
  end if;
  return 'ok';
end;
$$;

-- Step 8 of create-job (§5.4): claims the job id and the payment together, under the service's lock,
-- with admission checked again for the paid request [Q3].
create function public.stellar_claim_job(candidate jsonb, max_active integer, max_per_number integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  found_job public.stellar_jobs;
  admission text;
begin
  perform pg_advisory_xact_lock(hashtext('stellar_jobs:' || (candidate->>'service')));
  select * into found_job from public.stellar_jobs where job_id = (candidate->>'job_id')::uuid;
  if found then
    if found_job.binding_hash = candidate->>'binding_hash' and found_job.token_hash = candidate->>'token_hash' then
      return jsonb_build_object('outcome', 'existing', 'job', to_jsonb(found_job));
    end if;
    return jsonb_build_object('outcome', 'conflict');
  end if;
  if exists (select 1 from public.stellar_jobs where fingerprint = candidate->>'fingerprint') then
    return jsonb_build_object('outcome', 'payment_used');
  end if;
  admission := public.stellar_admission(candidate->>'service', candidate->>'destination_hash',
    max_active, max_per_number);
  if admission <> 'ok' then
    return jsonb_build_object('outcome', admission);
  end if;
  begin
    insert into public.stellar_jobs (job_id, service, charge, binding_hash, token_hash, status, network,
      payer, nonce, expiration_ledger, fingerprint, destination_hash, input, settling_since)
    values ((candidate->>'job_id')::uuid, candidate->>'service', candidate->>'charge',
      candidate->>'binding_hash', candidate->>'token_hash', 'pending', candidate->>'network',
      candidate->>'payer', candidate->>'nonce', (candidate->>'expiration_ledger')::bigint,
      candidate->>'fingerprint', candidate->>'destination_hash', candidate->'input', clock_timestamp())
    returning * into found_job;
  exception when unique_violation then
    -- Another service's lock let the same payment through first.
    return jsonb_build_object('outcome', 'payment_used');
  end;
  return jsonb_build_object('outcome', 'created', 'job', to_jsonb(found_job));
end;
$$;

-- Records a settlement answer, or a reconciliation decision, for a pending or uncertain job.
-- 'settled' -> queued with its receipt, 'failed' -> failed uncharged (payment_failed),
-- 'uncertain' -> payment_uncertain. Returns null when the job was no longer waiting for it.
create function public.stellar_settlement(
  job uuid, outcome text, receipt jsonb, failure jsonb, detail jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.stellar_jobs;
begin
  if outcome = 'settled' then
    update public.stellar_jobs set status = 'queued', payment = receipt, settlement = null
      where job_id = job and status in ('pending', 'payment_uncertain') returning * into found_job;
  elsif outcome = 'failed' then
    update public.stellar_jobs set status = 'failed', error = failure, settlement = detail
      where job_id = job and status in ('pending', 'payment_uncertain') returning * into found_job;
  elsif outcome = 'uncertain' then
    update public.stellar_jobs set status = 'payment_uncertain', settlement = detail
      where job_id = job and status = 'pending' returning * into found_job;
  else
    raise exception 'stellar-settlement-outcome' using errcode = '22023';
  end if;
  if not found then return null; end if;
  return to_jsonb(found_job);
end;
$$;

-- Notes that reconciliation looked at an uncertain job, so the next look waits a little.
create function public.stellar_checked(job uuid, detail jsonb) returns void
language sql security definer set search_path = '' as $$
  update public.stellar_jobs set checked_at = clock_timestamp(),
    settlement = coalesce(settlement, '{}'::jsonb) || coalesce(detail, '{}'::jsonb)
  where job_id = job and status = 'payment_uncertain';
$$;

-- A paid job starts its work: queued -> running, and the right to dial, once.
create function public.stellar_start_dial(job uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.stellar_jobs;
begin
  update public.stellar_jobs set status = 'running', dial_state = 'dialing'
    where job_id = job and status = 'queued' and dial_state = 'none' returning * into found_job;
  if found then return jsonb_build_object('claimed', true, 'job', to_jsonb(found_job)); end if;
  select * into found_job from public.stellar_jobs where job_id = job;
  return jsonb_build_object('claimed', false, 'job', to_jsonb(found_job));
end;
$$;

-- Twilio answered the dial: with the call's SID, or with no usable answer (`known` false). A dial
-- whose answer was lost is never repeated: the call may be ringing.
create function public.stellar_dialed(job uuid, sid text, known boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.stellar_jobs;
begin
  update public.stellar_jobs set dial_state = case when known then 'dialed' else 'unknown' end,
    call_sid = case when known then sid else call_sid end
    where job_id = job and status = 'running' and dial_state = 'dialing' returning * into found_job;
  if not found then select * into found_job from public.stellar_jobs where job_id = job; end if;
  return to_jsonb(found_job);
end;
$$;

create function public.stellar_fail(job uuid, failure jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.stellar_jobs;
begin
  update public.stellar_jobs set status = 'failed', error = failure
    where job_id = job and status = 'running' returning * into found_job;
  if not found then select * into found_job from public.stellar_jobs where job_id = job; end if;
  return to_jsonb(found_job);
end;
$$;

-- One writer finishes a call: a short lease, so a crashed writer is taken over.
create function public.stellar_claim_completion(job uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  found_job public.stellar_jobs;
  lease uuid := gen_random_uuid();
begin
  update public.stellar_jobs set completion_lease = lease,
    completion_lease_until = clock_timestamp() + interval '60 seconds'
    where job_id = job and status = 'running'
      and (completion_lease is null or completion_lease_until < clock_timestamp())
    returning * into found_job;
  if found then
    return jsonb_build_object('claimed', true, 'lease', lease, 'job', to_jsonb(found_job));
  end if;
  select * into found_job from public.stellar_jobs where job_id = job;
  return jsonb_build_object('claimed', false, 'job', to_jsonb(found_job));
end;
$$;

create function public.stellar_complete(job uuid, lease uuid, result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.stellar_jobs;
begin
  update public.stellar_jobs set status = 'succeeded', output = result
    where job_id = job and status = 'running' and completion_lease = lease returning * into found_job;
  if not found then select * into found_job from public.stellar_jobs where job_id = job; end if;
  return to_jsonb(found_job);
end;
$$;

create function public.stellar_release_completion(job uuid, lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.stellar_jobs;
begin
  update public.stellar_jobs set completion_lease = null, completion_lease_until = null
    where job_id = job and status = 'running' and completion_lease = lease returning * into found_job;
  if not found then select * into found_job from public.stellar_jobs where job_id = job; end if;
  return to_jsonb(found_job);
end;
$$;

-- The callee asked on the call not to be called again.
create function public.stellar_opt_out(job uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare number_hash text;
begin
  select destination_hash into number_hash from public.stellar_jobs where job_id = job;
  if number_hash is null then return false; end if;
  insert into public.stellar_phone_optouts (destination_hash) values (number_hash)
    on conflict (destination_hash) do nothing;
  return true;
end;
$$;

-- Recovery and retention, run every minute by pg_cron and now and then by requests:
-- - a settlement still in flight long after any facilitator answer is payment_uncertain [J13];
-- - finished jobs past their retention are deleted, with their call rows [J15].
create function public.stellar_sweep(retention_seconds integer, settle_timeout_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  stale integer;
  removed integer;
begin
  update public.stellar_jobs set status = 'payment_uncertain',
    settlement = jsonb_build_object('reason', 'the settlement did not finish in time')
    where status = 'pending'
      and settling_since < clock_timestamp() - make_interval(secs => settle_timeout_seconds);
  get diagnostics stale = row_count;
  delete from public.stellar_jobs
    where finished_at < clock_timestamp() - make_interval(secs => retention_seconds);
  get diagnostics removed = row_count;
  return jsonb_build_object('uncertain', stale, 'deleted', removed);
end;
$$;

revoke all on function public.stellar_job_guard() from public, anon, authenticated;
revoke all on function public.stellar_admission(text, text, integer, integer),
  public.stellar_claim_job(jsonb, integer, integer),
  public.stellar_settlement(uuid, text, jsonb, jsonb, jsonb),
  public.stellar_checked(uuid, jsonb),
  public.stellar_start_dial(uuid),
  public.stellar_dialed(uuid, text, boolean),
  public.stellar_fail(uuid, jsonb),
  public.stellar_claim_completion(uuid),
  public.stellar_complete(uuid, uuid, jsonb),
  public.stellar_release_completion(uuid, uuid),
  public.stellar_opt_out(uuid),
  public.stellar_sweep(integer, integer)
  from public, anon, authenticated;
grant execute on function public.stellar_admission(text, text, integer, integer),
  public.stellar_claim_job(jsonb, integer, integer),
  public.stellar_settlement(uuid, text, jsonb, jsonb, jsonb),
  public.stellar_checked(uuid, jsonb),
  public.stellar_start_dial(uuid),
  public.stellar_dialed(uuid, text, boolean),
  public.stellar_fail(uuid, jsonb),
  public.stellar_claim_completion(uuid),
  public.stellar_complete(uuid, uuid, jsonb),
  public.stellar_release_completion(uuid, uuid),
  public.stellar_opt_out(uuid),
  public.stellar_sweep(integer, integer)
  to service_role;
