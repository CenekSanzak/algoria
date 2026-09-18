-- Inputs are validated against the selected service before creating a quote.
-- Preserve all existing jobs, immutable snapshots, payment guards, and RPC grants.
alter table public.jobs drop constraint jobs_input_check;
alter table public.jobs add constraint jobs_input_check check (jsonb_typeof(input) = 'object');

update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/wav', 'audio/mpeg']
where id = 'outputs';
