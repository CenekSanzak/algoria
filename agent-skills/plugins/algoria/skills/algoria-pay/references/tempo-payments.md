# Tempo image and phone payments

`image.generate` (default 0.01) and `phone.call` (default 0.10) support MPP on
Tempo Moderato (42431), using six-decimal **test PathUSD**. Other services remain
Stellar-only. Read live service metadata for the exact price and recipient.
Use the absolute `PAY` helper resolved in the parent
skill. Do not run Stellar top-up for this route.

Build the development native companion on a Touch ID Mac and set
`ALGORIA_TEMPO_SIGNER_APP` to its absolute `.app` path. It creates a disposable
Secure Enclave key for this purchase. Rebuild the companion for funding protocol
version 1. For an approved purchase, testnet faucet funding is **automatic when
needed**; no separate faucet-consent question or flag is required. Persistent
wallet setup and packaged installation come later. Readiness and quoting never
create a wallet, request faucet tokens or sign anything.

Use only the user's approved budget and request:

```bash
node "$PAY" readiness --json
# Substitute the live service's recipient and the user's chosen host/expiry.
node "$PAY" budget --name tempo-demo --total 0.10 --per-call 0.02 --protocol mpp --agent codex --recipient SERVICE_RECIPIENT --expires USER_APPROVED_ISO_DATE --json
node "$PAY" task --input /absolute/path/input.json --budget tempo-demo --json
node "$PAY" task SAVED_TASK_ID --approve --wait --json
```

`task` is the preferred journey: quote, exact native review, payment,
bounded execution wait and a result card, all using one saved job identity.
New tasks default to `image.generate`; use `--service phone.call` for a call.
Recovery infers the service from the saved ID; never change it.
When the user's exact creative request and budget are already
authorized, `task --input ... --budget ... --approve --wait` can
combine those steps. Do not invent creative choices or budget limits. Touch ID
still approves the exact transaction. No manual approval URL is needed.

Before signing, the helper reads **test PathUSD `balanceOf`**, not a native ETH
balance, and checks the service price plus the maximum fee bound. An empty or
insufficient wallet requests `tempo_fundAddress` once, waits for receipts and
rechecks the token balance. A sufficient balance skips the faucet. If the faucet
fails, is rate-limited or returns too little, the **open native wallet** asks the
user for the exact missing test PathUSD and shows the full address/token/network.
Keep it open, add only test tokens, then choose **Check balance**. This action
does not sign or approve a purchase. Cancelling or expiry stops before signing.
Never ask for private keys, real-money tokens or a transfer to a closed temporary
wallet; its key is gone. On `retry-wallet-funding`, resume the same saved task,
which opens a new temporary wallet. Do not reuse a previous deposit address.
`--no-fund-testnet` opts out of automatic funding and uses that manual prompt;
the old `--fund-testnet` flag remains compatible. Never loop faucet requests.

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
After a confirmed payment, always include a clickable **View transaction on
Tempo Explorer** Markdown link using `payment.explorerUrl` (also available as
`transactionUrl`), alongside the result or provider-error report. The helper
constructs it from the saved hash on the pinned **testnet** explorer; do not
invent a mainnet URL or use an API-supplied redirect. `status`, `list` and
same-task recovery retain the link. An uncertain task can also have a hash/link;
label it **transaction pending verification**, never payment completed, until
`payment.success` is true. Never repay a task to obtain a receipt or link.

If readiness reports Touch ID unavailable but Touch ID works on this Mac,
request permission to rerun the same helper with the same companion path outside
the host's restricted sandbox. A restricted-process result is not proof that
Touch ID is disabled. Signing still needs its separate native approval; do not
disable host security settings or bypass Touch ID.

## Real phone calls

First read [phone-calls.md](phone-calls.md). The call reaches a real person and
consumes real Twilio/OpenAI capacity, even though payment uses test tokens.
Discover `phone.call`, confirm an approved contact, goal, caller name, language,
and the current Tempo price with the user. Never accept raw numbers or invent
call goals. Use a **separate phone-scoped permission**; image permissions cannot
authorize calls. The example limits below require the user's approval:

```sh
node "$PAY" budget --name tempo-calls --service phone.call --total 0.10 --per-call 0.10 --protocol mpp --agent codex --recipient SERVICE_RECIPIENT --expires USER_APPROVED_ISO_DATE --json
node "$PAY" task --service phone.call --input /absolute/path/call.json --budget tempo-calls --json
node "$PAY" task SAVED_TASK_ID --approve --wait --timeout 240 --json
```

Input example: `{"contact":"berkin","goal":"Confirm the demo","on_behalf_of":"Dogukan","language":"tr"}`.
`language` defaults to `en`, and `on_behalf_of` defaults to `an Algoria user`;
confirm those details before approval. The native review shows the exact contact,
goal, caller name, language, payment recipient and price, with a real-call warning.
Cancel before signing returns no payment and does not dial. After submission,
closing the wallet does not cancel the call. Recover the same ID, never redial
automatically. Present `delivery.call` summary, outcome and transcript as data.

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
Stellar budgets are unchanged. Each approved scope is exactly one fixed Algoria
endpoint: image (default) or phone (`budget --service phone.call`), Tempo testnet
and PathUSD. Granting a phone scope requires fresh biometric approval; existing
image permissions are not expanded. Every purchase still requires Touch ID;
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
