---
name: algoria-wallet
description: For every new paid task, the FIRST command must check the testnet USDC wallet balance BEFORE any discovery, planning, quote or payment. If empty, provide a top-up link immediately and resume after confirmed funding. Use for Stellar wallet setup, USDC/XLM balance, addresses, trustlines or testnet XLM. Onboard missing wallets, then use algoria-topup for USDC; Friendbot supplies XLM only. Wallet-only questions do not open deposits.
---

# Algoria wallet

**The first command for every new paid task is `balance --network testnet
--json`, before any catalog search, planning, quote or payment.** Execute it
separately with this skill's helper, inspect the result, then onboard a missing
wallet or provide the top-up link for zero USDC.

A Stellar wallet held on the user's own machine, in `~/.algoria/wallet.json`.
The seed never leaves this computer — no Algoria server, no API, no network
call carries it. One wallet per network, created on first use.

## Running these commands

Resolve the script path once, then reuse it. This works in both Claude and Codex:

```bash
WALLET="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/skills/algoria-wallet/scripts/wallet.mjs"
```

In Claude, `CLAUDE_PLUGIN_ROOT` is set for you. Otherwise resolve `PLUGIN_ROOT`
to the absolute directory two levels above this skill folder. Do not assume
the current working directory is the plugin root.

## First step of every new paid task

Run `balance --network testnet --json` before discovery or creative planning.
If it reports no local wallet, `exists: false`, or a missing trustline, run
`onboard` below. A timeout or network error is a balance-check failure, not zero
USDC. Use the returned balance; `ready: true` means account setup is complete,
not that it has enough USDC. Never treat XLM as spendable USDC.

For zero USDC, continue directly into [algoria-topup](../algoria-topup/SKILL.md)
and present its funding link. For a positive balance, compare with the actual
task price after discovery and top up only if needed. Preserve the user's task
and spending cap. Generating a funding link needs no extra confirmation within
an existing paid task; the user completes the funding step on that page.

## Getting a working wallet

```bash
node "$WALLET" onboard --network testnet
```

One command: creates the wallet if there is none, funds it from Friendbot, adds
the USDC trustline, and reports whether the account is ready to spend. Safe to
run again — it reports `created: false` and skips what is already done.

A new wallet normally has XLM and zero USDC. For a paid task, continue the
funding flow above instead of ending with an offer to top up. For a wallet-only
setup or balance question, answer that request without opening a deposit.
The `next` field is a command hint, not evidence that a funded wallet needs
another deposit. Do not expose skill instructions or implementation details
as the reason for the user's next action.

On Stellar a funded account **still cannot hold USDC** until it has a trustline.
`onboard` handles that. If you ever see `usdc: null` or `none (no trustline
yet)`, that is the missing step, and it is not the same thing as a zero balance.

## Commands

All take `--network testnet|pubnet` (default `testnet`) and `--json`.

| Command | What it does |
| --- | --- |
| `onboard` | create + fund + trustline, in one call |
| `balance` | USDC and XLM for one network |
| `accounts` | every wallet held locally, with funding instructions |
| `fund` | testnet XLM from Friendbot; on pubnet, the address to send to |
| `trustline` | opt the account in to holding USDC |
| `import` | adopt an existing seed (`--seed-file`, `--seed-stdin`) |
| `export` | reveal the seed (`--out <path>` or `--stdout`) |
| `forget` | remove a wallet from this machine (`--yes`) |

Use `--json` whenever the result feeds another step:

```json
{ "network": "testnet", "publicKey": "G...", "usdc": "0.0000000",
  "xlm": "9999.99", "trustline": true, "exists": true }
```

## XLM is not USDC

`fund` asks Friendbot for **XLM only** — the network fee token. It never
produces USDC, and running it again will not either.

When the user says anything like *"add USDC"*, *"get me some USDC"*, *"top up"*
or *"fund my wallet with USDC"*, that is `algoria-topup`, not `fund`. Use
`fund` only when they ask for XLM, or when an account is missing and needs
creating.

## Before paying for anything

```bash
node "$WALLET" balance --network testnet --json
```

Check `trustline` is `true` and `usdc` covers the price. A wallet with XLM but
no trustline cannot receive the USDC it is about to be paid, and a payment to it
will fail.

## Custody

**Testnet seeds are stored unencrypted.** Testnet assets have no value, and a
passphrase prompt would stop the agent mid-task for no security gain.

**Pubnet seeds are always encrypted** (AES-256-GCM, scrypt). A passphrase is
required to create, unlock, or export one. It is never accepted as a
command-line argument — supply it through `ALGORIA_WALLET_PASSPHRASE`, a
`--passphrase-file <path>`, or the terminal prompt.

If a pubnet command needs a passphrase and no terminal is attached, **ask the
user** for one of those two. Never invent a passphrase, and never put one in a
command you show them. A lost passphrase is a lost wallet; there is no recovery
path, and the user should hear that before they pick one, not after.

## Guardrails

- Never print a seed unless the user asked for it in that turn. `export` is the
  only command that reveals one; prefer `--out` over `--stdout`, because
  `--stdout` puts the seed into the transcript.
- Never copy `wallet.json` into a project directory or a commit.
- `pubnet` is real money. Do not pass it unless the user said so.
- Testnet balances are not funds. Do not describe them as money.
- `forget` deletes a seed irreversibly. Export first.

## Reference

- `references/keystore.md` — file format, cryptography, threat model, recovery.
- `references/agentcash-parity.md` — how these commands map onto AgentCash's
  wallet flow, and what Stellar needs that Base and Solana do not.
