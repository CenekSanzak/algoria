---
name: algoria-topup
description: For paid tasks, check wallet balance before discovery; if empty, immediately open or reuse a funding link, verify credit, then resume the original task. The USDC funding flow for an Algoria wallet. Buys testnet USDC with mock Turkish lira through the TR mock anchor - opens a deposit, gives the user an IBAN, a reference and a payment link, then confirms the USDC arrived. Use whenever the user wants USDC - add, get, buy, fund with or top up USDC - or has too little of it, wants to add balance or funds, or mentions TRY, lira, a bank transfer or a top-up. Prefer this over the wallet's XLM faucet for any request about USDC.
---

# Algoria top-up

Mock Turkish lira in, testnet USDC out, through
[tr-mock-anchor.fly.dev](https://tr-mock-anchor.fly.dev) over SEP-6.

This is testnet, with no real bank transfer or real lira. Label the funding
handoff once, briefly: "Test ortamı; gerçek para göndermeyin." Keep the ordinary
product flow: insufficient balance → funding page → confirmed credit → original
task. Do not teach a simulation exercise, quote skill prompts, name internal
policies or explain why a skill requires the user to click something.

Requires a funded testnet wallet with a USDC trustline. If there is none, run
`algoria-wallet`'s `onboard` first; this skill will say so and stop.

## Running these commands

Resolve the script path once, then reuse it. This works in both Claude and Codex:

```bash
TOPUP="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/skills/algoria-topup/scripts/topup.mjs"
```

In Claude, `CLAUDE_PLUGIN_ROOT` is set for you. Otherwise resolve `PLUGIN_ROOT`
to the absolute directory two levels above this skill folder. Do not assume
the current working directory is the plugin root.

## The flow

For an explicit top-up request or insufficient funds during a paid task, create
or reuse an unpaid deposit now. Do not spend another turn asking whether to
prepare the link. Opening it does not transfer funds or authorize a larger
service budget. Keep the original brief, approved cap and any saved job IDs so
the user can finish funding and continue without repeating their request.

```bash
node "$TOPUP" start --try 200 --json
```

Use the user's requested TRY amount when provided; otherwise 200 mock TRY is
the default unpaid request. This is separate from the service spending cap.
The helper checks live anchor limits; if the amount is rejected, use its
reported limits rather than assuming a rate or retrying the same invalid
amount. Respect any user-specified funding limit. Existing pending deposits
take priority over opening a new one, even if their amount differs.

The result contains the IBAN, amount, reference and payment page. Nothing has
been paid yet. The user completes the funding interaction on that page; the
agent creates/checks the deposit and resumes the requested service afterwards.

**Always repeat the payment details in your own reply, in full.** Agent hosts
often collapse command output, so the user may never see what the script
printed. Your reply must contain, copied exactly, not summarised:

- the deposit page link (`payUrl`) — as a clickable link
- the IBAN
- the amount in TRY
- the reference, and that it must appear in the transfer description

Keep this handoff short, in the user's language. For example (replace every
placeholder with actual helper output):

> Bakiyen {balance} test USDC; devam etmek için yükleme gerekiyor.
> [Bakiye yükle]({payUrl}) — {amountTry} TRY.
> IBAN: {iban} · Açıklama: {reference}.
> Bağlantıdaki adımı tamamlayıp haber ver; ardından görselini oluşturacağım.
> Test ortamı; gerçek para göndermeyin.

Do not invent a payment link, bank details or exchange rate. Do not include
developer button names, skill filenames or instructions for simulating a user.
The external funding step is the reason work is waiting; explain that directly.

```bash
node "$TOPUP" status --id SAVED_DEPOSIT_ID --wait --timeout 45 --json
```

When the user says "tamam", "ok", "paid", or otherwise continues after this
handoff, check that same deposit immediately. Their message alone is not proof
of payment. The command reports the status and actual wallet balance. After
`completed` and sufficient USDC, continue the original task in this turn using
the already approved spending cap. Do not end with just "top-up successful" or
ask whether they still want the output. For an explicit top-up-only request,
report the credited amount and balance and finish.

If it is still waiting for the user, show the same link. If the anchor or chain
is processing it, continue bounded status checks and briefly report progress;
do not instruct the user to pay again. On timeout or failure, preserve the
deposit and report its actual state. Without `--wait`, status checks once.

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

`--try 200` is **200 mock lira, not 200 USDC.** Use the helper's `estimateUsdc`
only as an estimate. Limits and rates come from the anchor live; never promise
an exact USDC amount before settlement. A top-up does not raise the approved
service budget, and sufficient existing USDC does not require another deposit.

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
`algoria-wallet`'s `trustline` and keep the **same** deposit.

Do not say the top-up is done until `status` reports `completed` **and** shows
the balance. The skill checks Horizon itself, so the balance in its output is
the wallet's, not the anchor's claim about it.
