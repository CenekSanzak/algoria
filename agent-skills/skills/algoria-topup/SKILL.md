---
name: algoria-topup
description: Buy testnet USDC with Turkish lira through the TR mock anchor, so the wallet can pay for Algoria services. Opens a deposit, gives the user an IBAN, a reference and a payment link, then confirms the USDC arrived. Use when the user has no USDC or not enough of it, wants to add funds, asks about TRY, lira, a bank transfer, or a top-up.
---

# Algoria top-up

Mock Turkish lira in, testnet USDC out, through
[tr-mock-anchor.fly.dev](https://tr-mock-anchor.fly.dev) over SEP-6.

It is a sandbox: no real bank, no real lira, no mainnet. The USDC that arrives
is real testnet USDC, which is worth nothing. Say that to the user once — never
describe any of this as money.

Requires a funded testnet wallet with a USDC trustline. If there is none, run
`algoria-wallet`'s `onboard` first; this skill will say so and stop.

## The flow

It is two steps because a bank transfer is two steps.

```bash
node scripts/topup.mjs start --try 200
```

Opens a deposit and prints an IBAN, an amount and a reference. **Nothing has
been paid at this point.** Show the user all three, plus the deposit page link.
In the sandbox, the page has a "Simulate incoming TRY transfer" button that
stands in for their bank.

**Never press that button for them.** Sending the money is the user's decision;
this skill has no command that does it.

```bash
node scripts/topup.mjs status --wait
```

Follows the deposit until the USDC lands, then reports the amount received, the
fee, the new balance and the transaction hash. Without `--wait` it checks once.

## Commands

All take `--json`. The network is testnet; the anchor does not exist on pubnet.

| Command | What it does |
| --- | --- |
| `start --try <amount>` | open a deposit, print the bank details to pay |
| `status [--wait]` | check, or follow, the deposit that is open |
| `history` | every deposit this wallet has opened at the anchor |

Useful flags: `--id <deposit>` to pick one explicitly, `--timeout <seconds>` for
how long `--wait` polls (default 180), `--new` to open a second deposit while
one is still unpaid.

## Amounts

`--try 200` is **200 mock lira, not 200 USDC.** At the current rate 200 TRY is
about 4 USDC, and an Algoria image costs 0.01, so one top-up covers a long
session. Limits come from the anchor live, currently 50–3000 TRY; do not repeat
those numbers as a fixed rule, and never quote a USDC amount as exact before it
settles — the anchor prices at settlement.

## Never charge twice

The whole design is about this one risk.

- The deposit id is written to `~/.algoria/anchor.json` before the user pays.
- `start` refuses to open a second deposit while one is still unpaid.
- If the local record is lost, `status` looks the deposit up at the anchor.
  **A lost id is a reason to search, never a reason to start again.**
- If a call times out, check `status` first. A timeout does not mean the money
  did not move.

## Reading a status

`completed` is the only success. `pending_user_transfer_start` means the user
has not paid yet. `pending_anchor` and `pending_stellar` mean it is in flight —
keep polling. `error`, `refunded` and `expired` are final failures. Anything
unrecognised is not success.

`pending_trust` means the trustline went missing; fix it with
`wallet.mjs trustline` and keep the **same** deposit.

Do not say the top-up is done until `status` reports `completed` **and** shows
the balance. The skill checks Horizon itself, so the balance in its output is
the wallet's, not the anchor's claim about it.
