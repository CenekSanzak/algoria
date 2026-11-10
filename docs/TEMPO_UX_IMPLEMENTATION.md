# Smooth the UX — local implementation

Date: 2026-10-05 · `algoria-x` · `colloseum-intro` · Plugin 0.10.0

Follow-up: [0.11.0 local permissions and packaging](./TEMPO_PERMISSIONS_AND_PACKAGING.md)
supersedes the budget setup and disabled-permissions statements below. Existing
MPP budgets now need a Touch ID-approved scope/expiry; the original UX evidence
and test counts here describe the earlier 0.10.0 phase.

## User experience

Ask for an image → prepare one saved task → review the exact purchase in the
local wallet → Touch ID → real generation state → result and receipt in chat.
No routine approval link and no second key-creation confirmation. The assistant
still resolves creative choices and authorized budget limits before production.
Host-required tool permissions remain separate.

The same job ledger is the durable task coordinator; there is no second mutable
task database. It preserves immutable prompt, price, destination and identity.
Restarts, lost responses and expired preview access recover that same task.

## Implemented

- `pay readiness`: read-only codesign/Touch ID capability check. No key creation,
  biometric prompt, funding, RPC or payment; one next setup action.
- `pay task`: prepares the existing image service with MPP, coordinates signing,
  execution, bounded status polling and result hints. It requires an existing
  user-authorized MPP budget; it never invents or expands one.
- All public jobs include a `journey` card with task ID, elapsed time, actual
  stage and next action. No fake progress percentage or claim of visible media.
- On interruptions after saving, the command returns the same identity and an
  actionable card with `interrupted: true` and a nonzero exit code. Setup/faucet
  consent gaps return the quote without attempting payment.
- Wallet approvals share a cross-process lock with a five-minute bounded wait.
  Only one native signer opens at a time. Queued expiry is checked before key
  creation/funding. Busy or crashed locks are never automatically stolen.
- Short ledger updates wait up to five seconds for each other, so simultaneous
  tasks preserve atomic budget reservations without failing on routine overlap.
- Purchase, Wallet and Activity tabs use native scrollable, selectable text from
  the bundled trusted transaction builder. The full prompt, service price,
  recipient, expiry, temporary account and network fee bounds remain reviewable.
- `task ID` without approval reads status/refreshes result access; it never signs.
  A missing initial unpaid quote can recover only its saved identity. `paid`
  requires a same-task resume to submit the already-paid service, not another
  signature. Saved transaction uncertainty retains its budget reservation.

## Example for the assistant

Resolve the installed plugin's absolute `PAY` path as documented in its skill.
Amounts below are examples, not authority to spend.

```sh
node "$PAY" readiness --json
node "$PAY" budget --name tempo-demo --total 0.10 --per-call 0.02 --protocol mpp --json
node "$PAY" task --input /absolute/path/image.json --budget tempo-demo --json
node "$PAY" task SAVED_TASK_ID --approve --fund-testnet --wait --json
# Restart or reopen the same result; no payment approval needed:
node "$PAY" task SAVED_TASK_ID --wait --json
```

If exact creative intent, budget and faucet consent are already authorized, the
first task call can include approval/funding/wait. Touch ID still reviews and
protects the actual signature. Explain meaningful state changes, not each helper
call. Use the existing delivery rules to verify a preview before claiming it is
visible. Do not repair a failed preview by purchasing again.

## Limits and remaining work

This is a local development companion, not an embedded Claude/Codex widget.
Wallets are still disposable, **Tempo testnet only**, with explicitly requested
faucet tokens. Keys are discarded on exit; no real funds or persistent balance
is supported. Service-price budgets do not include gas. Native Activity shows
the current purchase, not a full-history browser; reusable permissions are
explicitly disabled. The ledger/`list` retains job activity and receipts.

Developer ID signing/notarization, installation automation, authenticated IPC,
persistent wallet lifecycle and bounded delegated permissions remain future
phases. There is no ERC-8196 conformance claim. Full both-host UX and accessibility
testing still requires a live installed-host session. Provider testing needs a
separately approved cost budget; no live image purchase is performed by tests.

## Verification

Completed locally: 254 plugin tests and 29 native tests pass; type checking,
native compilation and the offline app-runtime purchase check pass. Readiness
and help load from a clean copied plugin without `node_modules`; packaging
inspection and the updated payment skill validator pass. No live provider
purchase or both-host usability session was run.

Plugin regression tests cover the coordinator, readiness, actual status mapping,
wallet-lock queuing, cancellation, lost initial quote, lost paid response,
reopen without another signature, changed input and secret redaction. Native
compilation and the offline JavaScriptCore purchase fixture exercise the actual
app bundle without Touch ID or broadcasting. Existing Stellar behavior remains
covered by the full plugin suite.
