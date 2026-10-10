# Tempo hackathon experience

## Implemented flow

With installation and a user-approved budget prepared once:

1. Ask for an image (or an explicitly approved real call).
2. One branded local wallet opens. It prepares the temporary testnet wallet and
   requests faucet tokens only when necessary. Manual funding appears only if
   the verified balance is still insufficient.
3. Review the exact request, service price and maximum network fee. Full
   recipient, token, expiry and temporary-wallet details stay under Details.
4. Approve with Touch ID. The same window follows confirmation and service
   status, with no guessed percentages or completion times.
5. The assistant presents the actual result, then the confirmed price and a
   clickable Tempo Explorer receipt. Raw JSON and routine task IDs stay out of
   the success response. IDs remain available for recovery.

This is a native macOS window alongside Claude/Codex, not an embedded host
panel. Temporary wallets, testnet-only payments, local budget enforcement and
per-purchase biometrics remain. No persistent wallet, unattended signing or full
ERC-8196 compliance is claimed. First-time budget creation requires its own
biometric approval; the one-purchase demo flow assumes that setup is complete.

## Prepare before presenting

Build the companion from `native/tempo-signing-proof` with Node 22+ and the
existing locked dependencies (`npm ci --ignore-scripts`, then `npm run build`).
Configure `ALGORIA_TEMPO_SIGNER_APP` to the resulting absolute `.app` path.
Install/update the plugin and companion together: the new source requires
`journeyVersion: 1`. An older cached/npm plugin will not use this journey.
This change does not publish npm or install a notarized companion.

Using the plugin's absolute `algoria-pay/scripts/pay.mjs` path as `PAY`:

```sh
node "$PAY" preflight --budget USER_APPROVED_BUDGET --service image.generate --agent codex --json
```

Use the chosen host label and an already approved, unexpired budget. Preflight
checks the companion/Touch ID, current service metadata, testnet chain and fee
cap, service/recipient/host scope, remaining allowance and per-purchase limit.
It does not create keys, quote, fund, approve limits or pay. It cannot prove
faucet availability, live Touch ID signing or provider delivery. Purchasing
still revalidates all terms. Keep normal host tool permissions enabled.

For the demo, prefer one image. A phone demo needs a separate phone budget and
explicitly approved contact, goal, caller and language; calls incur real provider
costs despite test-token payment. Never place a rehearsal call automatically.

## Task and recovery

`task --input INPUT --budget BUDGET --approve` waits by default, bounded by
`--timeout` (default 180 seconds for polling). `--no-wait` opts out. Submission
uses the existing async backend mode so saved service statuses can update the
window promptly. No backend deployment or payment-protocol change is needed.

The signer verifies the exact signature, saves the transaction identity before
its one-shot broadcast and checks settlement. Only then does the task own the
read-only UI session. It sends stages and the public transaction hash, never
credentials, policy receipts, media URLs or user input. Updates are deduplicated.
Presentation failures cannot authorize another payment or turn a successful
settlement into cancellation. The UI lifetime is bounded to ten minutes after
handoff, and its final card closes after eight seconds; status continues in chat.

Closing before approval stops signing. After signing, closing cannot undo a
submitted payment or end a real call. On interruption, timeout or a lost reply,
resume the SAME ID. Status recovery needs no signing or funded wallet. Uncertain
payments retain their reservations; no automatic replacement purchase, refund
or redial is performed. Initial budget approval/changes still need Touch ID.

## Offline verification and live rehearsal boundary

- Plugin tests cover async submission, default wait/opt-out, same-task recovery,
  signed transaction verification, cancellation, lost broadcasts and unchanged
  reservations. Session tests check stage deduplication, safe receipt links,
  uncertainty precedence and closed-window isolation.
- Preflight tests cover missing/revoked/expired/wrong-scope budgets, exhausted
  allowance, RPC/metadata failures and fee caps without any funding or payment.
- Native UI checks cover compact light/dark layouts, the same window identity,
  receipt validation, unsigned-success rejection, keyboard safety and expiry.
  No-key native protocol fixtures prove that UI timers and cancellation still
  work while the companion waits for parent input.
- Native signing fixtures use software test keys only; visual previews use no
  keys. Neither proves live biometrics or a paid provider purchase.

Before the live presentation, separately authorize one image rehearsal and
exercise Touch ID and actual result delivery. Cancellation before approval
must produce no purchase. A display failure must recover the paid result, not
generate another image. This implementation turn does not authorize that charge.

Verified locally: 319 plugin tests and 44 native builder tests pass; TypeScript,
native UI/responsive IPC checks, JavaScriptCore software fixtures, and isolated
package smoke checks pass. Light/dark purchase and journey previews were
rendered and visually inspected. Read-only readiness with the rebuilt app's
explicit path reports ready. No live faucet, biometric signing, provider call,
purchase, npm release or host-profile installation was performed.
