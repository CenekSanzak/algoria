/**
 * The runtime implements StrKey and ed25519 derivation itself so that a skill
 * script runs with no install step. That is only safe if it agrees with the
 * official SDK on every path, which is what these tests check.
 *
 * @stellar/stellar-sdk is a devDependency and is imported here only.
 */

import { describe, expect, it } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { encodePublicKey, encodeSecretSeed, decodePublicKey, decodeSecretSeed, isValidPublicKey, isValidSecretSeed } from '../plugins/algoria/lib/stellar/strkey.mjs';
import { fromSecretSeed, generateKeypair, publicKeyFromSeed } from '../plugins/algoria/lib/stellar/keypair.mjs';

describe('strkey', () => {
  it('encodes public keys the way the SDK does', () => {
    for (let i = 0; i < 50; i += 1) {
      const raw = Keypair.random().rawPublicKey();
      expect(encodePublicKey(raw)).toBe(StrKey.encodeEd25519PublicKey(raw));
    }
  });

  it('encodes secret seeds the way the SDK does', () => {
    for (let i = 0; i < 50; i += 1) {
      const raw = Keypair.random().rawSecretKey();
      expect(encodeSecretSeed(raw)).toBe(StrKey.encodeEd25519SecretSeed(raw));
    }
  });

  it('round-trips through decode', () => {
    const keypair = Keypair.random();
    expect(Buffer.from(decodePublicKey(keypair.publicKey()))).toEqual(keypair.rawPublicKey());
    expect(Buffer.from(decodeSecretSeed(keypair.secret()))).toEqual(keypair.rawSecretKey());
  });

  it('handles an all-zero payload', () => {
    const raw = new Uint8Array(32);
    expect(encodePublicKey(raw)).toBe(StrKey.encodeEd25519PublicKey(Buffer.from(raw)));
  });

  it('rejects a wrong version byte', () => {
    const keypair = Keypair.random();
    expect(() => decodePublicKey(keypair.secret())).toThrow(/version byte/);
    expect(() => decodeSecretSeed(keypair.publicKey())).toThrow(/version byte/);
  });

  it('rejects a corrupted checksum', () => {
    const address = Keypair.random().publicKey();
    const corrupted = `${address.slice(0, 55)}${address[55] === 'A' ? 'B' : 'A'}`;
    expect(() => decodePublicKey(corrupted)).toThrow(/checksum/);
    expect(isValidPublicKey(corrupted)).toBe(false);
  });

  it('rejects wrong lengths and invalid characters', () => {
    expect(() => decodePublicKey('GABC')).toThrow(/56 characters/);
    expect(isValidPublicKey(`${'1'.repeat(56)}`)).toBe(false);
    expect(isValidSecretSeed('')).toBe(false);
  });

  it('agrees with the SDK on a known vector', () => {
    // SEP-0023 test vector.
    const raw = Buffer.from('6f45ca0a26e6a6b5f0b99d1b5b0fa4f46e0e2c69a9a5d9bcd0a3fb7d09c2a5f1', 'hex');
    expect(encodePublicKey(raw)).toBe(StrKey.encodeEd25519PublicKey(raw));
    expect(decodePublicKey(encodePublicKey(raw))).toEqual(new Uint8Array(raw));
  });
});

describe('keypair', () => {
  it('derives the same public key as the SDK from a given seed', () => {
    for (let i = 0; i < 25; i += 1) {
      const sdkKeypair = Keypair.random();
      const derived = publicKeyFromSeed(new Uint8Array(sdkKeypair.rawSecretKey()));
      expect(Buffer.from(derived)).toEqual(sdkKeypair.rawPublicKey());
    }
  });

  it('generates keypairs the SDK accepts', () => {
    const keypair = generateKeypair();
    const sdkKeypair = Keypair.fromSecret(keypair.secretSeed);
    expect(sdkKeypair.publicKey()).toBe(keypair.publicKey);
  });

  it('restores a keypair from its secret seed', () => {
    const keypair = generateKeypair();
    expect(fromSecretSeed(keypair.secretSeed).publicKey).toBe(keypair.publicKey);
    expect(fromSecretSeed(` ${keypair.secretSeed}\n`).publicKey).toBe(keypair.publicKey);
  });

  it('refuses a malformed seed', () => {
    expect(() => fromSecretSeed('not-a-seed')).toThrow();
    expect(() => fromSecretSeed(generateKeypair().publicKey)).toThrow(/version byte/);
  });

  it('never produces the same key twice', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateKeypair().publicKey));
    expect(seen.size).toBe(200);
  });
});
