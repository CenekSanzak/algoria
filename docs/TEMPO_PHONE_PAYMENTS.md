# Tempo phone payments

Implemented in `algoria-x` source on `main`, 2026-10-10. This is not a claim of
npm publication, backend deployment, or a completed live phone test.

## What changes

The Claude/Codex plugin can pay for one real `phone.call` through MPP on Tempo
Moderato (42431). Default price: **0.10 test PathUSD**, six-decimal atomic amount
`100000`. Image payments remain **0.01 test PathUSD** (`10000`). Stellar x402
continues unchanged for all enabled services. Other services do not gain Tempo.

| Service | Stellar test USDC | Tempo test PathUSD |
| --- | ---: | ---: |
| `image.generate` | 0.01 | 0.01 |
| `speech.generate` | 0.02 | — |
| `video.slideshow` | 0.01 | — |
| `video.compose` | 0.01 | — |
| `video.caption` | 0.02 | — |
| `video.social` | 0.11 | — |
| `phone.call` | 0.10 | 0.10 |

These are default prices. Always read deployed service metadata before spending.
Test payments have no monetary value, but calls consume real Twilio/OpenAI usage
and contact real people. Only operator-approved contact names are accepted.

## Architecture and safety

1. Discover phone metadata and confirm contact, goal, caller name, language,
   chain and exact price. Normalize defaults before hashing or quoting.
2. Create a **phone-scoped** local budget with native Touch ID approval. The
   signed policy binds `phone.call`, its fixed API URL, receiver, token, chain,
   total, per-purchase limit and expiry. Existing image policies are unchanged
   and cannot pay for calls. Scope changes need another biometric approval.
3. Save one UUID/recovery token, then request a persisted MPP quote. Compare
   identity, input hash, endpoint, token, chain, amount and recipient before signing.
4. The native app validates the structured call and signed policy, constructs
   one challenge-bound `transferWithMemo`, and displays the exact contact, goal,
   caller name, language, price and fee caps. A warning distinguishes real
   dialing from test-token payment. Touch ID signs that exact transaction.
5. Reserve the budget atomically and save its hash/credential before one
   broadcast. Backend SDK verification checks successful settlement, exact
   token/amount/recipient/payer and attribution. The database claims the
   transaction once, then the existing phone submission claim allows one dial.
6. Poll the same saved job for its summary/transcript. Recovery reuses the
   receipt; it never signs another payment or automatically redials. Ambiguous
   payment/submission requires reconciliation and retains its reservation.

Cancellation before dispatch releases the reservation and never dials. Closing
the wallet after dispatch does not cancel payment or the real call. Provider
failures/no-answer do not imply refunds. Revocation blocks future local dispatch,
not recovery of already-submitted work. Limits remain **local-only**, with Touch
ID for every purchase; this is not full ERC-8196 compliance or autonomous signing.

## Backend configuration

Existing phone prerequisites remain: Twilio/OpenAI credentials, approved contacts,
and `PHONE_CALL_PAY_TO` enable the service. Existing Tempo image configuration
and the stable `MPP_SECRET_KEY` enable MPP. Phone inherits the same Tempo receiver
and defaults to `100000` atomic units. Optional overrides:

```dotenv
TEMPO_PHONE_RECIPIENT=0xYOUR_OPTIONAL_PHONE_RECEIVER
TEMPO_PHONE_PRICE_ATOMIC=100000
```

Do not copy `PHONE_CALL_PRICE_ATOMIC=1000000` into Tempo: Stellar uses seven
decimals, PathUSD six. Metadata, quotes and native review use the actual configured
price, never a client-side hardcoded charge. Both phone and image receivers/prices
are validated. No schema migration, new secret or secret rotation is needed.

Deploy the updated `platform/supabase/functions/api` separately. Until deployment,
an older backend will refuse phone MPP safely, without signing or spending.

## Plugin use

Rebuild the native companion (`npm run build` in `native/tempo-signing-proof`)
and set its absolute `.app` path in `ALGORIA_TEMPO_SIGNER_APP`. Install the updated
plugin source/package; the published npm package does not change with local edits.
Resolve `PAY` to the installed plugin's absolute `skills/algoria-pay/scripts/pay.mjs`.
Example input in `/absolute/path/call.json`:

```json
{"contact":"berkin","goal":"Confirm the demo","on_behalf_of":"Dogukan","language":"tr"}
```

With a user-approved contact, goal, limits, recipient and expiry:

```sh
node "$PAY" readiness --json
node "$PAY" budget --name tempo-calls --service phone.call --protocol mpp --total 0.10 --per-call 0.10 --agent codex --recipient SERVICE_RECIPIENT --expires USER_APPROVED_ISO_DATE --json
node "$PAY" task --service phone.call --input /absolute/path/call.json --budget tempo-calls --json
node "$PAY" task SAVED_TASK_ID --approve --fund-testnet --wait --timeout 240 --json
node "$PAY" task SAVED_TASK_ID --wait --timeout 240 --json
```

Use `--agent claude` for Claude. Preparing the task does not pay or dial. The
last command recovers without signing. Existing `quote phone.call --protocol mpp`,
`run` and `status` work too. New `task`/budget grants default to images for backward
compatibility; recovery infers the saved service and refuses changed inputs.

## Verification

All automated checks use mocked RPC/provider transport or explicit software
test keys. They do not place calls, spend funds or request biometric approval.

Local checks passed: **280 plugin tests, 110 backend tests and 43 native tests**,
plugin/backend type checks, a rebuilt ad-hoc-signed macOS companion, both native
JavaScriptCore purchase paths, image/phone UI checks and visual review, a
dependency-free clean-package smoke test, and a byte-identical Tempo bundle
rebuild. Backend tests now run in CI with pinned Deno 2.9.6. The package check
does not modify actual Claude/Codex profiles or prove a live host conversation.

- Plugin: phone quote/default normalization, 0.10 accounting, complete delivery,
  wrong service/limit rejection, contact allowlist, changed input rejection,
  cancellation, lost HTTP/RPC responses, revoke and same-ID recovery.
- Backend: real SDK receipt verification for the phone amount/receiver, MPP
  metadata/OpenAPI, Stellar compatibility, underpayment, wrong contact/language,
  wrong job/token, duplicate payment/dial claims, uncertain dialing and transcript
  recovery. Existing SQL-backed phone/replay and Stellar/image suites retained.
- Native: exact phone transfer/signature, all call-field substitutions, image
  permission rejection and noncanonical input rejection. JavaScriptCore exercises
  image and phone permission/purchase flows; UI checks exercise both scopes,
  compact layouts, cancellation and expiry. Safe `--preview phone` creates no key.

A live call still needs fresh explicit authorization for the real contact,
provider usage and payment, plus a person present for Touch ID. No such call is
performed as part of implementation.
