import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../', import.meta.url));
const envPath = new URL('../.env.local', import.meta.url);
process.loadEnvFile(envPath);
const ref = process.env.SUPABASE_PROJECT_REF;
if (ref !== 'vqqbvydiehuwdzbgvmun') throw new Error('Unexpected project: refusing deployment');
const env = { ...process.env, npm_config_cache: '/private/tmp/algoria-npm-cache' };
function cli(args, capture = false) {
  const result = spawnSync('npx', ['--yes', 'supabase', ...args], {
    cwd: directory,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: 180000,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Supabase ${args[0]} failed (${result.status})`);
  return result.stdout;
}
const action = process.argv[2];
if (action === 'link') cli(['link', '--project-ref', ref, '--yes']);
else if (action === 'keys') {
  const keys = JSON.parse(cli(['projects', 'api-keys', '--project-ref', ref, '--output', 'json'], true));
  let contents = readFileSync(envPath, 'utf8');
  for (
    const [name, envName] of [['service_role', 'SUPABASE_SERVICE_ROLE_KEY'], ['anon', 'SUPABASE_ANON_KEY']]
  ) {
    const entry = keys.find((k) => k.name === name);
    if (!entry?.api_key) throw new Error(`Project ${name} key unavailable`);
    contents = contents.split('\n').filter((line) => !line.startsWith(`${envName}=`)).join('\n').trimEnd();
    contents += `\n${envName}=${entry.api_key}\n`;
  }
  writeFileSync(envPath, contents, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log('Project keys saved locally; values not printed.');
} else if (action === 'migrate') cli(['db', 'push', '--linked', '--yes']);
else if (action === 'secrets') {
  const path = new URL('../.local/deploy.env', import.meta.url);
  const names = [
    'FAL_KEY',
    'VIDEO_SOCIAL_PAY_TO',
    'VIDEO_SOCIAL_PRICE_ATOMIC',
    'SOCIAL_WORKFLOW_SECRET',
    'IMAGE_GENERATE_PAY_TO',
    'IMAGE_GENERATE_PRICE_ATOMIC',
    'SPEECH_GENERATE_PAY_TO',
    'SPEECH_GENERATE_PRICE_ATOMIC',
    'VIDEO_SLIDESHOW_PAY_TO',
    'VIDEO_SLIDESHOW_PRICE_ATOMIC',
    'VIDEO_COMPOSE_PAY_TO',
    'VIDEO_COMPOSE_PRICE_ATOMIC',
    'VIDEO_CAPTION_PAY_TO',
    'VIDEO_CAPTION_PRICE_ATOMIC',
    'FACILITATOR_URL',
    'ALGORIA_API_BASE_URL',
  ];
  const contents = names.filter((name) =>
    process.env[name]
  ).map((name) => `${name}=${process.env[name]}`).join('\n') + '\n';
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
  cli(['secrets', 'set', '--project-ref', ref, '--env-file', fileURLToPath(path)]);
} else if (action === 'deploy') {
  cli(['functions', 'deploy', 'api', '--project-ref', ref, '--use-api', '--no-verify-jwt']);
} else throw new Error('Usage: node scripts/infra.mjs link|keys|migrate|secrets|deploy');
