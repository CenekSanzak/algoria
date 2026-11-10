# Tempo image payments

Only `image.generate` currently supports MPP on Tempo Moderato (42431), using
six-decimal **test PathUSD**. Use the absolute `PAY` helper resolved in the parent
skill. Do not run Stellar top-up for this route.

Build the development native companion on a Touch ID Mac and set
`ALGORIA_TEMPO_SIGNER_APP` to its absolute `.app` path. It creates a disposable
Secure Enclave key for this purchase. `--fund-testnet` explicitly requests test
faucet tokens. Persistent wallet setup and packaged installation come later.

Use only the user's approved budget and creative request:

```bash
node "$PAY" readiness --json
# Substitute the live service's recipient and the user's chosen host/expiry.
node "$PAY" budget --name tempo-demo --total 0.10 --per-call 0.02 --protocol mpp --agent codex --recipient SERVICE_RECIPIENT --expires USER_APPROVED_ISO_DATE --json
node "$PAY" task --input /absolute/path/input.json --budget tempo-demo --json
node "$PAY" task SAVED_TASK_ID --approve --fund-testnet --wait --json
```

`task` is the preferred image journey: quote, exact native review, payment,
bounded generation wait and a result card, all using one saved job identity.
When the user's exact creative request, budget and testnet faucet use are already
authorized, `task --input ... --budget ... --approve --fund-testnet --wait` can
combine those steps. Do not invent creative choices or budget limits. Touch ID
still approves the exact transaction. No manual approval URL is needed.

For restart/reopen, use `task SAVED_TASK_ID --wait --json` without `--approve`.
This refreshes access and status, not payment. If the backend says `paid`, resume
that same task with `--approve`; it starts the paid service without signing again.
An uncertain transaction keeps its reservation and requires reconciliation;
do not create a replacement task. Initial lost unpaid quotes can be retried with
the same identity. Expired quotes require reviewing terms for a separately
authorized task; they are never silently replaced.

Use `journey.message` for concise progress and `nextAction` to choose the next
step. `list` includes current saved stages; it is not background monitoring.
`interrupted: true` returns the saved identity even if a network step fails, and
the CLI exits nonzero. Read-only `readiness` checks installation/Touch ID only,
not RPC connectivity or a persistent wallet balance. The local Purchase, Wallet,
Permissions and Activity tabs disclose the temporary account, signed local budget
and current purchase. Persistent native history is not yet enabled.

Wallet signing is serialized across local processes. A queued task does not open
another biometric prompt; its expiry is checked before it reaches the signer.
A crash lock is never automatically stolen or deleted. Check the owner process
before manual recovery. Host tool approvals remain separate.

The native review shows the actual prompt, token, recipient, price and fees, then
requires Touch ID for signing. `--approve` alone cannot bypass biometric approval.
Display the returned image using the normal delivery rules.

After an interruption, keep the same job. `status` only reads; `run` can resend
its saved hash credential and resume a paid provider submission. It cannot
rebroadcast or sign a second payment after the transaction hash is saved.
An uncertain broadcast needs reconciliation; never create a new quote to hide it.
Recovery tokens and credentials must stay in local state.

Tempo budgets use seven-decimal internal accounting for compatibility with the
existing ledger, while on-chain amounts and receipts explicitly use six decimals.
Separate protocol budgets prevent cross-chain reservations. Existing untagged
budgets/jobs retain their Stellar meaning.

## Local spending permissions

Creating or changing a Tempo budget opens a separate native permission review
and requires Touch ID. Confirm the user's total, per-purchase limit, exact service
recipient, host label and expiry first. Use the recipient from current service
metadata; do not guess it. Maximum lifetime is 30 days; maximum total is 100 test
PathUSD. An existing MPP budget without a signed permission must be reapproved;
Stellar budgets are unchanged. Approved scopes are only the fixed Algoria image
endpoint, Tempo testnet and PathUSD. Every purchase still requires Touch ID;
this budget does not permit autonomous/delegated signing.

`budget --name tempo-demo --json` reads permission state and usage. A grant or
replacement preserves spent/reserved totals. To stop new local dispatches:

```sh
node "$PAY" revoke --name tempo-demo --json
```

Revocation is immediate locally, needs no biometric and does not undo an already
saved dispatch or submitted transaction. Recovery of those jobs remains allowed
without another charge. Revocation during an approval prevents the grant from
silently overwriting the stop. Explicit biometric regrant can restore authority.

The native builder verifies the signed scope, per-purchase cap and expiry. The
plugin ledger enforces cumulative limits, concurrency and local revocation.
Host labels are not verified agent identities. Same-user malicious software can
replace local files/companion; receipts are not hardware attestations. No policy
contract, ERC-8126 verification, on-chain revocation or full ERC-8196 compliance
is implemented. Do not describe these permissions as on-chain guarantees.
