import { PGlite } from 'npm:@electric-sql/pglite@0.3.14';
import assert from 'node:assert/strict';
import type { Capacity, ClaimResult, CompletionClaim, Job, NewJob } from './store.ts';

type Results = {
  platform_create_job: { job: Job; created: boolean };
  platform_capacity: Capacity;
  platform_claim_payment: ClaimResult;
  platform_finish_payment: Job;
  platform_claim_submission: ClaimResult;
  platform_set_submitted: Job;
  platform_mark_running: Job;
  platform_claim_completion: CompletionClaim;
  platform_complete_job: Job;
  platform_release_completion: Job;
  platform_fail_job: Job;
  platform_record_webhook: boolean;
};

// Runs the actual migration against PostgreSQL WASM. PGlite serializes queries on
// one connection; real multi-connection lock contention requires live integration.
Deno.test('SQL store preserves payment reservations, replay guards, and completion leases', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean,
        file_size_limit bigint, allowed_mime_types text[]);
    `);
    await db.exec(
      await Deno.readTextFile(new URL('../../migrations/202609180001_platform.sql', import.meta.url)),
    );
    const rpc = async <K extends keyof Results>(name: K, args: unknown[] = []): Promise<Results[K]> => {
      const result = await db.query<{ result: Results[K] }>(
        `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`,
        args,
      );
      return result.rows[0].result;
    };
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
    const candidate = (n: number): NewJob => ({
      id: uuid(n),
      service_id: 'image.generate',
      service_version: '1',
      input: { prompt: 'test' },
      input_hash: 'a'.repeat(64),
      recovery_token_hash: 'b'.repeat(64),
      requirements: { payTo: 'GTEST', amount: '100' },
      resource_url: 'https://example.com/image',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const create = (n: number) => rpc('platform_create_job', [candidate(n)]);
    const claim = (n: number, fingerprint = `fp${n}`) =>
      rpc('platform_claim_payment', [uuid(n), fingerprint, 'GPAYER', {}]);
    const finish = (n: number, outcome: 'success' | 'failed' | 'uncertain') =>
      rpc('platform_finish_payment', [uuid(n), outcome, { outcome }]);

    await Promise.all([create(1), create(2), create(3)]);
    assert.equal((await rpc('platform_capacity')).available, true);
    const changedQuote = candidate(1);
    changedQuote.requirements.payTo = 'GNEW';
    changedQuote.service_version = '2';
    const retry = await rpc('platform_create_job', [changedQuote]);
    assert.equal(retry.created, false);
    assert.equal(retry.job.requirements.payTo, 'GTEST');
    assert.equal(retry.job.service_version, '1');
    await assert.rejects(
      rpc('platform_create_job', [{ ...candidate(1), input: { prompt: 'changed' } }]),
      /job-snapshot-conflict/,
    );
    assert.equal((await claim(1)).claimed, true);
    assert.equal((await claim(1)).claimed, false);
    assert.equal((await claim(2)).claimed, true);
    assert.equal((await claim(3)).reason, 'capacity-exhausted');
    await finish(1, 'failed');
    assert.equal((await rpc('platform_capacity')).totalUsed, 1);
    assert.equal((await claim(3, 'fp1')).reason, 'payment-replayed');
    assert.equal((await claim(3)).claimed, true);
    await finish(2, 'success');
    assert.equal((await rpc('platform_claim_submission', [uuid(2)])).claimed, true);
    assert.equal((await rpc('platform_claim_submission', [uuid(2)])).claimed, false);
    await rpc('platform_set_submitted', [uuid(2), 'provider2']);
    await rpc('platform_mark_running', [uuid(2)]);
    const lease = await rpc('platform_claim_completion', [uuid(2)]);
    assert.equal(lease.claimed, true);
    assert.equal((await rpc('platform_claim_completion', [uuid(2)])).claimed, false);
    assert.equal((await rpc('platform_complete_job', [uuid(2), uuid(88), {}])).status, 'saving');
    await db.query(
      "update public.jobs set completion_lease_until = now() - interval '1 second' where id = $1",
      [uuid(2)],
    );
    const nextLease = await rpc('platform_claim_completion', [uuid(2)]);
    assert.equal(nextLease.claimed, true);
    assert.notEqual(nextLease.leaseToken, lease.leaseToken);
    assert.equal((await rpc('platform_complete_job', [uuid(2), lease.leaseToken, {}])).status, 'saving');
    assert.equal((await rpc('platform_release_completion', [uuid(2), lease.leaseToken])).status, 'saving');
    assert.equal(
      (await rpc('platform_complete_job', [uuid(2), nextLease.leaseToken, { path: 'out.png' }])).status,
      'succeeded',
    );
    assert.equal((await rpc('platform_fail_job', [uuid(2), 'late', 'late error'])).status, 'succeeded');
    assert.equal(
      (await rpc('platform_complete_job', [uuid(2), nextLease.leaseToken, { path: 'wrong.png' }])).output
        ?.path,
      'out.png',
    );
    await finish(3, 'uncertain');
    assert.equal(
      (await rpc('platform_fail_job', [uuid(3), 'network', 'unknown'])).status,
      'payment_uncertain',
    );
    assert.equal((await rpc('platform_capacity')).active, 1);
    await finish(3, 'success');
    await rpc('platform_claim_submission', [uuid(3)]);
    await assert.rejects(rpc('platform_set_submitted', [uuid(3), 'provider2']), /unique constraint/);
    await rpc('platform_set_submitted', [uuid(3), 'provider3']);
    await rpc('platform_fail_job', [uuid(3), 'provider-failed', 'definitive failure']);
    assert.equal((await rpc('platform_capacity')).totalUsed, 2);
    assert.equal((await rpc('platform_capacity')).active, 0);
    await db.exec('update public.demo_settings set max_total=2');
    assert.equal((await claim(1, 'fresh-payment')).reason, 'capacity-exhausted');
    assert.equal(await rpc('platform_record_webhook', ['event1', 'provider2']), true);
    assert.equal(await rpc('platform_record_webhook', ['event1', 'provider2']), false);
    await assert.rejects(
      db.query("update public.jobs set requirements='{}' where id=$1", [uuid(1)]),
      /job-snapshot-immutable/,
    );
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.jobs'), /permission denied/);
    await assert.rejects(rpc('platform_capacity'), /permission denied/);
    await db.exec('reset role; set role service_role');
    assert.equal((await db.query<{ n: number }>('select count(*)::integer n from public.jobs')).rows[0].n, 3);
    assert.equal((await rpc('platform_capacity')).totalUsed, 2);
    await db.exec('reset role');
    assert.equal(
      (await db.query<{ public: boolean }>("select public from storage.buckets where id='outputs'")).rows[0]
        .public,
      false,
    );

    await db.exec('update public.demo_settings set max_total=10');
    await Promise.all([create(4), create(5), create(6)]);
    const samePayment = await Promise.all([claim(4, 'shared-payment'), claim(5, 'shared-payment')]);
    assert.equal(samePayment.filter((result) => result.claimed).length, 1);
    assert.equal(samePayment.find((result) => !result.claimed)?.reason, 'payment-replayed');
    const concurrent = await Promise.all([claim(6), claim(1, 'fresh-payment')]);
    assert.equal(concurrent.filter((result) => result.claimed).length, 1);
    assert.equal((await rpc('platform_capacity')).active, 2);
    const expiring = candidate(7);
    expiring.expires_at = new Date(Date.now() + 50).toISOString();
    await rpc('platform_create_job', [expiring]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await claim(7)).reason, 'expired');
    const permissions = await db.query<{ anon: boolean; authenticated: boolean }>(`
      select has_function_privilege('anon', oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated
      from pg_proc where proname like 'platform_%'
    `);
    assert.equal(permissions.rows.some((row) => row.anon || row.authenticated), false);

    // Fill quote admission without paying. Expired never-attempted records may
    // be pruned, while any payment history must survive the same cleanup.
    await finish(4, 'failed');
    await finish(5, 'failed');
    await finish(6, 'failed');
    await finish(1, 'failed');
    const attempted = candidate(8);
    attempted.expires_at = new Date(Date.now() + 50).toISOString();
    await rpc('platform_create_job', [attempted]);
    assert.equal((await claim(8)).claimed, true);
    await finish(8, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.exec(`
      insert into public.jobs (id, service_id, service_version, input, input_hash,
        recovery_token_hash, requirements, resource_url, expires_at)
      select gen_random_uuid(), 'bulk', '1', '{"prompt":"test"}'::jsonb,
        repeat('a',64), repeat('b',64), '{"payTo":"GTEST"}'::jsonb,
        'https://example.com/image', now() + interval '1 hour'
      from generate_series(1, 1000 - (select count(*)::integer from public.jobs
        where status='awaiting_payment' and not capacity_reserved));
    `);
    assert.equal((await create(9)).created, true, 'expired unused quote frees one place');
    assert.equal((await db.query('select id from public.jobs where id=$1', [uuid(7)])).rows.length, 0);
    assert.equal(
      (await db.query('select id from public.jobs where id=$1', [uuid(8)])).rows.length,
      1,
      'expired quote with payment history cannot be pruned',
    );
    await assert.rejects(create(10), /quote-capacity-exhausted/);
    assert.equal((await create(1)).created, false, 'existing requests work when quote capacity is full');
  } finally {
    await db.close();
  }
});
