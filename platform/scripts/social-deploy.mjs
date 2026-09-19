import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { management } from './management.mjs';

// Apply only the additive social migration and schedule its bounded recovery tick.
const envPath = new URL('../.env.local', import.meta.url);
process.loadEnvFile(envPath);
if (process.env.SUPABASE_PROJECT_REF !== 'vqqbvydiehuwdzbgvmun') throw new Error('Unexpected project');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const version = '202609190001';
const history = await management('database/query', {
  query: `select version from supabase_migrations.schema_migrations where version='${version}'`,
});
if (!history.length) {
  const migration = readFileSync(
    new URL('../supabase/migrations/202609190001_social_video.sql', import.meta.url),
    'utf8',
  );
  await management('database/query', {
    query:
      `begin; ${migration}\ninsert into supabase_migrations.schema_migrations(version,statements,name) values('${version}',array[${
        quote(migration)
      }],'social_video'); notify pgrst, 'reload schema'; commit;`,
  });
  console.log('Social workflow migration applied.');
}
let secret = process.env.SOCIAL_WORKFLOW_SECRET;
if (!secret) {
  secret = randomBytes(32).toString('base64url');
  writeFileSync(envPath, readFileSync(envPath, 'utf8').trimEnd() + `\nSOCIAL_WORKFLOW_SECRET=${secret}\n`, {
    mode: 0o600,
  });
  chmodSync(envPath, 0o600);
}
if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('Invalid workflow secret');
// Vault holds the secret; cron history never includes its value. The management
// helper must never log this query even on failure.
const query = `begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $block$ declare existing uuid; begin
  select id into existing from vault.secrets where name='algoria_social_tick';
  if existing is null then perform vault.create_secret(${quote(secret)},'algoria_social_tick');
  else perform vault.update_secret(existing,${quote(secret)}); end if;
end $block$;
select cron.schedule('algoria-social-tick','* * * * *',$cron$
 select net.http_post(
   url := 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/internal/social/tick',
   headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='algoria_social_tick'), 'Content-Type','application/json'),
   body := '{}'::jsonb, timeout_milliseconds := 110000
 );
$cron$);
commit;`;
try {
  await management('database/query', { query }, true);
} catch {
  throw new Error(
    'Social scheduler setup failed; details withheld because the query contains a workflow credential.',
  );
}
console.log('Recovery scheduled every minute. Run infra.mjs secrets and deploy next.');
