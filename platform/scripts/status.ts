const supabase = Deno.env.get('SUPABASE_URL');
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const anon = Deno.env.get('SUPABASE_ANON_KEY');
if (supabase !== 'https://vqqbvydiehuwdzbgvmun.supabase.co' || !key || !anon) {
  throw new Error('Local project credentials missing');
}
function api(path: string, token: string, init?: RequestInit) {
  return fetch(`${supabase}${path}`, {
    ...init,
    headers: { apikey: token, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
}
const capacity = await api('/rest/v1/rpc/platform_capacity', key, { method: 'POST', body: '{}' });
if (!capacity.ok) throw new Error(`Capacity unavailable: ${capacity.status}`);
const jobs = await api(
  '/rest/v1/jobs?select=id,status,provider_request_id,payment_receipt,created_at&order=created_at.desc&limit=20',
  key,
);
if (!jobs.ok) throw new Error(`Job inspection unavailable: ${jobs.status}`);
console.log(JSON.stringify(
  {
    capacity: await capacity.json(),
    jobs: (await jobs.json()).map((
      job: {
        id: string;
        status: string;
        provider_request_id: string | null;
        payment_receipt?: { transaction?: string };
      },
    ) => ({
      id: job.id,
      status: job.status,
      provider_request_id: job.provider_request_id,
      transaction: job.payment_receipt?.transaction,
    })),
  },
  null,
  2,
));
const deniedRead = await api('/rest/v1/jobs?select=id&limit=1', anon);
const deniedRpc = await api('/rest/v1/rpc/platform_capacity', anon, { method: 'POST', body: '{}' });
if (deniedRead.ok || deniedRpc.ok) throw new Error('Unexpected anonymous database access');
console.log(`Anonymous table/RPC access rejected: ${deniedRead.status}/${deniedRpc.status}`);
