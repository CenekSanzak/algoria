/**
 * The local keystore.
 *
 * One file, `~/.algoria/wallet.json`, owner-readable only, holding at most one
 * wallet per network. It is created on first use rather than by a separate
 * command: an agent that needs an address should get one, not a prompt.
 *
 * Custody differs by network on purpose.
 *
 * A testnet seed is stored in the clear. It protects nothing — testnet assets
 * have no value — and a passphrase there would buy no security while blocking
 * the agent mid-flow on a question only a human can answer.
 *
 * A pubnet seed is encrypted with AES-256-GCM under a scrypt-stretched
 * passphrase, always. Real money is worth the interruption.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromSecretSeed, generateKeypair } from './keypair.mjs';
import { NETWORKS, resolveNetwork } from './network.mjs';

export const KEYSTORE_VERSION = 2;

/** Deliberately slow. ~0.5s on a laptop, which is the point. */
const SCRYPT = { N: 65536, r: 8, p: 1, dklen: 32, maxmem: 192 * 1024 * 1024 };

/** @returns {string} */
export function algoriaHome() {
  return process.env.ALGORIA_HOME || join(homedir(), '.algoria');
}

/** @returns {string} */
export function walletPath() {
  return join(algoriaHome(), 'wallet.json');
}

/**
 * @typedef {object} WalletEntry
 * @property {string} network
 * @property {string} publicKey
 * @property {string} createdAt
 * @property {boolean} encrypted
 * @property {object | null} crypto
 * @property {string | null} secretSeed present only on an unencrypted testnet wallet
 */

/**
 * @typedef {object} WalletFile
 * @property {number} version
 * @property {Record<string, WalletEntry>} wallets
 */

/**
 * @param {string} passphrase
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function deriveKey(passphrase, salt) {
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, SCRYPT.dklen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });
}

/**
 * @param {string} secretSeed
 * @param {string} passphrase
 */
function encryptSeed(secretSeed, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(secretSeed, 'utf8'), cipher.final()]);
  return {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfparams: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, dklen: SCRYPT.dklen, salt: salt.toString('hex') },
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: cipher.getAuthTag().toString('hex')
  };
}

/**
 * @param {any} crypto
 * @param {string} passphrase
 * @returns {string}
 */
