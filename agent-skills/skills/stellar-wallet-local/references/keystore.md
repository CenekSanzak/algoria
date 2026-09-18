# The Algoria keystore

Written for a user or reviewer who wants to know exactly what sits on disk.

## Location

```
~/.algoria/                 mode 0700
  wallets/                  mode 0700
    <name>.json             mode 0600
```

`ALGORIA_HOME` overrides the base directory, which is what the test suite uses
so that running the tests can never touch a real wallet.

## File format

```json
{
  "version": 1,
  "name": "main",
  "network": "pubnet",
  "publicKey": "G...",
  "createdAt": "2026-09-18T12:00:00.000Z",
  "encrypted": true,
  "crypto": {
    "cipher": "aes-256-gcm",
    "kdf": "scrypt",
    "kdfparams": { "N": 65536, "r": 8, "p": 1, "dklen": 32, "salt": "<hex>" },
    "iv": "<hex>",
    "ciphertext": "<hex>",
    "tag": "<hex>"
  },
  "secretSeed": null
}
```

On an unencrypted testnet wallet, `crypto` is `null` and `secretSeed` holds the
`S...` seed in plain text. That combination is refused on pubnet.

## Cryptography

The passphrase is stretched with scrypt (N=65536, r=8, p=1) into a 32-byte key,
using a fresh 16-byte random salt per wallet. The seed is encrypted with
AES-256-GCM under a fresh 12-byte random IV, and the GCM tag is stored
alongside. Decryption failure is reported as "wrong passphrase, or the keystore
file has been modified" because AES-GCM cannot tell those two apart, and
pretending otherwise would be misleading.

`publicKey` lives outside the ciphertext, so it is not authenticated by the GCM
tag. Every unlock therefore re-derives the address from the decrypted seed and
compares it, in constant time, to the stored one. A file whose stored address
has been swapped fails loudly instead of quietly signing for a different key.

## What an attacker with the file gets

**Encrypted wallet:** the network, the name, the creation time, and the public
address — all of which are public on the ledger anyway. Spending requires the
passphrase. The cost of guessing is the scrypt cost per attempt, so a weak
passphrase is the weak link, not the cipher.

**Unencrypted wallet:** the seed, and therefore the account. This is why it is
testnet-only.

## Key derivation

A Stellar secret seed *is* a 32-byte ed25519 private seed. `keypair.mjs`
generates it with `crypto.randomBytes(32)` and derives the public key through
Node's ed25519 implementation. There is no BIP-39 mnemonic and no derivation
path: this is a raw keypair, the same shape `stellar-sdk`'s `Keypair.random()`
produces, and it imports cleanly into Freighter, Lobstr, or any SEP-compliant
wallet.

`strkey.mjs` implements Stellar's base32 `StrKey` encoding directly — version
byte, 32-byte payload, CRC16-XModem checksum — so the scripts need no installed
dependency. `tests/strkey.test.mjs` cross-checks encoding, decoding, and key
derivation against `@stellar/stellar-sdk`, which is a devDependency and is never
loaded at runtime.

## Recovery

The seed is the only recovery material. There is no backup, no escrow, and no
"forgot passphrase" path — Algoria holds nothing that could restore a wallet.

```bash
node export-secret.mjs --name main --out ~/main-seed.txt
```

Store that seed the way you would store cash. To restore on another machine:

```bash
node import-wallet.mjs --name main --network pubnet --seed-file ~/main-seed.txt
```

## Deleting a wallet

Delete the file. `deleteWallet()` in `lib/stellar/keystore.mjs` does the same
thing programmatically. Neither performs a secure erase: on a
copy-on-write or flash-backed filesystem, remnants can survive. For a wallet
that held real value, treat full-disk encryption as the control that matters.
