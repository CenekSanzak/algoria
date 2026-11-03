import assert from 'node:assert/strict';
import { jobError } from './protocol.ts';
import type { NewJob } from './store.ts';
import { database, PAYER } from './testing.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hex = (c: string) => c.repeat(64);
const limits = { maxActive: 2, maxPerNumber: 3 };

function job(n: number, overrides: Partial<NewJob> = {}): NewJob {
  return {
    job_id: id(n),
    service: 'phone-call',
    charge: 'upfront',
    binding_hash: hex('a'),
    token_hash: hex('b'),
    network: 'stellar:pubnet',
    payer: PAYER.publicKey(),
    nonce: String(n),
    expiration_ledger: 1000,
    fingerprint: n.toString(16).padStart(64, '0'),
    destination_hash: hex(String(n % 10)),
    input: { to: '+14155550123', goal: 'Ask.', on_behalf_of: 'Sam' },
    ...overrides,
  };
}

Deno.test('one claim binds the job id and the payment, with admission checked again', async () => {
  const { db, store } = await database();
  try {
    const first = await store.claim(job(1), limits);
    assert.equal(first.outcome, 'created');
    assert.ok('job' in first && first.job.status === 'pending' && first.job.settling_since);
    // Same id, binding and token: the existing job, never a second claim [J5].
    assert.equal((await store.claim(job(1), limits)).outcome, 'existing');
    // Same id, another binding or token [J6].
    assert.equal((await store.claim(job(1, { binding_hash: hex('c') }), limits)).outcome, 'conflict');
    assert.equal((await store.claim(job(1, { token_hash: hex('d') }), limits)).outcome, 'conflict');
    // The same payment for another job [P9].
    assert.equal(
      (await store.claim(job(2, { fingerprint: job(1).fingerprint }), limits)).outcome,
      'payment_used',
    );
    // One call to a number at a time.
    assert.equal((await store.claim(job(11, { destination_hash: hex('1') }), limits)).outcome, 'number_busy');
    assert.equal((await store.claim(job(2), limits)).outcome, 'created');
    // Every line busy.
    assert.equal((await store.claim(job(3), limits)).outcome, 'busy');
    assert.equal(await store.admission('phone-call', hex('3'), limits), 'busy');
    assert.equal(await store.admission('phone-call', hex('1'), limits), 'number_busy');
  } finally {
    await db.close();
  }
});

Deno.test('settlement answers follow the standard: settled, failed uncharged, or uncertain', async () => {
  const { db, store } = await database();
  try {
    for (const n of [1, 2]) await store.claim(job(n), limits);
    const receipt = {
      network: 'stellar:pubnet' as const,
      asset: 'C',
      amount: '10000000',
      payTo: 'G',
      payer: PAYER.publicKey(),
      transaction: hex('e'),
      settledAt: new Date().toISOString(),
    };
    const paid = (await store.settlement(id(1), { outcome: 'settled', receipt }))!;
    assert.equal(paid.status, 'queued');
    assert.equal(paid.settling_since, null);
    assert.deepEqual(paid.payment, receipt);
    // A second answer for a decided job changes nothing.
    assert.equal(await store.settlement(id(1), { outcome: 'uncertain', reason: 'late' }), null);
    const uncertain =
      (await store.settlement(id(2), { outcome: 'uncertain', reason: 'timeout', transaction: hex('f') }))!;
    assert.equal(uncertain.status, 'payment_uncertain');
    assert.deepEqual(uncertain.settlement, { reason: 'timeout', transaction: hex('f') });
    await store.checked(id(2), 'the payment can still land');
    assert.ok((await store.get(id(2)))!.checked_at);
    // Decided from the chain: never landed -> failed, uncharged (payment_failed).
    const failed = (await store.settlement(id(2), {
      outcome: 'failed',
      error: jobError('payment_failed', 'nothing was charged'),
      reason: 'expired',
    }))!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'payment_failed');
    assert.equal(failed.input, null, 'a final job keeps no input');
    assert.ok(failed.finished_at);
    // Uncharged failures do not count against the number's daily limit.
    assert.equal(await store.admission('phone-call', hex('2'), { maxActive: 9, maxPerNumber: 1 }), 'ok');
  } finally {
    await db.close();
  }
});

