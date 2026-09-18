-- Independent Algoria API database. Do not apply to the legacy Svelte project.
create table public.demo_settings (
  singleton boolean primary key default true check (singleton),
  max_total integer not null default 10 check (max_total >= 0),
  max_concurrent integer not null default 2 check (max_concurrent >= 0)
);
insert into public.demo_settings (singleton) values (true);

create table public.jobs (
  id uuid primary key,
  service_id text not null check (length(service_id) between 1 and 100),
  service_version text not null check (length(service_version) between 1 and 100),
  input jsonb not null check (jsonb_typeof(input) = 'object' and jsonb_typeof(input->'prompt') = 'string'),
  input_hash text not null check (length(input_hash) = 64),
  recovery_token_hash text not null check (length(recovery_token_hash) = 64),
  requirements jsonb not null check (jsonb_typeof(requirements) = 'object'),
  resource_url text not null,
  status text not null default 'awaiting_payment' check (status in (
    'awaiting_payment', 'settling', 'payment_uncertain', 'paid', 'submitting',
    'queued', 'running', 'saving', 'succeeded', 'failed'
  )),
  payer text,
  payment_receipt jsonb,
  provider_request_id text unique,
  output jsonb,
  error jsonb,
  capacity_reserved boolean not null default false,
  current_payment_attempt_id bigint,
  completion_lease_token uuid,
  completion_lease_until timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (status not in ('settling', 'payment_uncertain', 'paid', 'submitting', 'queued', 'running', 'saving', 'succeeded') or capacity_reserved),
  check ((status = 'saving') = (completion_lease_token is not null and completion_lease_until is not null))
);
create index jobs_reserved_status_idx on public.jobs (status) where capacity_reserved;
create index jobs_unpaid_expiry_idx on public.jobs (expires_at)
  where status = 'awaiting_payment' and not capacity_reserved;

