// Deploys the Stellar Agent Services provider (supabase/functions/stellar) to the Algoria Supabase project,
// on Stellar mainnet, and registers it in the Stellar 8004 registry so Stellar Agent Search finds it.
//
//   node scripts/stellar-deploy.mjs            everything below, in order
//   node scripts/stellar-deploy.mjs preflight  the facilitator takes the key; the payout account has XLM
//   node scripts/stellar-deploy.mjs migrate    the stellar_* tables and functions, recorded in migration history
//   node scripts/stellar-deploy.mjs schedule   the minute sweep (pg_cron + pg_net), its secret kept in Vault
//   node scripts/stellar-deploy.mjs secrets    the STELLAR_* function secrets
//   node scripts/stellar-deploy.mjs deploy     the `stellar` function, then waits for its manifest
//   node scripts/stellar-deploy.mjs register   USDC trustline + 8004 registration, approved in your own wallet
//   node scripts/stellar-deploy.mjs check      provider-kit check and verifier check against the live manifest
//
// It asks for what it can't know: the payout address (a G... account of yours) and OpenZeppelin's mainnet
// facilitator API key (channels.openzeppelin.com/gen, GitHub sign-in). Both are kept in the ignored .env.local
// (mode 0600) and Supabase secrets; the key is never printed. No Stellar secret key is ever asked for:
// registration is signed in your wallet, on the page provider-kit opens.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { management } from './management.mjs';

const envPath = new URL('../.env.local', import.meta.url);
process.loadEnvFile(envPath);
const ref = process.env.SUPABASE_PROJECT_REF;
if (ref !== 'vqqbvydiehuwdzbgvmun') throw new Error('Unexpected project: refusing deployment');
const directory = fileURLToPath(new URL('../', import.meta.url));
const base = `https://${ref}.supabase.co/functions/v1/stellar`;
const manifestUrl = `${base}/.well-known/stellar-agent-services.json`;
const KIT = '@stellar-agent-services/provider-kit@0.1.0';
const VERIFIER = '@stellar-agent-services/verifier@0.1.0';
const MIGRATION = { version: '202611020001', name: 'stellar_services' };
const env = { ...process.env, npm_config_cache: '/private/tmp/algoria-npm-cache' };
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: directory,
    env,
    stdio: 'inherit',
    timeout: 600000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status})`);
  }
  return result;
}
const supabase = (args) => run('npx', ['--yes', 'supabase', ...args]);
/** The Stellar kit's CLIs get only what they need, never this project's API keys. */
const kitEnv = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'npm_config_cache']
    .filter((name) => env[name] !== undefined)
    .map((name) => [name, env[name]]),
);
const kit = (args, options = {}) => run('npx', ['--yes', ...args], { env: kitEnv, ...options });

/** Saves NAME=value in .env.local, replacing an earlier value, with the file kept at mode 0600. */
function save(name, value) {
  const lines = readFileSync(envPath, 'utf8').split('\n').filter((line) => !line.startsWith(`${name}=`));
  writeFileSync(envPath, `${lines.join('\n').trimEnd()}\n${name}=${value}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  process.env[name] = value;
  env[name] = value;
}

async function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo nothing while the key is typed or pasted.
    rl._writeToOutput = (text) => {
      if (text.startsWith(question)) process.stdout.write(question);
    };
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

/** The settings the function needs, asked for once and kept in .env.local. */
async function settings() {
  if (!process.env.STELLAR_NETWORK) save('STELLAR_NETWORK', 'stellar:pubnet');
  if (!process.env.STELLAR_PAY_TO) {
    const payTo = await ask('Stellar mainnet payout address (G...), the account paid 1 USDC per call: ');
    if (!/^G[A-Z2-7]{55}$/.test(payTo)) throw new Error('A payout address is a G... account address');
    save('STELLAR_PAY_TO', payTo);
  }
  if (!process.env.STELLAR_FACILITATOR_AUTH && process.env.STELLAR_NETWORK === 'stellar:pubnet') {
    console.log(
      'OpenZeppelin settles mainnet payments. Get an API key at https://channels.openzeppelin.com/gen',
    );
    const key = await ask('OpenZeppelin facilitator API key (hidden): ', { hidden: true });
    if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(key)) throw new Error('That does not look like an API key');
    save('STELLAR_FACILITATOR_AUTH', `Bearer ${key.replace(/^Bearer\s+/i, '')}`);
  }
  if (!process.env.STELLAR_RPC_URL && process.env.STELLAR_NETWORK === 'stellar:pubnet') {
    // The RPC the Stellar 8004 SDK uses. For production traffic, an RPC provider's URL is safer.
    save('STELLAR_RPC_URL', 'https://mainnet.sorobanrpc.com');
  }
  if (!process.env.STELLAR_SWEEP_SECRET) save('STELLAR_SWEEP_SECRET', randomBytes(32).toString('base64url'));
}