Deno.test('a paid job dials once, finishes once, and final jobs never change', async () => {
  const { db, store } = await database();
  try {
    await store.claim(job(1), limits);
    await store.settlement(id(1), {
      outcome: 'settled',
      receipt: {
        network: 'stellar:pubnet',
        asset: 'C',
        amount: '1',
        payTo: 'G',
        payer: PAYER.publicKey(),
        transaction: hex('e'),
        settledAt: new Date().toISOString(),
      },
    });
    const dial = await store.startDial(id(1));
    assert.equal(dial.claimed, true);
    assert.equal(dial.job.status, 'running');
    assert.equal(dial.job.dial_state, 'dialing');
    assert.equal((await store.startDial(id(1))).claimed, false, 'never dialed twice');
    assert.equal((await store.dialed(id(1), 'CA' + '1'.repeat(32))).dial_state, 'dialed');
    const lease = await store.claimCompletion(id(1));
    assert.equal(lease.claimed, true);
    assert.equal((await store.claimCompletion(id(1))).claimed, false, 'one writer at a time');
    const done = await store.complete(id(1), lease.lease!, { call: { status: 'completed' } });
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.output, { call: { status: 'completed' } });
    assert.equal(done.input, null);
    await assert.rejects(
      db.query(`update public.stellar_jobs set status = 'failed' where job_id = $1`, [id(1)]),
      /stellar-job-final/,
    );
    await assert.rejects(
      db.query(`update public.stellar_jobs set token_hash = $2 where job_id = $1`, [id(1), hex('9')]),
      /final|immutable/,
    );
    // The number's daily limit counts calls placed.
    assert.equal(
      await store.admission('phone-call', hex('1'), { maxActive: 9, maxPerNumber: 1 }),
      'number_limited',
    );
  } finally {
    await db.close();
  }
});

Deno.test('transitions outside the standard are refused by the database', async () => {
  const { db, store } = await database();
  try {
    await store.claim(job(1), limits);
    await assert.rejects(
      db.query(`update public.stellar_jobs set status = 'succeeded' where job_id = $1`, [id(1)]),
      /stellar-job-transition-forbidden/,
    );
    await assert.rejects(
      db.query(`update public.stellar_jobs set status = 'running' where job_id = $1`, [id(1)]),
      /stellar-job-transition-forbidden/,
    );
    // queued -> failed is not a transition: a paid job is failed only once it is running.
    await store.settlement(id(1), {
      outcome: 'settled',
      receipt: {
        network: 'stellar:pubnet',
        asset: 'C',
        amount: '1',
        payTo: 'G',
        payer: PAYER.publicKey(),
        transaction: hex('e'),
        settledAt: new Date().toISOString(),
      },
    });
    assert.equal((await store.fail(id(1), jobError('service_failed'))).status, 'queued');
  } finally {
    await db.close();
  }
});

Deno.test('opt-outs, the sweep and retention', async () => {
  const { db, store, age } = await database();
  try {
    await store.claim(job(1), limits);
    assert.equal(await store.optOut(id(1)), true);
    assert.equal(await store.admission('phone-call', hex('1'), limits), 'opted_out');
    assert.equal((await store.claim(job(21, { destination_hash: hex('1') }), limits)).outcome, 'opted_out');
    // A settlement still in flight long after any answer could come is payment_uncertain [J13].
    await db.exec(
      `alter table public.stellar_jobs disable trigger stellar_jobs_guard;
       update public.stellar_jobs set settling_since = now() - interval '10 minutes' where job_id = '${
        id(1)
      }';
       alter table public.stellar_jobs enable trigger stellar_jobs_guard;`,
    );
    assert.deepEqual(await store.sweep(86400, 150), { uncertain: 1, deleted: 0 });
    assert.equal((await store.get(id(1)))!.status, 'payment_uncertain');
    assert.equal((await store.uncertain(5, 20)).length, 1);
    await store.checked(id(1), 'still open');
    assert.equal((await store.uncertain(5, 20)).length, 0, 'looked at just now');
    await store.settlement(id(1), {
      outcome: 'failed',
      error: jobError('payment_failed'),
      reason: 'expired',
    });
    await db.exec(
      `alter table public.stellar_jobs disable trigger stellar_jobs_guard;
       update public.stellar_jobs set finished_at = now() - interval '2 days' where job_id = '${id(1)}';
       alter table public.stellar_jobs enable trigger stellar_jobs_guard;`,
    );
    assert.deepEqual(await store.sweep(86400, 150), { uncertain: 0, deleted: 1 });
    assert.equal(await store.get(id(1)), null);
    // Opt-outs outlive the job.
    assert.equal(await store.admission('phone-call', hex('1'), limits), 'opted_out');
    await store.claim(job(2), limits);
    await age(id(2), 600);
    assert.equal(
      (await store.stale(10, 60)).length,
      0,
      'only paid jobs that are queued or running are stale',
    );
  } finally {
    await db.close();
  }
});

Deno.test('service_role alone reaches the tables and functions', async () => {
  const { db } = await database();
  try {
    const grants = await db.query<{ grantee: string; routine_name: string }>(
      `select grantee, routine_name from information_schema.routine_privileges
       where routine_schema = 'public' and routine_name like 'stellar_%' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    );
    assert.deepEqual(grants.rows, []);
    const tables = await db.query<{ grantee: string }>(
      `select grantee from information_schema.role_table_grants
       where table_name like 'stellar_%' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
    );
    assert.deepEqual(tables.rows, []);
  } finally {
    await db.close();
  }
});
