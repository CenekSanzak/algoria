-- Demo diagnostics for the call bridge: plain step markers, no audio or secrets.
create table public.phone_debug (
  id bigserial primary key,
  at timestamptz not null default now(),
  note text not null check (length(note) between 1 and 500)
);
alter table public.phone_debug enable row level security;
alter table public.phone_debug force row level security;
revoke all on public.phone_debug from public, anon, authenticated;
grant select, insert on public.phone_debug to service_role;
grant usage on sequence public.phone_debug_id_seq to service_role;