/**
 * Before anything changes: the facilitator takes the API key and settles this network with sponsored
 * fees, and the payout account exists with XLM for the USDC trustline's reserve and the registration fees.
 */
async function preflight() {
  const network = process.env.STELLAR_NETWORK;
  const mainnet = network === 'stellar:pubnet';
  const facilitator = (process.env.STELLAR_FACILITATOR_URL ||
    (mainnet ? 'https://channels.openzeppelin.com/x402' : 'https://www.x402.org/facilitator')).replace(
      /\/+$/,
      '',
    );
  const supported = await fetch(`${facilitator}/supported`, {
    headers: {
      Accept: 'application/json',
      ...(process.env.STELLAR_FACILITATOR_AUTH
        ? { Authorization: process.env.STELLAR_FACILITATOR_AUTH }
        : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (supported.status === 401 || supported.status === 403) {
    throw new Error(
      'The facilitator refused the API key: get a new one at https://channels.openzeppelin.com/gen, ' +
        'put it in .env.local as STELLAR_FACILITATOR_AUTH="Bearer <key>" and run this again',
    );
  }
  const kinds = supported.ok ? (await supported.json()).kinds ?? [] : [];
  const kind = kinds.find((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === network);
  if (!kind || kind.extra?.areFeesSponsored !== true) {
    throw new Error(
      `The facilitator (${supported.status}) does not settle sponsored "exact" payments on ${network}`,
    );
  }
  console.log(`✓ The facilitator takes the key and settles ${network}.`);

  const horizon = mainnet ? 'https://horizon.stellar.org' : 'https://horizon-testnet.stellar.org';
  const payTo = process.env.STELLAR_PAY_TO;
  const response = await fetch(`${horizon}/accounts/${payTo}`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) {
    throw new Error(`${payTo} does not exist on ${network} yet: send it a few XLM first`);
  }
  if (!response.ok) throw new Error(`Horizon answered ${response.status} for ${payTo}`);
  const account = await response.json();
  const xlm = Number(account.balances.find((b) => b.asset_type === 'native')?.balance ?? 0);
  const usdc = account.balances.find((b) =>
    b.asset_code === 'USDC' &&
    b.asset_issuer === (mainnet
        ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
        : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
  );
  // Each subentry, such as the USDC trustline, locks 0.5 XLM on top of the account's own 1 XLM.
  const reserve = (2 + account.subentry_count + (usdc ? 0 : 1) + (account.num_sponsoring ?? 0) -
    (account.num_sponsored ?? 0)) * 0.5;
  const spare = xlm - reserve;
  console.log(
    `✓ ${payTo}: ${xlm} XLM, ${usdc ? `USDC trustline (${usdc.balance} USDC)` : 'no USDC trustline yet'}`,
  );
  if (spare < 1) {
    console.log(
      `! Only ${spare.toFixed(2)} XLM would be left for fees once the trustline's reserve is locked. ` +
        'Send it a few more XLM before approving the registration in your wallet.',
    );
  }
}

async function migrate() {
  const history = await management('database/query', {
    query: `select version from supabase_migrations.schema_migrations where version = '${MIGRATION.version}'`,
  });
  if (history.length) return console.log('✓ Stellar provider tables already migrated.');
  const sql = readFileSync(
    new URL(`../supabase/migrations/${MIGRATION.version}_${MIGRATION.name}.sql`, import.meta.url),
    'utf8',
  );
  await management('database/query', {
    query: `begin; ${sql}
      insert into supabase_migrations.schema_migrations(version, statements, name)
      values ('${MIGRATION.version}', array[${quote(sql)}], '${MIGRATION.name}');
      notify pgrst, 'reload schema';
      commit;`,
  });
  console.log('✓ Stellar provider tables migrated, with CLI migration history.');
}

async function schedule() {
  const secret = process.env.STELLAR_SWEEP_SECRET;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret ?? '')) throw new Error('Invalid STELLAR_SWEEP_SECRET');
  // Vault holds the secret; cron history never includes its value.
  const query = `begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $block$ declare existing uuid; begin
  select id into existing from vault.secrets where name = 'algoria_stellar_sweep';
  if existing is null then perform vault.create_secret(${quote(secret)}, 'algoria_stellar_sweep');
  else perform vault.update_secret(existing, ${quote(secret)}); end if;
end $block$;
select cron.schedule('algoria-stellar-sweep', '* * * * *', $cron$
  select net.http_post(
    url := '${base}/internal/sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'algoria_stellar_sweep'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 110000
  );
$cron$);
commit;`;
  try {
    await management('database/query', { query }, true);
  } catch {
    throw new Error('Sweep scheduling failed; details withheld because the query contains a credential.');
  }
  console.log('✓ Sweep scheduled every minute: reconciliation, stuck calls and retention.');
}

function secrets() {
  const names = [
    'STELLAR_NETWORK',
    'STELLAR_PAY_TO',
    'STELLAR_AGENT_ID',
    'STELLAR_FACILITATOR_URL',
    'STELLAR_FACILITATOR_AUTH',
    'STELLAR_RPC_URL',
    'STELLAR_PUBLIC_BASE_URL',
    'STELLAR_PHONE_PRICE_USDC',
    'STELLAR_PHONE_CONCURRENCY',
    'STELLAR_PHONE_CALLS_PER_NUMBER',
    'STELLAR_SWEEP_SECRET',
    // Shared with the demo API's phone.call; set again so this function can start on its own.
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'OPENAI_API_KEY',
    'PHONE_CALL_REALTIME_MODEL',
    'PHONE_CALL_VOICE',
  ];
  for (
    const name of [
      'STELLAR_NETWORK',
      'STELLAR_PAY_TO',
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'OPENAI_API_KEY',
    ]
  ) {
    if (!process.env[name]) throw new Error(`Missing ${name} in .env.local`);
  }
  mkdirSync(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
  const path = new URL('../.local/stellar-deploy.env', import.meta.url);
  writeFileSync(
    path,
    names.filter((name) => process.env[name]).map((name) => `${name}=${process.env[name]}`).join('\n') + '\n',
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  supabase(['secrets', 'set', '--project-ref', ref, '--env-file', fileURLToPath(path)]);
  console.log('✓ Function secrets set (values not printed).');
}

async function manifest() {
  const response = await fetch(manifestUrl, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`manifest answered ${response.status}`);
  return response.json();
}

async function deploy() {
  supabase(['functions', 'deploy', 'stellar', '--project-ref', ref, '--use-api', '--no-verify-jwt']);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const served = await manifest();
      const payTo = served.payment?.accepts?.[0]?.payTo;
      const agentId = process.env.STELLAR_AGENT_ID ? Number(process.env.STELLAR_AGENT_ID) : undefined;
      if (payTo === process.env.STELLAR_PAY_TO && served.provider?.agentId === agentId) {
        console.log(`✓ Live: ${manifestUrl}`);
        console.log(`  ${served.provider.name}, ${served.payment.accepts[0].network}, paid to ${payTo}`);
        return served;
      }
    } catch {
      // Not serving the new version yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`The function deployed, but ${manifestUrl} does not serve the new settings yet`);
}

async function register() {
  // provider-kit opens a page on this computer where your wallet signs the USDC trustline (if missing) and
  // the Stellar 8004 registration of this manifest [I1]-[I3]. Connect the payout account itself.
  const work = new URL('../.local/stellar-launch/', import.meta.url);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  // launch saves AGENT_ID into this folder's .env, and only into one that exists.
  if (!existsSync(new URL('.env', work))) writeFileSync(new URL('.env', work), '', { mode: 0o600 });
  kit([
    KIT,
    'launch',
    '--manifest',
    manifestUrl,
    '--no-validation',
    ...(process.env.STELLAR_RPC_URL ? ['--rpc', process.env.STELLAR_RPC_URL] : []),
  ], { cwd: fileURLToPath(work) });
  // launch saves the agent id in the .env of the folder it ran in.
  const saved = existsSync(new URL('.env', work)) ? readFileSync(new URL('.env', work), 'utf8') : '';
  const agentId = /^AGENT_ID=(\d+)$/m.exec(saved)?.[1];
  if (!agentId) {
    throw new Error('No agent id was saved: run `node scripts/stellar-deploy.mjs register` again');
  }
  if (process.env.STELLAR_AGENT_ID !== agentId) {
    save('STELLAR_AGENT_ID', agentId);
    // The manifest names its agent [I2].
    await secrets();
    await deploy();
  }
  console.log(`✓ Registered as Stellar 8004 agent ${agentId}: Stellar Agent Search can find it.`);
}

function check() {
  const rpc = process.env.STELLAR_RPC_URL ? ['--rpc', process.env.STELLAR_RPC_URL] : [];
  kit([KIT, 'check', '--manifest', manifestUrl, ...rpc]);
  kit([VERIFIER, 'check', manifestUrl, ...rpc]);
}

const actions = { preflight, migrate, schedule, secrets, deploy, register, check };
const action = process.argv[2];
if (action === undefined) {
  await settings();
  await preflight();
  await migrate();
  await schedule();
  await secrets();
  await deploy();
  if (!process.env.STELLAR_AGENT_ID) await register();
  check();
} else if (action in actions) {
  await settings();
  await actions[action]();
} else {
  throw new Error(`Usage: node scripts/stellar-deploy.mjs [${Object.keys(actions).join('|')}]`);
}
