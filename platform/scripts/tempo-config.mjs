// Explicit testnet-only setup. Never outputs a receiving key or HMAC secret.
import { randomBytes, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { management } from './management.mjs';
import { tempoSecretPlan } from './tempo-config-plan.mjs';

const envPath = new URL('../.env.local', import.meta.url);
process.loadEnvFile(envPath);
if (process.env.SUPABASE_PROJECT_REF !== 'vqqbvydiehuwdzbgvmun') throw new Error('Unexpected project');
const args = process.argv.slice(2);
if (!args.includes('--create-testnet-receiver') || args.some(x => !['--create-testnet-receiver', '--apply'].includes(x))) {
  throw new Error('Usage: node scripts/tempo-config.mjs --create-testnet-receiver [--apply]');
}
const remote = await management('secrets', undefined, true);
const currentSecret = remote.find(x => x.name === 'MPP_SECRET_KEY');
let secret = process.env.MPP_SECRET_KEY;
// Do not rotate a deployed secret: saved unpaid quotes are HMAC-bound to it.
if (currentSecret && (!secret || (currentSecret.digest ?? currentSecret.value)?.toLowerCase() !== createHash('sha256').update(secret).digest('hex'))) {
  throw new Error('Existing deployed MPP secret differs or is unavailable locally; refusing rotation');
}
if (!secret) secret = randomBytes(32).toString('base64url');
if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('Invalid local MPP secret');

const directory = new URL('../.local/', import.meta.url);
const walletPath = new URL('tempo-service-receiver.json', directory);
let wallet;
// Use the pinned companion SDK; no hand-written address cryptography.
const require = createRequire(new URL('../../native/tempo-signing-proof/package.json', import.meta.url));
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
if (existsSync(walletPath)) {
  wallet = JSON.parse(readFileSync(walletPath, 'utf8'));
  if (wallet.network !== 'eip155:42431' || wallet.testnetOnly !== true || privateKeyToAccount(wallet.privateKey).address !== wallet.address) {
    throw new Error('Invalid existing testnet receiver; refusing replacement');
  }
} else {
  if (process.env.TEMPO_IMAGE_RECIPIENT || remote.some(x => x.name === 'TEMPO_IMAGE_RECIPIENT')) {
    throw new Error('A receiver is already configured; refusing to replace it');
  }
  const privateKey = generatePrivateKey();
  wallet = { network: 'eip155:42431', testnetOnly: true, address: privateKeyToAccount(privateKey).address,
    privateKey, createdAt: new Date().toISOString(), note: 'Service receiver only; never send real funds.' };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(walletPath, JSON.stringify(wallet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
chmodSync(walletPath, 0o600);
if (process.env.TEMPO_IMAGE_RECIPIENT && process.env.TEMPO_IMAGE_RECIPIENT.toLowerCase() !== wallet.address.toLowerCase()) {
  throw new Error('Local receiver differs from saved wallet; refusing replacement');
}
const configuration = { TEMPO_IMAGE_RECIPIENT: wallet.address,
  TEMPO_IMAGE_PRICE_ATOMIC: '10000', MPP_SECRET_KEY: secret };
const secrets = tempoSecretPlan(wallet.address, secret, remote);
let contents = readFileSync(envPath, 'utf8');
for (const [name, value] of Object.entries(configuration)) {
  contents = contents.split('\n').filter(line => !line.startsWith(`${name}=`)).join('\n').trimEnd();
  contents += `\n${name}=${value}\n`;
}
writeFileSync(envPath, contents, { mode: 0o600 });
chmodSync(envPath, 0o600);
if (args.includes('--apply')) {
  await management('secrets', secrets, true);
}
console.log(JSON.stringify({ network: wallet.network, testnetOnly: true, recipient: wallet.address,
  price: '0.010000 test PathUSD', applied: args.includes('--apply'),
  receiverKey: 'Saved locally with mode 0600, ignored by Git; not sent to the backend',
  otherServerSecrets: 'Unchanged' }));