create table public.payment_attempts (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs (id),
  fingerprint text not null unique check (length(fingerprint) between 1 and 512),
  payer text not null check (length(payer) between 1 and 512),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  requirements jsonb not null,
  outcome text not null default 'settling' check (outcome in ('settling', 'success', 'failed', 'uncertain')),
  receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_attempts_job_idx on public.payment_attempts (job_id);
alter table public.jobs add constraint jobs_payment_attempt_fk
  foreign key (current_payment_attempt_id) references public.payment_attempts (id);

create table public.webhook_events (
  event_key text primary key check (length(event_key) between 1 and 1024),
  provider_request_id text not null check (length(provider_request_id) between 1 and 512),
  received_at timestamptz not null default now()
);

alter table public.demo_settings enable row level security;
alter table public.demo_settings force row level security;
alter table public.jobs enable row level security;
alter table public.jobs force row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_attempts force row level security;
alter table public.webhook_events enable row level security;
alter table public.webhook_events force row level security;
revoke all on public.demo_settings, public.jobs, public.payment_attempts, public.webhook_events from public, anon, authenticated;
revoke all on sequence public.payment_attempts_id_seq from public, anon, authenticated;
grant select on public.jobs to service_role;
-- Counter changes are operational: they are never exposed through an API route.
grant select, update on public.demo_settings to service_role;

create function public.platform_job_json(job public.jobs) returns jsonb
language sql immutable set search_path = '' as $$
  select to_jsonb(job) - 'capacity_reserved' - 'current_payment_attempt_id'
    - 'completion_lease_token' - 'completion_lease_until';
$$;

create function public.platform_job_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if row(new.id, new.service_id, new.service_version, new.input, new.input_hash,
    new.recovery_token_hash, new.requirements, new.resource_url, new.created_at, new.expires_at)
    is distinct from row(old.id, old.service_id, old.service_version, old.input, old.input_hash,
    old.recovery_token_hash, old.requirements, old.resource_url, old.created_at, old.expires_at) then
    raise exception 'job-snapshot-immutable' using errcode = '23514';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger jobs_immutable_before_update before update on public.jobs
for each row execute function public.platform_job_immutable();

create function public.platform_create_job(candidate jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  found_job public.jobs;
  inserted boolean;
begin
  -- Serialize new quote admission and payment admission on the same small demo lock.
  -- Existing request IDs remain recoverable even while quote admission is full.
  perform 1 from public.demo_settings where singleton for update;
  select * into found_job from public.jobs where id = (candidate->>'id')::uuid;
  if found then
    if row(found_job.service_id, found_job.input, found_job.input_hash, found_job.recovery_token_hash)
      is distinct from row(candidate->>'service_id', candidate->'input',
        candidate->>'input_hash', candidate->>'recovery_token_hash') then
      raise exception 'job-snapshot-conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('job', public.platform_job_json(found_job), 'created', false);
  end if;
  -- Count expired pending rows too: otherwise rotating free quotes grows forever.
  if (select count(*) from public.jobs where status = 'awaiting_payment' and not capacity_reserved) >= 1000 then
    delete from public.jobs j where j.status = 'awaiting_payment' and not j.capacity_reserved
      and j.expires_at <= clock_timestamp()
      and not exists (select 1 from public.payment_attempts p where p.job_id = j.id);
    if (select count(*) from public.jobs where status = 'awaiting_payment' and not capacity_reserved) >= 1000 then
      raise exception 'quote-capacity-exhausted' using errcode = 'P0001';
    end if;
  end if;
  insert into public.jobs (id, service_id, service_version, input, input_hash,
    recovery_token_hash, requirements, resource_url, expires_at)
  values ((candidate->>'id')::uuid, candidate->>'service_id', candidate->>'service_version',
    candidate->'input', candidate->>'input_hash', candidate->>'recovery_token_hash',
    candidate->'requirements', candidate->>'resource_url', (candidate->>'expires_at')::timestamptz)
  on conflict (id) do nothing returning * into found_job;
  inserted := found;
  if not inserted then
    select * into strict found_job from public.jobs where id = (candidate->>'id')::uuid;
    -- A retry reuses the first quote/version even after deployment configuration changes.
    if row(found_job.service_id, found_job.input, found_job.input_hash, found_job.recovery_token_hash)
      is distinct from row(candidate->>'service_id', candidate->'input',
        candidate->>'input_hash', candidate->>'recovery_token_hash') then
      raise exception 'job-snapshot-conflict' using errcode = '23505';
    end if;
  end if;
  return jsonb_build_object('job', public.platform_job_json(found_job), 'created', inserted);
end;
$$;

create function public.platform_capacity() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'available', count(j.id) < s.max_total and count(j.id) filter (where j.status in
      ('settling', 'payment_uncertain', 'paid', 'submitting', 'queued', 'running', 'saving')) < s.max_concurrent,
    'totalUsed', count(j.id),
    'active', count(j.id) filter (where j.status in
      ('settling', 'payment_uncertain', 'paid', 'submitting', 'queued', 'running', 'saving')),
    'maxTotal', s.max_total,
    'maxConcurrent', s.max_concurrent)
  from public.demo_settings s left join public.jobs j on j.capacity_reserved
  where s.singleton group by s.max_total, s.max_concurrent;
$$;

create function public.platform_claim_payment(
  job_id uuid, payment_fingerprint text, payment_payer text, payment_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  found_job public.jobs;
  attempt_id bigint;
  limits jsonb;
  refusal text;
begin
  -- A single lock serializes global capacity reservations across all jobs.
  perform 1 from public.demo_settings where singleton for update;
  select * into found_job from public.jobs where id = job_id for update;
  if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  if found_job.status <> 'awaiting_payment' then refusal := 'invalid-status';
  elsif found_job.expires_at <= clock_timestamp() then refusal := 'expired';
  elsif exists (select 1 from public.payment_attempts where fingerprint = payment_fingerprint) then
    refusal := 'payment-replayed';
  else
    limits := public.platform_capacity();
    if not (limits->>'available')::boolean then refusal := 'capacity-exhausted'; end if;
  end if;
  if refusal is not null then
    return jsonb_build_object('claimed', false, 'reason', refusal, 'job', public.platform_job_json(found_job));
  end if;
  insert into public.payment_attempts (job_id, fingerprint, payer, payload, requirements)
    values (job_id, payment_fingerprint, payment_payer, payment_payload, found_job.requirements)
    returning id into attempt_id;
  update public.jobs set status = 'settling', payer = payment_payer,
    capacity_reserved = true, current_payment_attempt_id = attempt_id,
    payment_receipt = null, error = null where id = job_id returning * into found_job;
  return jsonb_build_object('claimed', true, 'job', public.platform_job_json(found_job));
end;
$$;

create function public.platform_finish_payment(job_id uuid, outcome text, receipt jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
begin
  if outcome not in ('success', 'failed', 'uncertain') or outcome is null then
    raise exception 'invalid-payment-outcome' using errcode = '22023';
  end if;
  select * into found_job from public.jobs where id = job_id for update;
  if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  if found_job.status not in ('settling', 'payment_uncertain') then
    return public.platform_job_json(found_job);
  end if;
  update public.payment_attempts set outcome = platform_finish_payment.outcome,
    receipt = platform_finish_payment.receipt, updated_at = clock_timestamp()
    where id = found_job.current_payment_attempt_id;
  update public.jobs set
    status = case outcome when 'success' then 'paid' when 'failed' then 'awaiting_payment' else 'payment_uncertain' end,
    capacity_reserved = outcome <> 'failed', payment_receipt = receipt,
    error = case when outcome = 'success' then null else jsonb_build_object(
      'code', case when outcome = 'failed' then 'payment-failed' else 'payment-uncertain' end) end
    where id = job_id returning * into found_job;
  return public.platform_job_json(found_job);
end;
$$;

create function public.platform_claim_submission(job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
declare did_claim boolean;
begin
  update public.jobs set status = 'submitting' where id = job_id and status = 'paid'
    returning * into found_job;
  did_claim := found;
  if not did_claim then
    select * into found_job from public.jobs where id = job_id;
    if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('claimed', did_claim, 'job', public.platform_job_json(found_job));
end;
$$;

create function public.platform_set_submitted(job_id uuid, provider_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
begin
  if provider_id is null or length(provider_id) not between 1 and 512 then
    raise exception 'invalid-provider-id' using errcode = '22023';
  end if;
  select * into found_job from public.jobs where id = job_id for update;
  if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  if found_job.provider_request_id is not null and found_job.provider_request_id <> provider_id then
    raise exception 'provider-request-conflict' using errcode = '23505';
  end if;
  if found_job.status = 'submitting' then
    update public.jobs set status = 'queued', provider_request_id = provider_id
      where id = job_id returning * into found_job;
  end if;
  return public.platform_job_json(found_job);
end;
$$;

create function public.platform_fail_job(job_id uuid, error_code text, error_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
begin
  select * into found_job from public.jobs where id = job_id for update;
  if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  -- Ambiguous payment and successful output cannot be replaced by an unrelated error.
  if found_job.status not in ('succeeded', 'failed', 'settling', 'payment_uncertain') then
    update public.jobs set status = 'failed',
      error = jsonb_build_object('code', error_code, 'message', error_message),
      completion_lease_token = null, completion_lease_until = null
      where id = job_id returning * into found_job;
  end if;
  return public.platform_job_json(found_job);
end;
$$;

create function public.platform_claim_completion(job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
declare token uuid := gen_random_uuid();
declare did_claim boolean;
begin
  update public.jobs set status = 'saving', completion_lease_token = token,
    completion_lease_until = clock_timestamp() + interval '120 seconds'
    where id = job_id and (status in ('queued', 'running') or
      (status = 'saving' and completion_lease_until <= clock_timestamp()))
    returning * into found_job;
  did_claim := found;
  if not did_claim then
    select * into found_job from public.jobs where id = job_id;
    if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
    return jsonb_build_object('claimed', false, 'job', public.platform_job_json(found_job));
  end if;
  return jsonb_build_object('claimed', true, 'leaseToken', token, 'job', public.platform_job_json(found_job));
end;
$$;

create function public.platform_complete_job(job_id uuid, lease_token uuid, job_output jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
begin
  if job_output is null or jsonb_typeof(job_output) <> 'object' then
    raise exception 'invalid-job-output' using errcode = '22023';
  end if;
  update public.jobs set status = 'succeeded', output = job_output, error = null,
    completion_lease_token = null, completion_lease_until = null
    where id = job_id and status = 'saving' and completion_lease_token = lease_token
    returning * into found_job;
  if not found then
    select * into found_job from public.jobs where id = job_id;
    if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  end if;
  return public.platform_job_json(found_job);
end;
$$;

create function public.platform_release_completion(job_id uuid, lease_token uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
begin
  update public.jobs set status = 'queued', completion_lease_token = null, completion_lease_until = null
    where id = job_id and status = 'saving' and completion_lease_token = lease_token
    returning * into found_job;
  if not found then
    select * into found_job from public.jobs where id = job_id;
    if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  end if;
  return public.platform_job_json(found_job);
end;
$$;

create function public.platform_mark_running(job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare found_job public.jobs;
begin
  update public.jobs set status = 'running' where id = job_id and status = 'queued'
    returning * into found_job;
  if not found then
    select * into found_job from public.jobs where id = job_id;
    if not found then raise exception 'job-not-found' using errcode = 'P0002'; end if;
  end if;
  return public.platform_job_json(found_job);
end;
$$;

create function public.platform_record_webhook(event_key text, provider_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.webhook_events (event_key, provider_request_id) values (event_key, provider_id)
    on conflict do nothing;
  return found;
end;
$$;

revoke all on function public.platform_job_json(public.jobs) from public, anon, authenticated;
revoke all on function public.platform_job_immutable() from public, anon, authenticated;
revoke all on function public.platform_create_job(jsonb) from public, anon, authenticated;
revoke all on function public.platform_capacity() from public, anon, authenticated;
revoke all on function public.platform_claim_payment(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.platform_finish_payment(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.platform_claim_submission(uuid) from public, anon, authenticated;
revoke all on function public.platform_set_submitted(uuid, text) from public, anon, authenticated;
revoke all on function public.platform_fail_job(uuid, text, text) from public, anon, authenticated;
revoke all on function public.platform_claim_completion(uuid) from public, anon, authenticated;
revoke all on function public.platform_complete_job(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.platform_release_completion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_mark_running(uuid) from public, anon, authenticated;
revoke all on function public.platform_record_webhook(text, text) from public, anon, authenticated;

grant execute on function public.platform_create_job(jsonb), public.platform_capacity(),
  public.platform_claim_payment(uuid, text, text, jsonb), public.platform_finish_payment(uuid, text, jsonb),
  public.platform_claim_submission(uuid), public.platform_set_submitted(uuid, text),
  public.platform_fail_job(uuid, text, text), public.platform_claim_completion(uuid),
  public.platform_complete_job(uuid, uuid, jsonb), public.platform_release_completion(uuid, uuid),
  public.platform_mark_running(uuid), public.platform_record_webhook(text, text) to service_role;

-- No storage.objects client policy: signed URL creation and writes use service_role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('outputs', 'outputs', false, 52428800, array['image/png', 'image/jpeg', 'image/webp', 'video/mp4'])
  on conflict (id) do update set public = false,
    file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
