# Tempo social-video payments

`video.social` supports MPP on Tempo Moderato (42431), alongside existing
Stellar x402. Default price: **0.11 test PathUSD**, `110000` atomic units
(six decimals). Gas is separate. Live metadata is authoritative.

## User flow

1. Ask for a TikTok-style video inside Claude or Codex.
2. Review the proposed brief, 1–5 still-image scenes, exact English narration,
   voice, captions and any user-selected references.
3. Grant a video-scoped budget with chosen limits/expiry through Touch ID.
   Existing image/call budgets cannot pay for videos.
4. The plugin saves one task, obtains its MPP quote and opens the native wallet.
   Testnet faucet funding happens automatically when needed.
5. Review the exact plan, service price, receiver and fee bounds; Touch ID signs
   one challenge-bound payment. The backend runs all internal stages.
6. Receive the vertical MP4 plus the Tempo explorer receipt in the conversation.

The output is a montage from generated still scenes with English narration and
optional captions, not arbitrary text-to-video motion. It does not post to TikTok.
Provider usage is real even though test tokens have no monetary value.

## Architecture

The existing service endpoint and durable `SocialWorkflow` are unchanged.
`X-Payment-Protocol: mpp` selects a six-decimal Tempo quote and push-payment
verification. Settlement uses the existing transaction-hash replay claim before
starting the workflow. Internal image/speech/render stages do not charge again.

Backend, plugin and native builder normalize the same fields/order/defaults;
the quote's input hash binds the full approved plan. The native app independently
checks endpoint, chain, token, recipient, amount, signed service scope, cap and
expiry, then builds one `transferWithMemo`. The plugin enforces cumulative
spending and local revocation; every purchase still needs Touch ID. This is not
on-chain delegation or full ERC-8196 compliance.

## Configuration and release

- Existing MPP configuration enables the route when `VIDEO_SOCIAL_PAY_TO`
  already enables the social workflow. Its default receiver is
  `TEMPO_IMAGE_RECIPIENT`. No new key or database migration is needed.
- Optional `TEMPO_SOCIAL_RECIPIENT` / `TEMPO_SOCIAL_PRICE_ATOMIC` override only
  video payments. Do not rotate `MPP_SECRET_KEY` or alter existing saved quotes.
- Plugin npm and both host manifests are prepared as **0.12.0**. The companion
  is also 0.12.0, locally built/ad-hoc signed, not notarized.
- Commit/push to `main` runs the existing npm publish workflow. A local version
  bump or tarball is not proof of registry publication.
- Deploy the existing API with `node platform/scripts/infra.mjs deploy` using
  Node 22+. Its deployment does not publish the plugin.

## Recovery and verification

Cancellation before signing releases the reservation and pays nothing. After
dispatch, recover the same task ID; never sign another payment to recover a
lost reply. Confirmed jobs can refresh expiring delivery URLs without repayment.
Uncertain internal stages remain flagged for reconciliation, not resubmission.

Offline tests cover cross-layer normalization, metadata/OpenAPI, exact transfer
and memo, input tampering, wrong service scopes, limits/expiry/revocation,
cancellation, lost broadcast/response, duplicate POSTs, cross-job hash reuse,
video delivery and native compact UI safety. No live video purchase is implied;
a paid Touch ID demo needs a separately approved plan/budget and real provider use.

Local verification (2026-10-11): plugin type check and 325 tests passed; backend
type checks and payment/social regression suites passed, including the SQL-backed
nine-stage pipeline with a Tempo receipt; 52 native tests passed. The built
JavaScriptCore runtime passed image, phone and social-video construction/signature
fixtures, including a signed reference-photo URL. Native UI safety checks passed
and synthetic light/dark video screens were visually reviewed. The 0.12.0 npm
tarball and ad-hoc companion ZIP were built locally. No real provider call,
biometric purchase, registry publication or backend deployment is implied by these checks.
