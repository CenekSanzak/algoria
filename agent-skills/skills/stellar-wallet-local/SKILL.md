---
name: stellar-wallet-local
description: Create and manage a local Stellar wallet on this machine — generate a keypair, encrypt it at rest, fund it on testnet, check balances, import or export a seed. Use when the user wants a Stellar wallet, an address to receive XLM or USDC, a funded testnet account, or a way to pay for Algoria services with x402.
---

# Local Stellar wallet

Creates and manages Stellar keypairs stored on the user's own machine, under
`~/.algoria/wallets`. The seed never leaves this computer: no Algoria server,
no API, no network call carries it. The only outbound requests are a Friendbot
faucet call on testnet and read-only Horizon balance lookups.

## Before anything else

**The network is never assumed.** `testnet` is play money; `pubnet` is real
money. If the user has not said which, ask. Do not guess, and do not default.

**Never print a secret seed unless the user asks for it in that turn.** The
scripts are built so that normal output contains no secret. Do not work around
that by reading the keystore file yourself.

## Commands

Run from this skill's `scripts/` directory (or prefix with
`${CLAUDE_PLUGIN_ROOT}/skills/stellar-wallet-local/scripts/`). Node 22+, no
install step, no dependencies.

### Create a wallet

```bash
node create-wallet.mjs --name main --network testnet --fund
```

- `--name` lowercase letters, digits, `-`, `_`
- `--network testnet|pubnet` required
- `--fund` Friendbot funding, testnet only
- `--no-passphrase` unencrypted, **testnet only**
- `--json` machine-readable output

Prints the address and the file path. It does not print the seed.

### Check a wallet

```bash
node show-wallet.mjs --name main
node list-wallets.mjs [--network testnet]
```

Public metadata plus live Horizon balances. No passphrase needed.

### Fund a testnet wallet

```bash
node fund-wallet.mjs --name main
```

Pubnet has no faucet. For a real wallet, give the user the address and let them
send XLM to it.

### Back up or move a seed

```bash
node export-secret.mjs --name main --out ~/main-seed.txt   # writes a 0600 file
node export-secret.mjs --name main --stdout                # prints the seed
```

Prefer `--out`. Use `--stdout` only when the user explicitly asks to see the
seed, and tell them it will stay in their scrollback and in this conversation.

### Import an existing seed

```bash
node import-wallet.mjs --name restored --network pubnet --seed-file ~/seed.txt
cat ~/seed.txt | node import-wallet.mjs --name restored --network pubnet --seed-stdin
```

## Passphrases

A passphrase is never a command-line argument — arguments leak through `ps` and
shell history. The scripts accept, in order: `--passphrase-file <path>`, the
`ALGORIA_WALLET_PASSPHRASE` environment variable, or an interactive prompt when
a terminal is attached.

When you run these scripts on the user's behalf and no terminal is attached,
ask the user to set `ALGORIA_WALLET_PASSPHRASE` or point at a passphrase file.
**Never invent a passphrase for them, and never put one in a command you show.**

A pubnet wallet must be encrypted; the scripts refuse otherwise. A lost
passphrase means a lost wallet — there is no recovery path, and saying so up
front is part of the job.

## Guardrails

- Refuse to create a pubnet wallet unencrypted.
- Never echo a seed into a summary, a commit message, or a file in the repo.
- Never copy a wallet file into a project directory.
- An existing wallet name is never overwritten; pick another name.
- Testnet assets have no value. Do not describe a testnet balance as funds.

## Reference

`references/keystore.md` — the on-disk format, the cryptography, what an
attacker with the file can and cannot do, and how recovery works.
