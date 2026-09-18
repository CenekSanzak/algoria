# The Algoria keystore

Written for a user or reviewer who wants to know exactly what sits on disk.

## Location

```
~/.algoria/              mode 0700
  wallet.json            mode 0600
```

One file holds at most one wallet per network. `ALGORIA_HOME` overrides the base
directory, which is what the test suite uses so that running the tests can never
touch a real wallet.

Writes go to a temp file and are renamed into place, so an interrupted write
cannot leave a truncated file where a seed used to be.

## File format

```json
{
  "version": 2,
  "wallets": {
    "testnet": {
      "network": "testnet",
      "publicKey": "G...",
      "createdAt": "2026-09-18T12:00:00.000Z",
      "encrypted": false,
      "crypto": null,
      "secretSeed": "S..."
    },
    "pubnet": {
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
  }
}
```

The two networks hold **different keys**. A pubnet wallet is not a testnet
wallet promoted; real money never shares a seed with play money.

## Why testnet is stored in the clear

A passphrase on a testnet seed protects nothing — the assets have no value — and
it costs the thing that makes an agent wallet usable: the agent would stop and
ask a human a question mid-task. So testnet trades a non-existent secret for a
flow that never blocks.

Pubnet makes the opposite trade, always. `ensureWallet` refuses to create a
pubnet wallet without a passphrase, and there is no flag to override it.

## Cryptography

The passphrase is stretched with scrypt (N=65536, r=8, p=1) into a 32-byte key,
using a fresh 16-byte random salt per wallet. The seed is encrypted with
AES-256-GCM under a fresh 12-byte random IV, and the GCM tag is stored alongside.
Decryption failure is reported as "wrong passphrase, or the wallet file has been
modified" because AES-GCM cannot tell those two apart, and pretending otherwise
would be misleading.

`publicKey` lives outside the ciphertext, so it is not authenticated by the GCM
tag. Every unlock therefore re-derives the address from the decrypted seed and
compares it, in constant time, to the stored one. A file whose stored address has
been swapped fails loudly instead of quietly signing for a different key.

## What an attacker with the file gets

**Pubnet entry:** the network, the creation time, and the public address — all
public on the ledger anyway. Spending requires the passphrase, at scrypt cost per
guess. A weak passphrase is the weak link, not the cipher.

**Testnet entry:** the seed, and therefore the testnet account. That is the
accepted trade, and it is why a testnet seed must never be reused on pubnet.

## Key derivation

A Stellar secret seed *is* a 32-byte ed25519 private seed. `keypair.mjs`
generates it with `crypto.randomBytes(32)` and derives the public key through
Node's ed25519 implementation. There is no BIP-39 mnemonic and no derivation
path: this is a raw keypair, the same shape `stellar-sdk`'s `Keypair.random()`
produces, and it imports cleanly into Freighter, Lobstr, or any SEP-compliant
wallet.

`strkey.mjs` implements Stellar's base32 StrKey encoding directly — version byte,
32-byte payload, CRC16-XModem checksum — so wallet creation, balance reads and
seed export need nothing installed. `tests/strkey.test.mjs` cross-checks every
path against `@stellar/stellar-sdk`.

The SDK *is* a runtime dependency, but only `trustline.mjs` loads it, and only
lazily: signing and submitting a `changeTrust` transaction needs real XDR. Every
other command still runs on a machine where `pnpm install` was never run.

## The USDC trustline

A Stellar account cannot hold USDC until it opts in with a `changeTrust`
operation. This has no equivalent on Base or Solana, where holding a token needs
no permission from the holder.

The asset is pinned per network:

| Network | Issuer | Contract (SAC) |
| --- | --- | --- |
| testnet | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `CBIELTK6…` |
| pubnet | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | `CCW67TSZ…` |

`tests/network.test.mjs` derives the contract id from the issuer and asserts it
equals the SAC the rest of Algoria pays in, so the two can never drift apart.

The trustline limit is left at the Stellar maximum on purpose. A trustline limit
caps what the account can *hold*, not what it can spend — it is not a safety
control, and a low one silently bounces incoming payments later.

## Recovery

The seed is the only recovery material. There is no backup, no escrow, and no
"forgot passphrase" path — Algoria holds nothing that could restore a wallet.

```bash
node scripts/wallet.mjs export --network pubnet --out ~/algoria-seed.txt
```

To restore on another machine:

```bash
node scripts/wallet.mjs import --network pubnet --seed-file ~/algoria-seed.txt
```

## Deleting a wallet

`forget --yes` removes the entry. It is not a secure erase: on a copy-on-write or
flash-backed filesystem, remnants can survive. For a wallet that held real value,
full-disk encryption is the control that matters.
