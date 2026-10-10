---
name: algoria-pay
description: Pay for Algoria services and recover saved jobs. For an explicitly selected Tempo/MPP image or phone task, use the native Touch ID purchase route and a separate service-scoped test PathUSD budget. For Stellar tasks, FIRST check testnet USDC balance before discovery, planning or payment; if empty, use the Stellar top-up flow. Execute Algoria or Stellar8004 HTTP services over x402 within the approved scope and deliver the result. Use algoria-discover when no service is selected. Never repay an uncertain saved job.
---

# Pay and execute an Algoria service

For an explicitly selected **Tempo/MPP image or phone task**, first read
[tempo-payments.md](references/tempo-payments.md). Follow that route's native
Touch ID review, test PathUSD funding and separate budget. The Stellar balance
and top-up steps below apply to Stellar tasks only. `run` and `status` detect the
saved job's protocol; never switch a saved job to another chain.
Prefer the Tempo `task` coordinator over separate quote/run/status calls. Keep
its saved ID across interruptions and delivery retries; the six skill entry
points and Stellar helpers remain available.
Use `task --service phone.call` for real calls and read [phone-calls.md](references/phone-calls.md)
before quoting. Image permissions do not authorize phone calls.
Tempo budget grants/changes require a native Touch ID review with explicit scope
and expiry; `revoke` stops future local dispatches. These are local permissions,
not autonomous signing authority or ERC-8196 compliance.
Tempo automatically tops up an insufficient temporary wallet from the testnet
faucet before signing. If needed, its open native wallet asks for missing test
tokens. Always show `payment.explorerUrl` as a clickable Tempo Explorer receipt
after confirmed payment, including when service execution fails. A saved hash
alone is not payment confirmation. Follow the Tempo reference for safe funding
and sandbox-restricted Touch ID diagnostics.

**First action for a new Stellar paid task: check wallet balance, before discovery,
quotes or payment attempts.** Use the wallet helper from this plugin at
`skills/algoria-wallet/scripts/wallet.mjs balance --network testnet --json`,
with its absolute path and `node`. Run it separately and inspect the result.
A zero balance goes straight to the top-up link; only then resume the task
after confirmed funding. A fresh balance check from discovery satisfies this
step. Recovering an already-paid job needs no funding.

Use current metadata from `algoria-discover`. The helper supports Algoria's
pinned API and optional Stellar8004 testnet HTTP services. Both use sponsored
x402 v2 exact payments in testnet USDC, with the same local wallet and named
budgets. Secrets stay local; no Supabase/fal credentials or browser login are needed.

For an ID beginning `stellar8004:`, read [external-services.md](references/external-services.md)
before quoting. Its exact request, response and retry rules differ from Algoria
jobs. The remote recovery instructions below apply only to Algoria jobs.

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

Follow [the shared planning flow](../algoria-discover/references/planning.md)
for every new service: discuss the output and estimated cost before production,
then compare the definitive quote with the approved plan and budget.

## Budget, quote, execute

For a new paid task, check `algoria-wallet balance --network testnet --json`
before discovery or input preparation, using that skill's absolute helper path.
Reuse a fresh check already made by `algoria-discover` in this task. Zero USDC
goes straight to [algoria-topup](../algoria-topup/SKILL.md); a positive balance
must cover the whole plan, not just its first call. After a funding wait, verify
the deposit and fresh balance before proceeding. Do not use a failed payment
attempt as a balance check. Recovery of an already-paid job below is exempt
from funding: retrieve its output even if the wallet is now empty.

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

For Algoria jobs, write a JSON input file matching the service's current schema. `quote` validates
it, saves the UUID/recovery token before posting, and returns the actual price,
recipient and expiry without paying. Present these before obtaining any missing
authorization. `--approve` represents that authorization, including an already
approved workflow budget; it is not a reason to ask twice.

Before preparing `video.social` input, read the
[per-medium prompt guidance](references/workflows.md#prepare-prompts-for-each-medium).
Each scene is one self-contained still-image prompt; campaign, speech and editing
instructions belong outside it, in the matching fields.

Each Algoria job keeps its exact original body, recipient, price and token. The full
selected offer is preserved when signing. Budget reservations happen atomically
before signing, including across parallel jobs. `budget --name project` shows
spent, reserved and remaining totals; changing the cap never resets usage.

`run` signs locally and sends the same request with PAYMENT-SIGNATURE. Do not
send a separate Stellar transfer, call the facilitator directly, export the
seed, or print recovery/payment headers. The npm equivalents are `algoria pay`
and `algoria discover`; both execute these same helpers.

## Resume rather than repay

For Stellar8004 jobs, `status` is local-only, including `--wait`. Never reissue a
paid request to recover output. Retain uncertain jobs and their reservations;
the service operator must reconcile them. A `202` response is not a completed
result and no generic external polling protocol is assumed.

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

Before presenting successful media, follow [delivery.md](references/delivery.md).
Use the returned `delivery` hints and a verified native/browser preview; a raw
URL or unverified Markdown embed is not a visible artifact. Await the current
run process before starting status to avoid colliding with its job lock.
Record useful context with [algoria-memory](../algoria-memory/SKILL.md), keeping
job IDs rather than signed media URLs. History is already derived from the ledger.

Interrupted locks have `owner.json` with a PID under `~/.algoria/locks`. Never
delete a lock while its process may still be running. Recovery tokens cannot be
retrieved from the server if the local state is lost; retain `services.json`.
Reservations for uncertain/failed attempts remain conservative until reconciled;
there is no automatic refund or budget reset command.

For multi-service media workflows, read [workflows.md](references/workflows.md).
For `phone.call` (real AI phone calls), read [phone-calls.md](references/phone-calls.md)
before quoting; its result is a call summary and transcript, not media.
