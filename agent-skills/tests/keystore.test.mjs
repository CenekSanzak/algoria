/**
 * Keystore behaviour. ALGORIA_HOME is redirected to a temp directory for the
 * whole file, so these tests can never read or write a real wallet.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'algoria-keystore-'));
process.env.ALGORIA_HOME = home;

const { algoriaHome, deleteWallet, ensureWallet, getWallet, importWallet, listWallets, readKeystore, unlockWallet, walletPath } =
  await import('../lib/stellar/keystore.mjs');
const { generateKeypair } = await import('../lib/stellar/keypair.mjs');

const PASSPHRASE = 'correct horse battery staple';

afterAll(() => rm(home, { recursive: true, force: true }));
beforeEach(() => rm(walletPath(), { force: true }));

describe('auto-creation', () => {
  it('treats a missing file as an empty keystore rather than an error', async () => {
    expect(await readKeystore()).toEqual({ version: 2, wallets: {} });
    expect(await listWallets()).toEqual([]);
    expect(await getWallet('testnet')).toBeNull();
  });

  it('creates a testnet wallet on first use, unencrypted', async () => {
    const { entry, created } = await ensureWallet({ network: 'testnet' });
    expect(created).toBe(true);
    expect(entry.encrypted).toBe(false);
    expect(entry.secretSeed).toMatch(/^S/);
    expect(entry.publicKey).toMatch(/^G/);
  });

  it('is idempotent: the second call returns the same key and says created:false', async () => {
    const first = await ensureWallet({ network: 'testnet' });
    const second = await ensureWallet({ network: 'testnet' });
    expect(second.created).toBe(false);
    expect(second.entry.publicKey).toBe(first.entry.publicKey);
  });

  it('keeps one wallet per network in a single file', async () => {
    await ensureWallet({ network: 'testnet' });
    await ensureWallet({ network: 'pubnet', passphrase: PASSPHRASE });

    const wallets = await listWallets();
    expect(wallets.map((wallet) => wallet.network)).toEqual(['testnet', 'pubnet']);
    expect(wallets[0].publicKey).not.toBe(wallets[1].publicKey);
  });

  it('writes an owner-only file and directory', async () => {
    await ensureWallet({ network: 'testnet' });
    expect((await stat(walletPath())).mode & 0o777).toBe(0o600);
    expect((await stat(algoriaHome())).mode & 0o777).toBe(0o700);
  });

  it('leaves no temp file behind after an atomic write', async () => {
    await ensureWallet({ network: 'testnet' });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(algoriaHome())).filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});

describe('custody differs by network', () => {
  it('stores a testnet seed in the clear, so the agent is never blocked', async () => {
    const { entry } = await ensureWallet({ network: 'testnet' });
    const onDisk = await readFile(walletPath(), 'utf8');
    expect(onDisk).toContain(entry.secretSeed);

    const unlocked = await unlockWallet('testnet', null);
    expect(unlocked.keypair.publicKey).toBe(entry.publicKey);
  });

  it('refuses to create a pubnet wallet without a passphrase', async () => {
    await expect(ensureWallet({ network: 'pubnet' })).rejects.toThrow(/must be encrypted/);
    expect(await listWallets()).toEqual([]);
  });

  it('encrypts a pubnet seed and keeps it off disk in plaintext', async () => {
    const { entry } = await ensureWallet({ network: 'pubnet', passphrase: PASSPHRASE });
    expect(entry.encrypted).toBe(true);
    expect(entry.secretSeed).toBeNull();

    const unlocked = await unlockWallet('pubnet', PASSPHRASE);
    const onDisk = await readFile(walletPath(), 'utf8');
    expect(onDisk).not.toContain(unlocked.keypair.secretSeed);
  });

  it('rejects a wrong or missing passphrase on pubnet', async () => {
    await ensureWallet({ network: 'pubnet', passphrase: PASSPHRASE });
    await expect(unlockWallet('pubnet', 'not the passphrase')).rejects.toThrow(/wrong passphrase/);
    await expect(unlockWallet('pubnet', null)).rejects.toThrow(/passphrase is required/);
  });

  it('refuses a short passphrase', async () => {
    await expect(ensureWallet({ network: 'pubnet', passphrase: 'short' })).rejects.toThrow(/at least 8/);
  });
});

describe('tamper detection', () => {
  it('detects a swapped public key, which GCM alone would not catch', async () => {
    await ensureWallet({ network: 'pubnet', passphrase: PASSPHRASE });
    const keystore = JSON.parse(await readFile(walletPath(), 'utf8'));
    keystore.wallets.pubnet.publicKey = generateKeypair().publicKey;
    await writeFile(walletPath(), JSON.stringify(keystore));

    await expect(unlockWallet('pubnet', PASSPHRASE)).rejects.toThrow(/does not match its seed/);
  });

  it('detects a tampered ciphertext', async () => {
    await ensureWallet({ network: 'pubnet', passphrase: PASSPHRASE });
    const keystore = JSON.parse(await readFile(walletPath(), 'utf8'));
    const ciphertext = keystore.wallets.pubnet.crypto.ciphertext;
    keystore.wallets.pubnet.crypto.ciphertext = `${ciphertext[0] === 'a' ? 'b' : 'a'}${ciphertext.slice(1)}`;
    await writeFile(walletPath(), JSON.stringify(keystore));

    await expect(unlockWallet('pubnet', PASSPHRASE)).rejects.toThrow(/wrong passphrase|modified/);
  });

  it('refuses a keystore written by a future version', async () => {
    await writeFile(walletPath(), JSON.stringify({ version: 99, wallets: {} }));
    await expect(readKeystore()).rejects.toThrow(/unsupported wallet file version 99/);
  });
});

describe('import', () => {
  it('adopts an existing seed', async () => {
    const keypair = generateKeypair();
    const entry = await importWallet({ network: 'testnet', secretSeed: keypair.secretSeed });
    expect(entry.publicKey).toBe(keypair.publicKey);
  });

  it('never silently replaces an existing wallet', async () => {
    const first = await ensureWallet({ network: 'testnet' });
    await expect(
      importWallet({ network: 'testnet', secretSeed: generateKeypair().secretSeed })
    ).rejects.toThrow(/already exists/);

    const unchanged = await getWallet('testnet');
    expect(unchanged?.publicKey).toBe(first.entry.publicKey);
  });

  it('replaces only when asked', async () => {
    await ensureWallet({ network: 'testnet' });
    const replacement = generateKeypair();
    const entry = await importWallet({
      network: 'testnet',
      secretSeed: replacement.secretSeed,
      replace: true
    });
    expect(entry.publicKey).toBe(replacement.publicKey);
  });

  it('refuses an unencrypted pubnet import', async () => {
    await expect(
      importWallet({ network: 'pubnet', secretSeed: generateKeypair().secretSeed })
    ).rejects.toThrow(/must be encrypted/);
  });

  it('rejects a malformed seed before writing anything', async () => {
    await expect(importWallet({ network: 'testnet', secretSeed: 'not-a-seed' })).rejects.toThrow();
    expect(await listWallets()).toEqual([]);
  });
});

describe('deletion', () => {
  it('removes one network and leaves the other alone', async () => {
    await ensureWallet({ network: 'testnet' });
    await ensureWallet({ network: 'pubnet', passphrase: PASSPHRASE });

    expect(await deleteWallet('testnet')).toBe(true);
    expect((await listWallets()).map((wallet) => wallet.network)).toEqual(['pubnet']);
  });

  it('reports when there was nothing to delete', async () => {
    expect(await deleteWallet('testnet')).toBe(false);
  });
});
