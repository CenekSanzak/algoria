/**
 * StrKey: Stellar's base32 address encoding (SEP-0023 / CAP-0027 base form).
 *
 * A key is `version byte || 32-byte payload || CRC16-XModem checksum`, base32
 * encoded. 35 bytes is exactly 56 base32 characters, so no padding is involved.
 *
 * This is implemented here rather than imported so a skill script runs with no
 * install step on the user's machine. `tests/strkey.test.mjs` cross-checks every
 * path against @stellar/stellar-sdk, which is a devDependency only.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Version bytes, pre-shifted the way Stellar defines them (value << 3). */
export const VERSION_BYTES = {
  ed25519PublicKey: 6 << 3, // 48  -> 'G'
  ed25519SecretSeed: 18 << 3 // 144 -> 'S'
};

/**
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function crc16xmodem(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    let code = (crc >>> 8) & 0xff;
    code ^= byte & 0xff;
    code ^= code >>> 4;
    crc = ((crc << 8) & 0xffff) ^ ((code << 12) & 0xffff) ^ ((code << 5) & 0xffff) ^ code;
    crc &= 0xffff;
  }
  return crc;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * @param {string} input
 * @returns {Uint8Array}
 */
function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of input) {
    const index = DECODE.get(char);
    if (index === undefined) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * @param {number} versionByte
 * @param {Uint8Array} payload 32 raw bytes
 * @returns {string}
 */
export function encodeStrKey(versionByte, payload) {
  if (payload.length !== 32) throw new Error(`expected a 32-byte payload, got ${payload.length}`);
  const body = new Uint8Array(33);
  body[0] = versionByte;
  body.set(payload, 1);
  const checksum = crc16xmodem(body);
  const full = new Uint8Array(35);
  full.set(body, 0);
  full[33] = checksum & 0xff; // little-endian
  full[34] = (checksum >>> 8) & 0xff;
  return base32Encode(full);
}

/**
 * @param {number} versionByte
 * @param {string} encoded
 * @returns {Uint8Array} the 32-byte payload
 */
export function decodeStrKey(versionByte, encoded) {
  if (typeof encoded !== 'string' || encoded.length !== 56) {
    throw new Error('invalid Stellar key: expected 56 characters');
  }
  const decoded = base32Decode(encoded);
  if (decoded.length !== 35) throw new Error('invalid Stellar key: wrong decoded length');
  if (decoded[0] !== versionByte) throw new Error('invalid Stellar key: wrong version byte');
  const body = decoded.subarray(0, 33);
  const expected = crc16xmodem(body);
  const actual = decoded[33] | (decoded[34] << 8);
  if (expected !== actual) throw new Error('invalid Stellar key: checksum mismatch');
  return body.subarray(1);
}

/** @param {Uint8Array} raw */
export const encodePublicKey = (raw) => encodeStrKey(VERSION_BYTES.ed25519PublicKey, raw);
/** @param {Uint8Array} raw */
export const encodeSecretSeed = (raw) => encodeStrKey(VERSION_BYTES.ed25519SecretSeed, raw);
/** @param {string} address */
export const decodePublicKey = (address) => decodeStrKey(VERSION_BYTES.ed25519PublicKey, address);
/** @param {string} secret */
export const decodeSecretSeed = (secret) => decodeStrKey(VERSION_BYTES.ed25519SecretSeed, secret);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidPublicKey(value) {
  try {
    decodePublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isValidSecretSeed(value) {
  try {
    decodeSecretSeed(value);
    return true;
  } catch {
    return false;
  }
}
