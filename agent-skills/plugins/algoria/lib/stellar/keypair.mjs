/**
 * Ed25519 keypair creation for Stellar, on node:crypto only.
 *
 * A Stellar secret seed IS the 32-byte ed25519 private seed, so key generation
 * is `randomBytes(32)` plus the derivation of the matching public key. Node
 * exposes ed25519 through KeyObjects rather than raw bytes, so the seed is
 * wrapped in a minimal PKCS#8 envelope to get back in, and the raw public key
 * is read out of the SPKI export.
 */

import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { encodePublicKey, encodeSecretSeed, decodeSecretSeed } from './strkey.mjs';

/** PKCS#8 header for an ed25519 private key carrying a 32-byte seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** Length of the SPKI header that precedes the 32 raw public-key bytes. */
const SPKI_HEADER_LENGTH = 12;

/**
 * @typedef {object} StellarKeypair
 * @property {string} publicKey  G... address, safe to share
 * @property {string} secretSeed S... seed, never log or transmit this
 * @property {Uint8Array} rawSeed
 */

/**
 * @param {Uint8Array} rawSeed 32 bytes
 * @returns {Uint8Array} the 32 raw public-key bytes
 */
export function publicKeyFromSeed(rawSeed) {
  if (rawSeed.length !== 32) throw new Error(`expected a 32-byte seed, got ${rawSeed.length}`);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(rawSeed)]),
    format: 'der',
    type: 'pkcs8'
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Uint8Array.prototype.slice.call(spki, SPKI_HEADER_LENGTH);
}

/**
 * Generate a new random Stellar keypair.
 * @returns {StellarKeypair}
 */
export function generateKeypair() {
  const rawSeed = Uint8Array.prototype.slice.call(randomBytes(32));
  return fromRawSeed(rawSeed);
}

/**
 * @param {Uint8Array} rawSeed
 * @returns {StellarKeypair}
 */
export function fromRawSeed(rawSeed) {
  return {
    publicKey: encodePublicKey(publicKeyFromSeed(rawSeed)),
    secretSeed: encodeSecretSeed(rawSeed),
    rawSeed
  };
}

/**
 * Rebuild a keypair from an existing S... seed, validating its checksum.
 * @param {string} secretSeed
 * @returns {StellarKeypair}
 */
export function fromSecretSeed(secretSeed) {
  return fromRawSeed(decodeSecretSeed(secretSeed.trim()));
}