function decryptSeed(crypto, passphrase) {
  const salt = Buffer.from(crypto.kdfparams.salt, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), Buffer.from(crypto.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(crypto.tag, 'hex'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(crypto.ciphertext, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase, or the wallet file has been modified');
  }
}

/**
 * Read the whole keystore. A missing file is an empty keystore, not an error.
 * @returns {Promise<WalletFile>}
 */
export async function readKeystore() {
  let raw;
  try {
    raw = await readFile(walletPath(), 'utf8');
  } catch {
    return { version: KEYSTORE_VERSION, wallets: {} };
  }
  const parsed = JSON.parse(raw);
  if (parsed.version !== KEYSTORE_VERSION) {
    throw new Error(`unsupported wallet file version ${parsed.version} at ${walletPath()}`);
  }
  return parsed;
}

/**
 * Write the keystore atomically, so an interrupted write cannot leave a
 * truncated file where a seed used to be.
 * @param {WalletFile} keystore
 */
async function writeKeystore(keystore) {
  const home = algoriaHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => {});

  const target = walletPath();
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

/**
 * @param {string} network
 * @returns {Promise<WalletEntry | null>}
 */
export async function getWallet(network) {
  const profile = resolveNetwork(network);
  return (await readKeystore()).wallets[profile.id] ?? null;
}

/**
 * Every wallet that exists, in a stable network order.
 * @returns {Promise<WalletEntry[]>}
 */
export async function listWallets() {
  const keystore = await readKeystore();
  return Object.keys(NETWORKS)
    .map((network) => keystore.wallets[network])
    .filter((entry) => Boolean(entry));
}

/**
 * Get the wallet for a network, creating one if it does not exist yet.
 *
 * This is the function every command goes through. It returns `created` so the
 * caller can tell the user a new key was just generated, which is the one thing
 * about auto-creation that must never be silent.
 *
 * @param {object} options
 * @param {string} options.network
 * @param {string | null} [options.passphrase] required when creating on pubnet
 * @returns {Promise<{entry: WalletEntry, created: boolean}>}
 */
export async function ensureWallet({ network, passphrase = null }) {
  const profile = resolveNetwork(network);
  const keystore = await readKeystore();
  const existing = keystore.wallets[profile.id];
  if (existing) return { entry: existing, created: false };

  if (profile.realValue && !passphrase) {
    throw new Error(
      'a pubnet wallet must be encrypted. Set ALGORIA_WALLET_PASSPHRASE, pass --passphrase-file <path>, or run in a terminal.'
    );
  }
  if (passphrase !== null && String(passphrase).length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }

  const keypair = generateKeypair();
  /** @type {WalletEntry} */
  const entry = {
    network: profile.id,
    publicKey: keypair.publicKey,
    createdAt: new Date().toISOString(),
    encrypted: Boolean(passphrase),
    crypto: passphrase ? encryptSeed(keypair.secretSeed, passphrase) : null,
    secretSeed: passphrase ? null : keypair.secretSeed
  };

  keystore.wallets[profile.id] = entry;
  await writeKeystore(keystore);
  return { entry, created: true };
}

/**
 * Adopt an existing seed as the wallet for a network.
 * @param {object} options
 * @param {string} options.network
 * @param {string} options.secretSeed
 * @param {string | null} [options.passphrase]
 * @param {boolean} [options.replace] overwrite an existing wallet for that network
 * @returns {Promise<WalletEntry>}
 */
export async function importWallet({ network, secretSeed, passphrase = null, replace = false }) {
  const profile = resolveNetwork(network);
  const keystore = await readKeystore();

  if (keystore.wallets[profile.id] && !replace) {
    throw new Error(
      `a ${profile.id} wallet already exists (${keystore.wallets[profile.id].publicKey}). Pass --replace to overwrite it, after exporting the current seed.`
    );
  }
  if (profile.realValue && !passphrase) {
    throw new Error('a pubnet wallet must be encrypted: a passphrase is required');
  }
  if (passphrase !== null && String(passphrase).length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }

  const keypair = fromSecretSeed(secretSeed);
  /** @type {WalletEntry} */
  const entry = {
    network: profile.id,
    publicKey: keypair.publicKey,
    createdAt: new Date().toISOString(),
    encrypted: Boolean(passphrase),
    crypto: passphrase ? encryptSeed(keypair.secretSeed, passphrase) : null,
    secretSeed: passphrase ? null : keypair.secretSeed
  };

  keystore.wallets[profile.id] = entry;
  await writeKeystore(keystore);
  return entry;
}

/**
 * Unlock a wallet and return the full keypair. The only function here that
 * yields a secret; nothing in this package prints its result.
 *
 * @param {string} network
 * @param {string | null} passphrase
 * @returns {Promise<{entry: WalletEntry, keypair: import('./keypair.mjs').StellarKeypair}>}
 */
export async function unlockWallet(network, passphrase) {
  const profile = resolveNetwork(network);
  const entry = await getWallet(profile.id);
  if (!entry) throw new Error(`no ${profile.id} wallet yet. Run: wallet onboard --network ${profile.id}`);

  const seed = entry.encrypted
    ? decryptSeed(entry.crypto, requirePassphrase(passphrase, profile.id))
    : String(entry.secretSeed);

  const keypair = fromSecretSeed(seed);
  assertMatchesEntry(entry, keypair.publicKey);
  return { entry, keypair };
}

/**
 * @param {string | null} passphrase
 * @param {string} network
 * @returns {string}
 */
function requirePassphrase(passphrase, network) {
  if (!passphrase) throw new Error(`the ${network} wallet is encrypted: a passphrase is required`);
  return passphrase;
}

/**
 * The stored address must be the one the seed actually derives, or the file has
 * been tampered with in a way GCM alone would not catch (the public field is
 * outside the ciphertext).
 * @param {WalletEntry} entry
 * @param {string} derived
 */
function assertMatchesEntry(entry, derived) {
  const a = Buffer.from(entry.publicKey, 'utf8');
  const b = Buffer.from(derived, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error(`the ${entry.network} wallet is inconsistent: stored address does not match its seed`);
  }
}

/**
 * @param {string} network
 * @returns {Promise<boolean>} whether a wallet was removed
 */
export async function deleteWallet(network) {
  const profile = resolveNetwork(network);
  const keystore = await readKeystore();
  if (!keystore.wallets[profile.id]) return false;
  delete keystore.wallets[profile.id];
  await writeKeystore(keystore);
  return true;
}
