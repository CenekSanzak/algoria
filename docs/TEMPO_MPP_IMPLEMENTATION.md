# Tempo / MPP image payments

Implemented in `algoria-x`, branch `colloseum-intro`, 2026-10-05.

The existing Claude/Codex plugin can quote and buy `image.generate` through MPP
on Tempo Moderato (42431). Its native companion reviews the actual image prompt,
recipient, price, token and maximum transaction fees, then signs with Touch ID.
The existing backend verifies the settled payment and uses its existing fal,
private storage, job status and media-delivery pipeline. Stellar x402 remains available.

## Payment flow

1. Read image metadata with `X-Payment-Protocol: mpp`; this does not contact the
   Stellar facilitator. Create a separate MPP budget from the user's agreed limits.
2. Save the request identity and recovery token locally before requesting a quote.
3. POST the normalized prompt with the same UUID, recovery token and protocol.
   The backend persists a quote, then returns HTTP 402 and `WWW-Authenticate`.
4. The SDK creates an HMAC-bound challenge containing the exact price, token,
   recipient, network, request hash, service URL, job ID and expiry. The plugin
   compares its header/body, task identity and advertised price before signing.
5. The local app constructs one `transferWithMemo` itself, binding the memo to
   the challenge and server. It requires purchase review and Touch ID key access.
6. Save the transaction hash and MPP hash credential **before** the one allowed
   broadcast. After settlement, send `Authorization: Payment …` to the backend.
7. The real MPP SDK verifies the successful on-chain receipt, payer, amount,
   recipient, token and challenge-bound memo. The database uniquely claims the
   transaction hash and atomically claims provider submission.
8. Return the existing image job/result with `Payment-Receipt`. Status refreshes
   the same image access; payment recovery reuses the saved hash credential.

This is the standard MPP Tempo **push charge** path. Pull charges, sessions and
automatic token swaps are not enabled. Backend verification reads the chain;
the wallet performs settlement. Retry of a hash credential cannot charge again.

## Configuration and use

Keep existing backend configuration. Add these server variables:

```dotenv
TEMPO_IMAGE_RECIPIENT=0xYOUR_TEMPO_TESTNET_SERVICE_ADDRESS
TEMPO_IMAGE_PRICE_ATOMIC=10000
MPP_SECRET_KEY=YOUR_STABLE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
```

`10000` atomic units is `0.010000` **test PathUSD**, at
`0x20c0000000000000000000000000000000000000`, with six decimals. Do not commit
server secrets. Preserve the MPP secret while its unpaid quotes are valid;
rotating it invalidates those quotes. No database migration is required: existing
JSON snapshots now explicitly tag MPP protocol, chain, token and decimals.

Build the native companion with Node 22 and Xcode on a Touch ID Mac:

```bash
cd /Users/berkingurcan/Documents/algoria-x/native/tempo-signing-proof
npm ci --ignore-scripts
npm run build
export ALGORIA_TEMPO_SIGNER_APP="/Users/berkingurcan/Documents/algoria-x/native/tempo-signing-proof/.build/Algoria Signing Proof.app"
```

From the installed plugin, resolve `PAY` to its absolute
`skills/algoria-pay/scripts/pay.mjs` path, then use:

```bash
node "$PAY" budget --name tempo-demo --total 0.10 --per-call 0.02 --protocol mpp --json
node "$PAY" quote image.generate --input /absolute/path/input.json --budget tempo-demo --protocol mpp --json
node "$PAY" run SAVED_JOB_ID --approve --fund-testnet --json
node "$PAY" status SAVED_JOB_ID --wait --json
```

Input is `{"prompt":"The image the user approved"}`. A new native window opens
automatically; no approval link is required. The development companion creates
a disposable enclave key and uses explicitly requested testnet faucet funding.
Its leftover test tokens become inaccessible when the process exits. Never send
real funds to these disposable addresses. Production wallet persistence and
native distribution remain later implementation phases.
The development purchase signer permits image prices up to one test PathUSD;
its fixed gas and fee caps are inherited from the signing proof.

Budget reservations use the existing seven-decimal accounting scale internally;
MPP's six-decimal token amount is multiplied by ten only at that boundary.
Tagged MPP budgets cannot be mixed with Stellar budgets. Old untagged records
retain their original Stellar meaning and remain readable. Budgets cap the
service price; the native review displays the separately capped network fees.

## Recovery and limits

- `status` reads only; `run` can submit the same hash credential again or resume
  an already-paid provider submission. Neither signs a second payment after a
  transaction hash has been saved.
- A lost broadcast reply keeps the budget reserved. If no receipt exists, that
  payment needs reconciliation; the plugin will not broadcast again automatically.
- Cancellation before broadcast releases the local reservation. Provider failure
  after payment retains the receipt and spend; there is no automatic refund.
- A server crash between its atomic payment claim and finishing the receipt
  remains `settling`/uncertain and requires reconciliation. No blind repayment.
- Payment is bound to a ten-minute quote; the signed transaction expires within
  five minutes. Expired unpaid quotes cannot be silently replaced under the same ID.
- Current companion builds are locally ad-hoc signed. Authenticated persistent
  companion IPC, notarized distribution, wallet recovery and ERC-8196 policies
  remain separate work. This feature does not claim ERC-8196 conformance.

## Verification

The implementation uses pinned `mppx 0.13.1`, `viem 2.57.3`, and `ox 1.8.5`,
and ships a generated Tempo SDK bundle. Installed users need no npm dependencies.
MPP's attribution helper is bundled from the pinned SDK's internal module;
its byte layout is not reimplemented. JavaScriptCore includes an encoding shim
because the SDK's Base64 decoder requires `TextEncoder.encodeInto`.

Verified locally: **230 plugin tests, 102 backend tests and 29 native tests pass**;
both type-check commands pass, as does the native JavaScriptCore check.

- Plugin payment, recovery and Stellar regression tests, plus type checking.
- Backend receipt rejection, immutable quotes, parallel requests, one image
  execution, delivery refresh, MPP metadata/OpenAPI and all existing regressions.
- Native P-256 signature tests and the actual macOS JavaScriptCore purchase path
  with an explicit software fixture key. The previous Secure Enclave/Touch ID
  chain-signing proof remains documented separately.
- Clean plugin package contents and operation without development dependencies.

The pay skill passed the available Codex skill validator. The host's standalone
`validate_plugin.py` is unavailable; the existing manifest tests pass and both
host manifests and npm package agree on version 0.9.0. A native-build automatic
approval review timed out once; its retry and offline check completed successfully.

No live paid image was generated and no backend was deployed during this change.
Live validation requires configuring a testnet service recipient, deploying this
backend version and an approved fal provider test budget. Plugin native signing
and server verification have been tested with offline payment/provider fixtures.

Protocol reference: [MPP SDK](https://github.com/wevm/mppx).
