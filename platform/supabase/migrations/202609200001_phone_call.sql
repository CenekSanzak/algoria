-- Live state of phone.call jobs. The job row keeps payment/status; this row keeps the
-- Twilio call status and the transcript written by the realtime voice bridge.
create table public.phone_calls (
  job_id uuid primary key references public.jobs(id),
  call_sid text unique check (call_sid is null or length(call_sid) between 1 and 64),
  call_status text not null default 'queued' check (length(call_status) between 1 and 32),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  transcript jsonb not null default '[]' check (jsonb_typeof(transcript) = 'array'),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.phone_calls enable row level security;
alter table public.phone_calls force row level security;
revoke all on public.phone_calls from public, anon, authenticated;
grant select, insert, update on public.phone_calls to service_role;
create policy phone_calls_service_role on public.phone_calls for all to service_role using (true) with check (true);
