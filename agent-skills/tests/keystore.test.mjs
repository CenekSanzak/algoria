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

const { assertValidName, deleteWallet, listWallets, readWallet, saveWallet, unlockWallet, walletPath, walletsDir } =
  await import('../lib/stellar/keystore.mjs');
const { generateKeypair } = await import('../lib/stellar/keypair.mjs');

const PASSPHRASE = 'correct horse battery staple';

afterAll(() => rm(home, { recursive: true, force: true }));

beforeEach(() => rm(walletsDir(), { recursive: true, force: true }));

describe('wallet names', () => {
  it('accepts sane names', () => {
    for (const name of ['main', 'a', 'my-wallet_2', '0x']) expect(assertValidName(name)).toBe(name);
  });

  it('rejects names that would escape the directory or confuse a listing', () => {
    for (const name of ['', '.', '..', '../evil', 'a/b', 'Main', 'with space', '-leading', 'x'.repeat(65)]) {
      expect(() => assertValidName(name)).toThrow(/wallet name/);
    }
  });
});

describe('saveWallet', () => {
  it('stores an encrypted wallet and unlocks it again', async () => {
    const keypair = generateKeypair();
    const { path, record } = await saveWallet({
      name: 'main',
      network: 'pubnet',
      keypair,
      passphrase: PASSPHRASE
    });

    expect(record.encrypted).toBe(true);
    expect(record.secretSeed).toBeNull();
    expect(record.publicKey).toBe(keypair.publicKey);

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).not.toContain(keypair.secretSeed);

    const unlocked = await unlockWallet('main', PASSPHRASE);
    expect(unlocked.keypair.secretSeed).toBe(keypair.secretSeed);
  });

  it('writes owner-only files', async () => {
    await saveWallet({ name: 'main', network: 'pubnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    expect((await stat(walletPath('main'))).mode & 0o777).toBe(0o600);
    expect((await stat(walletsDir())).mode & 0o777).toBe(0o700);
  });

  it('refuses an unencrypted pubnet wallet', async () => {
    await expect(
      saveWallet({ name: 'main', network: 'pubnet', keypair: generateKeypair(), passphrase: null })
    ).rejects.toThrow(/must be encrypted/);
  });

  it('allows an unencrypted testnet wallet but marks it', async () => {
    const { record } = await saveWallet({
      name: 'play',
      network: 'testnet',
      keypair: generateKeypair(),
      passphrase: null
    });
    expect(record.encrypted).toBe(false);
    expect(record.secretSeed).toMatch(/^S/);

    const unlocked = await unlockWallet('play', null);
    expect(unlocked.keypair.publicKey).toBe(record.publicKey);
  });

  it('refuses a short passphrase', async () => {
    await expect(
      saveWallet({ name: 'main', network: 'testnet', keypair: generateKeypair(), passphrase: 'short' })
    ).rejects.toThrow(/at least 8/);
  });

  it('never overwrites an existing wallet', async () => {
    const first = generateKeypair();
    await saveWallet({ name: 'main', network: 'testnet', keypair: first, passphrase: PASSPHRASE });
    await expect(
      saveWallet({ name: 'main', network: 'testnet', keypair: generateKeypair(), passphrase: PASSPHRASE })
    ).rejects.toThrow(/already exists/);

    const unlocked = await unlockWallet('main', PASSPHRASE);
    expect(unlocked.keypair.secretSeed).toBe(first.secretSeed);
  });
});

describe('unlockWallet', () => {
  it('rejects a wrong passphrase', async () => {
    await saveWallet({ name: 'main', network: 'pubnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    await expect(unlockWallet('main', 'not the passphrase')).rejects.toThrow(/wrong passphrase/);
  });

  it('requires a passphrase for an encrypted wallet', async () => {
    await saveWallet({ name: 'main', network: 'pubnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    await expect(unlockWallet('main', null)).rejects.toThrow(/passphrase is required/);
  });

  it('detects a swapped public key, which GCM alone would not catch', async () => {
    await saveWallet({ name: 'main', network: 'pubnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    const record = JSON.parse(await readFile(walletPath('main'), 'utf8'));
    record.publicKey = generateKeypair().publicKey;
    await writeFile(walletPath('main'), JSON.stringify(record));

    await expect(unlockWallet('main', PASSPHRASE)).rejects.toThrow(/does not match its seed/);
  });

  it('detects a tampered ciphertext', async () => {
    await saveWallet({ name: 'main', network: 'pubnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    const record = JSON.parse(await readFile(walletPath('main'), 'utf8'));
    const flipped = record.crypto.ciphertext[0] === 'a' ? 'b' : 'a';
    record.crypto.ciphertext = `${flipped}${record.crypto.ciphertext.slice(1)}`;
    await writeFile(walletPath('main'), JSON.stringify(record));

    await expect(unlockWallet('main', PASSPHRASE)).rejects.toThrow(/wrong passphrase|modified/);
  });
});

describe('listing and deletion', () => {
  it('returns an empty list before any wallet exists', async () => {
    expect(await listWallets()).toEqual([]);
  });

  it('lists wallets sorted by name and skips junk files', async () => {
    await saveWallet({ name: 'beta', network: 'testnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    await saveWallet({ name: 'alpha', network: 'pubnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    await writeFile(join(walletsDir(), 'notes.txt'), 'ignore me');
    await writeFile(join(walletsDir(), 'broken.json'), '{ not json');

    expect((await listWallets()).map((wallet) => wallet.name)).toEqual(['alpha', 'beta']);
  });

  it('reports a missing wallet clearly', async () => {
    await expect(readWallet('ghost')).rejects.toThrow(/no wallet named "ghost"/);
    await expect(deleteWallet('ghost')).rejects.toThrow(/no wallet named "ghost"/);
  });

  it('deletes a wallet', async () => {
    await saveWallet({ name: 'main', network: 'testnet', keypair: generateKeypair(), passphrase: PASSPHRASE });
    await deleteWallet('main');
    expect(await listWallets()).toEqual([]);
  });
});
