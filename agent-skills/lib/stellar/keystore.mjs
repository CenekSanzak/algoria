/**
 * The local keystore.
 *
 * One wallet is one JSON file under `~/.algoria/wallets`, owner-readable only.
 * The secret seed is encrypted with AES-256-GCM under a scrypt-stretched
 * passphrase; the file therefore carries no usable key material on its own.
 *
 * A pubnet wallet must be encrypted. A testnet wallet may be stored in the
 * clear, because a testnet seed protects nothing, but it is marked as such in
 * the file and in every listing so it can never be mistaken for a real one.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromSecretSeed } from './keypair.mjs';
import { resolveNetwork } from './network.mjs';

export const KEYSTORE_VERSION = 1;

/** Deliberately slow. ~0.5s on a laptop, which is the point. */
const SCRYPT = { N: 65536, r: 8, p: 1, dklen: 32, maxmem: 192 * 1024 * 1024 };

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** @returns {string} */
export function algoriaHome() {
  return process.env.ALGORIA_HOME || join(homedir(), '.algoria');
}

/** @returns {string} */
export function walletsDir() {
  return join(algoriaHome(), 'wallets');
}

/**
 * @param {string} name
 * @returns {string}
 */
export function walletPath(name) {
  return join(walletsDir(), `${assertValidName(name)}.json`);
}

/**
 * @param {string} name
 * @returns {string}
 */
export function assertValidName(name) {
  const normalized = String(name ?? '').trim();
  if (!NAME_PATTERN.test(normalized)) {
    throw new Error(
      'wallet name must be lowercase letters, digits, "-" or "_", 1-64 characters, starting with a letter or digit'
    );
  }
  return normalized;
}

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
    throw new Error('wrong passphrase, or the keystore file has been modified');
  }
}

/**
 * @typedef {object} WalletRecord
 * @property {number} version
 * @property {string} name
 * @property {string} network
 * @property {string} publicKey
 * @property {string} createdAt
 * @property {boolean} encrypted
 * @property {object | null} crypto
 * @property {string | null} secretSeed present only on an unencrypted testnet wallet
 */

/**
 * Write a new wallet. Refuses to overwrite an existing file: losing a seed to a
 * name collision is not a recoverable mistake.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.network
 * @param {{publicKey: string, secretSeed: string}} options.keypair
 * @param {string | null} options.passphrase null stores the seed in the clear (testnet only)
 * @returns {Promise<{path: string, record: WalletRecord}>}
 */
export async function saveWallet({ name, network, keypair, passphrase }) {
  const walletName = assertValidName(name);
  const profile = resolveNetwork(network);

  if (profile.realValue && !passphrase) {
    throw new Error('a pubnet wallet must be encrypted: supply a passphrase');
  }
  if (passphrase !== null && String(passphrase).length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }
  if (await walletExists(walletName)) {
    throw new Error(`a wallet named "${walletName}" already exists at ${walletPath(walletName)}`);
  }

  /** @type {WalletRecord} */
  const record = {
    version: KEYSTORE_VERSION,
    name: walletName,
    network: profile.id,
    publicKey: keypair.publicKey,
    createdAt: new Date().toISOString(),
    encrypted: Boolean(passphrase),
    crypto: passphrase ? encryptSeed(keypair.secretSeed, passphrase) : null,
    secretSeed: passphrase ? null : keypair.secretSeed
  };

  await mkdir(walletsDir(), { recursive: true, mode: 0o700 });
  await chmod(algoriaHome(), 0o700).catch(() => {});
  await chmod(walletsDir(), 0o700).catch(() => {});

  const path = walletPath(walletName);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);

  return { path, record };
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function walletExists(name) {
  try {
    await readFile(walletPath(name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a wallet's public metadata. Never touches the secret.
 * @param {string} name
 * @returns {Promise<WalletRecord>}
 */
export async function readWallet(name) {
  const path = walletPath(name);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`no wallet named "${name}" at ${path}`);
  }
  const record = JSON.parse(raw);
  if (record.version !== KEYSTORE_VERSION) {
    throw new Error(`unsupported keystore version ${record.version}`);
  }
  return record;
}

/**
 * @returns {Promise<WalletRecord[]>}
 */
export async function listWallets() {
  let entries;
  try {
    entries = await readdir(walletsDir());
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      records.push(await readWallet(entry.slice(0, -'.json'.length)));
    } catch {
      // A corrupt or foreign file is skipped, not fatal to the listing.
    }
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Unlock a wallet and return the full keypair.
 *
 * The caller owns what happens next: this is the only function that yields a
 * secret, and nothing in this package prints its result.
 *
 * @param {string} name
 * @param {string | null} passphrase
 * @returns {Promise<{record: WalletRecord, keypair: import('./keypair.mjs').StellarKeypair}>}
 */
export async function unlockWallet(name, passphrase) {
  const record = await readWallet(name);
  if (record.encrypted) {
    if (!passphrase) throw new Error(`wallet "${name}" is encrypted: a passphrase is required`);
    const keypair = fromSecretSeed(decryptSeed(record.crypto, passphrase));
    assertMatchesRecord(record, keypair.publicKey);
    return { record, keypair };
  }
  const keypair = fromSecretSeed(String(record.secretSeed));
  assertMatchesRecord(record, keypair.publicKey);
  return { record, keypair };
}

/**
 * The stored address must be the one the seed actually derives, or the file has
 * been tampered with in a way GCM alone would not catch (the public field is
 * outside the ciphertext).
 * @param {WalletRecord} record
 * @param {string} derived
 */
function assertMatchesRecord(record, derived) {
  const a = Buffer.from(record.publicKey, 'utf8');
  const b = Buffer.from(derived, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error(`keystore for "${record.name}" is inconsistent: stored address does not match its seed`);
  }
}

/**
 * @param {string} name
 * @returns {Promise<string>} the removed path
 */
export async function deleteWallet(name) {
  const path = walletPath(name);
  await readWallet(name);
  await rm(path);
  return path;
}
