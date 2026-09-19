-- Composite jobs reserve one payment/capacity slot. Steps never settle x402.
create table public.social_steps (
  job_id uuid not null references public.jobs(id),
  name text not null check (name ~ '^(image-[0-4]|speech|slideshow|compose|caption)$'),
  state text not null default 'pending' check (state in ('pending','submitting','queued','succeeded','failed','uncertain')),
  provider_id text unique,
  output jsonb,
  primary key(job_id, name)
);
alter table public.social_steps enable row level security;
alter table public.social_steps force row level security;
revoke all on public.social_steps from public, anon, authenticated;
grant select on public.social_steps to service_role;

create function public.social_start(job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  select * into strict j from public.jobs where id = job_id for update;
  if j.service_id <> 'video.social' then raise exception 'not-social'; end if;
  if j.status = 'paid' then
    insert into public.social_steps(job_id, name)
      select j.id, 'image-' || n from generate_series(0, jsonb_array_length(j.input->'scenes') - 1) n;
    insert into public.social_steps(job_id, name) values (j.id, 'speech');
    update public.jobs set status = 'queued', provider_request_id = 'social-' || j.id
      where id = j.id returning * into j;
  end if;
  return public.platform_job_json(j);
end;
$$;

-- The parent completion lease fences every step mutation, including before dispatch.
create function public.social_step_write(job_id uuid, lease_token uuid, step_name text, next_state text, provider_id text default null, output jsonb default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare current_step public.social_steps;
begin
  perform 1 from public.jobs j where j.id = job_id and j.service_id = 'video.social'
    and j.status = 'saving' and j.completion_lease_token = lease_token
    and j.completion_lease_until > clock_timestamp() for update;
  if not found then raise exception 'social-lease-lost'; end if;
  select * into current_step from public.social_steps s where s.job_id = social_step_write.job_id and s.name = step_name for update;
  if not found then
    if next_state <> 'pending' then raise exception 'invalid-step-transition'; end if;
    insert into public.social_steps(job_id, name) values (job_id, step_name);
    return true;
  end if;
  if not ((current_step.state = 'pending' and next_state = 'submitting') or
    (current_step.state = 'submitting' and next_state in ('queued','failed','uncertain')) or
    (current_step.state = 'queued' and next_state in ('succeeded','failed'))) then
    raise exception 'invalid-step-transition';
  end if;
  if next_state = 'queued' and (provider_id is null or length(provider_id) not between 1 and 128) then raise exception 'missing-provider-id'; end if;
  if next_state = 'succeeded' and (output is null or jsonb_typeof(output) <> 'object') then raise exception 'missing-step-output'; end if;
  update public.social_steps s set state = next_state,
    provider_id = coalesce(social_step_write.provider_id, s.provider_id), output = coalesce(social_step_write.output, s.output)
    where s.job_id = social_step_write.job_id and s.name = step_name;
  return true;
end;
$$;
revoke all on function public.social_start(uuid), public.social_step_write(uuid,uuid,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.social_start(uuid), public.social_step_write(uuid,uuid,text,text,text,jsonb) to service_role;

-- Bounded demo upload admission. Random recovery tokens protect retries and signing.
create table public.social_references (
  id uuid primary key, token_hash text not null check(length(token_hash)=64),
  content_hash text not null check(length(content_hash)=64),
  path text not null unique, created_at timestamptz not null default now()
);
alter table public.social_references enable row level security;
alter table public.social_references force row level security;
revoke all on public.social_references from public, anon, authenticated;
grant select on public.social_references to service_role;
create function public.social_reference_reserve(ref_id uuid, token_hash text, content_hash text, path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.social_references;
begin
  perform 1 from public.demo_settings where singleton for update;
  select * into r from public.social_references where id = ref_id;
  if found then
    if r.token_hash <> social_reference_reserve.token_hash then raise exception 'reference-not-found'; end if;
    if r.content_hash <> social_reference_reserve.content_hash or r.path <> social_reference_reserve.path then raise exception 'reference-conflict'; end if;
    return to_jsonb(r);
  end if;
  if (select count(*) from public.social_references) >= 200 then raise exception 'reference-capacity-exhausted'; end if;
  insert into public.social_references(id, token_hash, content_hash, path)
    values(ref_id, token_hash, content_hash, path) returning * into r;
  return to_jsonb(r);
end;
$$;
revoke all on function public.social_reference_reserve(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.social_reference_reserve(uuid,text,text,text) to service_role;
