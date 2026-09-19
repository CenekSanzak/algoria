---
name: algoria-pay
description: Execute and recover paid Algoria jobs using the local Stellar testnet wallet over x402. Use after discovering a service for a requested image, narration, video or other supported result, or when resuming a saved job. Run the payment commands yourself as part of fulfilling the user's request; the user does not need to name this skill or type algoria pay. If no service has been selected yet, first use algoria-discover.
---

# Pay and execute an Algoria service

Use current metadata from `algoria-discover`. The helper only permits Algoria's
pinned API, sponsored x402 v2 exact payments, and testnet USDC. Secrets stay in
the local wallet; no Supabase/fal credentials or browser login are needed.

For a natural request such as "bana video üret", load
[algoria-discover](../algoria-discover/SKILL.md) first if a service/plan has not
yet been selected. These CLI commands are helpers for you to execute, not steps
to hand back to the user. Continue through generation and media delivery after
payment. Reuse prior authorization for the same task and budget.

In Claude use `CLAUDE_PLUGIN_ROOT`. Otherwise resolve the absolute plugin root
from this file's location (two directories above its folder) as `PLUGIN_ROOT`.

```bash
PAY="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/skills/algoria-pay/scripts/pay.mjs"
```

## Budget, quote, execute

Use the user's authorized total and per-call limits. Do not choose a spending
budget on their behalf; earlier explicit authorization for this work persists.
A wallet top-up alone does not authorize service spending. Testnet USDC has no
real monetary value, but generation consumes backend capacity.

```bash
# Example amounts only; replace with the user's approved limits.
node "$PAY" budget --name project --total 0.09 --per-call 0.02 --json
node "$PAY" quote image.generate --input /absolute/path/input.json --budget project --json
node "$PAY" run SAVED_JOB_ID --approve --json
node "$PAY" status SAVED_JOB_ID --wait --timeout 180 --json
```

Write a JSON input file matching the service's current schema. `quote` validates
it, saves the UUID/recovery token before posting, and returns the actual price,
recipient and expiry without paying. Present these before obtaining any missing
authorization. `--approve` represents that authorization, including an already
approved workflow budget; it is not a reason to ask twice.

Each job keeps its exact original body, recipient, price and token. The full
selected offer is preserved when signing. Budget reservations happen atomically
before signing, including across parallel jobs. `budget --name project` shows
spent, reserved and remaining totals; changing the cap never resets usage.

`run` signs locally and sends the same request with PAYMENT-SIGNATURE. Do not
send a separate Stellar transfer, call the facilitator directly, export the
seed, or print recovery/payment headers. The npm equivalents are `algoria pay`
and `algoria discover`; both execute these same helpers.

## Resume rather than repay

- On timeout or interruption, use `list` to find the saved job, then `status`
  with that ID. Never repeat `quote` with a new identity as an automatic retry.
- `queued`, `running`, `saving`, `settling`, `submitting`, `result-ready`:
  bounded `status --wait` follows the same job. No background tracking is implied.
- `paid`: `run` repeats the original POST without a payment signature to resume
  provider submission. No new approval or charge is needed.
- `payment-uncertain`, `submission-uncertain`, or `requiresAttention: true`:
  preserve the record and reservation. Stop new payment attempts for that work
  and report the saved ID for operator reconciliation. Even `awaiting_payment`
  after a dispatched authorization does not justify another signature.
- `failed`: show its error and receipt together. Payment may already have
  succeeded; a new generation is a separate user decision.
- `succeeded`: present the output media URL and receipt. Refresh expired URLs
  with `status` for this job, not a new generation. Downloads must not carry
  recovery tokens or payment headers.

Interrupted locks have `owner.json` with a PID under `~/.algoria/locks`. Never
delete a lock while its process may still be running. Recovery tokens cannot be
retrieved from the server if the local state is lost; retain `services.json`.
Reservations for uncertain/failed attempts remain conservative until reconciled;
there is no automatic refund or budget reset command.

For multi-service media workflows, read [workflows.md](references/workflows.md).
