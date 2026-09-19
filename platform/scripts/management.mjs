import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// HTTPS fallback when a network does not permit the PostgreSQL port.
// Uses the same specific Keychain entry as Supabase CLI; never prints/stores it.
const ref = 'vqqbvydiehuwdzbgvmun';
let cachedToken;
function accessToken() {
  if (cachedToken) return cachedToken;
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const result = spawnSync('security', [
    'find-generic-password',
    '-s',
    'Supabase CLI',
    '-a',
    'supabase',
    '-w',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Supabase CLI credential unavailable');
  cachedToken = result.stdout.trim();
  return cachedToken;
}
export async function management(path, body, sensitive = false) {
  const result = await fetch(`https://api.supabase.com/v1/projects/${ref}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!result.ok) {
    // Database errors are useful; only database endpoint bodies are printed.
    const details = !sensitive && path.startsWith('database/') ? await result.text() : '';
    throw new Error(`Management API HTTP ${result.status}: ${details.slice(0, 1000)}`);
  }
  return result.json();
}
if (process.argv[1]?.endsWith('/management.mjs')) {
  const action = process.argv[2];
  if (action === 'status') {
    console.log(
      JSON.stringify(
        await management('database/query', {
          query:
            "select to_regclass('public.jobs') as jobs, to_regclass('supabase_migrations.schema_migrations') as history",
        }),
      ),
    );
  } else if (action === 'migrate') {
    const existing = await management('database/query', {
      query: "select to_regclass('public.jobs') as jobs",
    });
    if (existing[0]?.jobs) {
      throw new Error('Platform schema exists; check migration history before applying again');
    }
    const migration = readFileSync(
      new URL('../supabase/migrations/202609180001_platform.sql', import.meta.url),
      'utf8',
    );
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const query = `begin;
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
      ${migration}
      insert into supabase_migrations.schema_migrations(version, statements, name) values ('202609180001', array[${
      quote(migration)
    }], 'platform');
      notify pgrst, 'reload schema';
      commit;`;
    await management('database/query', { query });
    console.log('Platform migration applied atomically with CLI migration history.');
  } else if (action === 'migrate-media') {
    const version = '202609180002';
    const history = await management('database/query', {
      query: `select version from supabase_migrations.schema_migrations where version = '${version}'`,
    });
    if (history.length) {
      console.log('Media service migration is already recorded.');
    } else {
      const migration = readFileSync(
        new URL('../supabase/migrations/202609180002_speech_service.sql', import.meta.url),
        'utf8',
      );
      const quoted = "'" + migration.replaceAll("'", "''") + "'";
      await management('database/query', {
        query: `begin;
        ${migration}
        insert into supabase_migrations.schema_migrations(version, statements, name)
        values ('${version}', array[${quoted}], 'speech_service');
        notify pgrst, 'reload schema';
        commit;`,
      });
      console.log('Media service migration applied with CLI migration history.');
    }
  } else throw new Error('Usage: node scripts/management.mjs status|migrate|migrate-media');
}
