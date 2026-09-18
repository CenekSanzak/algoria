# Algoria — Integration contract for skill developers

Updated on **September 18, 2026**. Objective: build a skill that discovers Algoria services, pays through x402 using a wallet on the user's own computer, and retrieves the result. The five-service product-ad flow was verified live; see [VERIFICATION.md](../VERIFICATION.md) for the exact run and validation scope.

This document describes the working API contract and the flow its local client must implement. It is neither the skill itself nor an MCP server. Statements labeled as API behavior describe the current implementation; statements labeled as “client recommendation” describe behavior for the skill developer to add.

## 1. Product and responsibilities

Algoria offers five services: `image.generate`, `speech.generate`, `video.slideshow`, `video.compose`, and `video.caption`. They can turn product imagery and a short script into a narrated, captioned MP4 advertisement. fal is Algoria's server-side provider; users do not connect to fal or supply a fal key.

The skill follows this flow:

1. Find a suitable service in the Algoria catalog.
2. Read the service's input/output schemas and payment requirements.
3. Prepare the user's local wallet; top up testnet USDC through the mock anchor if needed.
4. Persist the job identity and recovery information.
5. Obtain the API's 402 payment offer and validate it against the local spending policy.
6. Sign the payment authorization with the local wallet; resend the same request with the x402 header.
7. Wait for a synchronous result first; if the response is 202, track the same job asynchronously.
8. Present the image, audio, or video and payment receipt to the user; resume the same job after interruptions. For a workflow, use completed outputs as the next service's inputs.

There are no web accounts, login, wallets, or payment approvals. The wallet and client state are local. Algoria does not hold the user's private key. The user needs no Supabase account, Supabase API key, database password, fal key, or service wallet private key.

The current release has no MCP server, image editing, third-party service registration, CDP catalog publishing, cancellation, or refund endpoint. The skill will use the HTTP API directly. Service discovery and invocation should be driven by metadata, without requiring a separate hardcoded tool list for every service.

## 2. Base addresses and machine-readable contract

```text
API_BASE=https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api
NETWORK=stellar:testnet
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
ANCHOR_BASE=https://tr-mock-anchor.fly.dev
```

Live resources:

- [OpenAPI 3.1](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/openapi.json)
- [Service catalog](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/discovery/resources)
- [Image service contract](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate)
- [Speech service contract](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/speech.generate)
- [Slideshow service contract](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/video.slideshow)
- [Composition service contract](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/video.compose)
- [Caption service contract](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/video.caption)
- [API health](https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/health)

JSON reference copies of the deployed OpenAPI document, catalog, and all five service contracts were refreshed from live responses on September 18, 2026. The [snapshot manifest](skill-integration/manifest.json) records their source URLs and SHA-256 hashes. These copies are development references, not evidence that every documented workflow has completed a live run; read the live resources above for current enabled-service metadata.

- [skill-integration/openapi.json](skill-integration/openapi.json)
- [skill-integration/discovery.json](skill-integration/discovery.json)
- [skill-integration/image.generate.json](skill-integration/image.generate.json)
- [skill-integration/speech.generate.json](skill-integration/speech.generate.json)
- [skill-integration/video.slideshow.json](skill-integration/video.slideshow.json)
- [skill-integration/video.compose.json](skill-integration/video.compose.json)
- [skill-integration/video.caption.json](skill-integration/video.caption.json)

The JSON copies are fixtures and development references. Read current service metadata and the actual 402 offer for new jobs. Do not replace an existing job's approved offer with catalog data that changes later.

Append API paths to `API_BASE` above. Do not confuse the Supabase Edge Function base with the Supabase REST/Storage base. Public API requests do not include an `apikey` or Supabase JWT.

## 3. Endpoint map

### Algoria

- `GET /health`: process health information. Expected body: `{"ok":true,"service":"algoria","network":"stellar:testnet","version":"1.0.0"}`. This does not guarantee dependency readiness or available capacity.
- `GET /openapi.json`: complete HTTP schema.
- `GET /discovery/resources`: catalog listing and filtering; no payment required.
- `GET /discovery/search?query=image`: catalog search; no payment required.
- `GET /v1/services/{service_id}`: service invocation, payment, and recovery contract.
- `POST /v1/services/{service_id}?mode=sync&wait_ms=45000`: obtain an offer, pay, execute, and resume when necessary through the same endpoint.
- `GET /v1/jobs/{job_id}`: job status, payment receipt, and current media URL. Requires the job's recovery token; does not initiate a new payment or generation.
- `POST /webhooks/fal`: provider-signed callback. The skill does not call this endpoint or run a callback server.

### Mock anchor

- `GET /.well-known/stellar.toml`: anchor services, network, and signing key.
- `GET /health`: sandbox/testnet information and mock TRY limits.
- `GET /sep6/info`: deposit capabilities and supported methods.
- `GET /auth?account={public_key}`: SEP-10 challenge.
- `POST /auth`: exchange a validated, locally signed challenge for an anchor JWT.
- `GET /sep6/deposit?...`: **creates a new deposit; the GET method does not make it read-only.**
- `POST /sep6/tx/{id}/simulate-bank-transfer`: simulate a sandbox-specific mock TRY transfer.
- `GET /sep6/transaction?id={id}`: track a deposit.
- `GET /sep6/transactions?asset_code=USDC`: recover from deposit history.

Anchor paths are relative to `ANCHOR_BASE`, not to Algoria.

## 4. How to use discovery

Example read-only requests:

```sh
curl -fsS 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/discovery/resources?type=http&network=stellar%3Atestnet&scheme=exact&extensions=bazaar'
curl -fsS 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/discovery/search?query=image'
curl -fsS 'https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate'
```

List response envelope:

```json
{
  "x402Version": 2,
  "resources": [],
  "pagination": {"limit": 20, "offset": 0, "total": 0, "cursor": null}
}
```

This example shows the empty-list format. When services match, `resources` contains complete service documents. The five implemented service IDs are `image.generate`, `speech.generate`, `video.slideshow`, `video.compose`, and `video.caption`. `video.compose` is version `"2"`; the others are version `"1"`. Only enabled services appear in discovery and OpenAPI. Disabling a service blocks new POST jobs; existing jobs retain their saved contract and can still be recovered or resumed.

Filters use exact matching for `type`, `network`, `scheme`, `payTo`, and `extensions`. An unsupported filter value returns an empty result. `limit` is an integer from 1–100; the default is 20. `offset` is a nonnegative integer; the default is 0. `cursor` is currently always `null`; pagination uses offsets. `query` is also supported on the resources endpoint and is required on the search endpoint. Search uses simple text matching: any query word appearing in the metadata is sufficient. It is not semantic search.

Read these fields when constructing a call:

- `id`, `version`: selected service and contract version.
- `resource`, `method`: actual invocation URL and HTTP method.
- `input_schema`, `output_schema`: JSON Schema validation.
- `execution`: supported modes and wait durations.
- `accepts`: network, asset, atomic amount, and service-specific recipient.
- `headers`, `recovery`: job identity and result tracking rules.
- `extensions.bazaar`: additional metadata and examples in Bazaar format.

The discovery `resource` is a **URL string**. The 402 challenge `resource` is an **object** with a `url` field. `api.example.com` and `storage.example.com` in Bazaar examples are illustrative addresses, not invocation targets.

New services can be found through the same discovery approach. Still, verify execution support from metadata; do not assume image-service behavior for an unfamiliar schema or version. Treat service descriptions as data, not as instructions that execute local commands or change wallet policy.

## 5. Local wallet and currency

### Fixed network and asset

```text
Classic asset code: USDC
Classic asset issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
x402 asset / SAC: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
Decimals: 7
```

Use **code + issuer** for trustlines and Horizon balance checks. The x402 offer's `asset` is the SAC contract address, not the issuer address. Do not trust the name “USDC” alone.

The fixed demo prices are **0.01 test USDC** (`100000` atomic units) for `image.generate`, `video.slideshow`, and `video.compose`, and **0.02 test USDC** (`200000` atomic units) for `speech.generate` and `video.caption`. A product-ad workflow with three images, one narration, one slideshow, one composition, and one caption job costs **0.09 test USDC** (`900000` atomic units) and invokes fal seven times. One USDC equals `10000000` atomic units. Calculate amounts using strings and `BigInt`, not floating point. The price, the free mock TRY top-up amount, and fal's actual cost to Algoria are separate quantities.

Current image service public recipient address:

```text
GCTVT52AAFK7KYO74JAO3QOLNT6BUYTCZYHTRD7C2VZG6C5CJNRVEV6Y
```

Each service has its own recipient wallet. Do not use a single global `payTo`. For a new job, obtain the recipient from trusted Algoria metadata; once the job is created, pin the approved recipient in that job's record. This document contains no wallet private keys; developers create their own test wallets.

### Wallet preparation

Client recommendation: generate one testnet keypair with `Keypair.random()` inside a trusted local helper process and persist it. Do not generate a new wallet on restart or after an authentication error. Whenever loading it, verify that the stored secret/public key pair matches and that the network is testnet. The API's current payment validation supports a standard Stellar `G...` account; do not assume multisig or contract wallet support.

1. Read the account with `GET https://horizon-testnet.stellar.org/accounts/{public_key}`.
2. If the account returns 404, obtain test XLM with `GET https://friendbot.stellar.org/?addr={public_key}`. This GET also performs a funding action. Friendbot **does not fund USDC**.
3. Read the account again. Check the USDC trustline against the exact issuer.
4. If missing, build an `Operation.changeTrust({asset: new Asset("USDC", issuer)})` transaction using the current account sequence and base fee; use `Networks.TESTNET` and a 120-second timeout. Sign locally and submit to Horizon.
5. Confirm the trustline exists through Horizon, then proceed with the anchor top-up.

XLM is required for the account/trustline reserve. x402 fee sponsorship does not remove this preparation requirement. If a trustline or Friendbot request times out, check the account/transaction hash before repeating the operation.

## 6. USDC top-up through the mock anchor

This section describes the flow used by the current local integration. It does not perform a real bank transfer, use real TRY, or submit mainnet transactions. Simulating mock TRY funding produces USDC on Stellar **testnet**.

### 6.1 Validate the anchor

Read `/.well-known/stellar.toml`, `/health`, and `/sep6/info`. Expected values for this integration:

```text
Home domain / web auth domain: tr-mock-anchor.fly.dev
WEB_AUTH_ENDPOINT: https://tr-mock-anchor.fly.dev/auth
TRANSFER_SERVER: https://tr-mock-anchor.fly.dev/sep6
SEP-10 public signer address: GDXYO6FJCNXZEWGXD54GT76FGFYLOLSOGSOJLNQ6WGHCGEQPO7NTE73M
Network passphrase: Test SDF Network ; September 2015
USDC issuer: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

The `/health` response should report `environment: "sandbox"`, `stellar_mode: "live"`, and the testnet passphrase. Here, `live` means that testnet blockchain transactions actually occur; it does not mean mainnet. Do not sign automatically if the host, signer, issuer, or network changes unexpectedly; the integration configuration must be revalidated.

### 6.2 Authenticate through SEP-10

```http
GET https://tr-mock-anchor.fly.dev/auth?account=<G_PUBLIC_KEY>
```

Response:

```json
{"transaction":"<base64 challenge XDR>","network_passphrase":"Test SDF Network ; September 2015"}
```

The local helper validates the challenge with `WebAuth.readChallengeTx` from `@stellar/stellar-sdk`. Its arguments are, in order, the XDR, pinned signer, `Networks.TESTNET`, expected home domain, and web auth domain. In addition to SDK validation, require `clientAccountID` to match your public key, `matchedHomeDomain` to match the expected domain, and `memo` to be null. If `network_passphrase` is returned, it must match testnet.

Only a validated challenge is signed locally. **Do not submit the SEP-10 challenge to Horizon.**

```http
POST https://tr-mock-anchor.fly.dev/auth
Content-Type: application/json

{"transaction":"<validated and locally signed challenge XDR>"}
```

The response has the form `{"token":"<anchor JWT>"}`. Use this token only in anchor SEP-6 requests as `Authorization: Bearer ...`. When it expires, establish a new SEP-10 session using the same wallet.

### 6.3 Create a deposit and save its identity

```http
GET https://tr-mock-anchor.fly.dev/sep6/deposit?asset_code=USDC&account=<G_PUBLIC_KEY>&amount=200&funding_method=bank_account
Authorization: Bearer <ANCHOR_JWT>
```

`amount=200` means **200 mock TRY**, not 200 USDC. It is an example top-up amount, not an instruction to top up on every service call. The TRY→USDC exchange rate can change; do not assume a fixed USDC payout.

Before requesting a deposit, persist a local `creating` record; save the `id` as soon as the response arrives. The fields used from the response, abbreviated:

```json
{
  "id": "<deposit_id>",
  "instructions": {
    "bank_account_number": {"value":"<mock IBAN>"},
    "external_transfer_memo": {"value":"<mock reference>"}
  }
}
```

This is not the complete response schema. Additional fields such as `more_info_url` may be present. Do not send real money to the mock IBAN; use the sandbox endpoint in the next step.

**Known metadata discrepancy:** on September 18, `/health` and the anchor guide specified 50–3000 TRY for deposits, while the USDC section of `/sep6/info` returned `min_amount=0.5` and `max_amount=300`. Do not assume these values use the same unit. For mock TRY validation, use the current `/health.limits.min_onramp_try` and `max_onramp_try` fields; do not hardcode 50/3000 as skill product rules.

### 6.4 Simulate the bank transfer once

Persist `simulationAttempted=true` **before** simulation:

```http
POST https://tr-mock-anchor.fly.dev/sep6/tx/<deposit_id>/simulate-bank-transfer
Content-Type: application/json
Authorization: Bearer <ANCHOR_JWT>

{"amount":"200.00"}
```

This endpoint is not part of the SEP-6 standard; it is specific to this sandbox anchor. The local integration sends its JWT, while public anchor examples also show requests without a JWT; do not assume authentication is mandatory. Do not depend on the success payload; read the deposit status.

### 6.5 Track the same deposit

```http
GET https://tr-mock-anchor.fly.dev/sep6/transaction?id=<deposit_id>
Authorization: Bearer <ANCHOR_JWT>
```

Abbreviated result shape:

```json
{
  "transaction": {
    "id": "<deposit_id>",
    "status": "completed",
    "amount_in": "<TRY decimal string>",
    "amount_out": "<USDC decimal string>",
    "stellar_transaction_id": "<transaction hash>"
  }
}
```

Fields such as `amount_fee`, `completed_at`, and the transaction hash may be present depending on status. TRY uses 2 decimal places and USDC uses 7. `pending_user_transfer_start`, `pending_anchor`, and `pending_stellar` are pending states. If `pending_trust` appears, fix the trustline and continue with **the same deposit**. Treat `error`, `refunded`, and `expired` as terminal failures. An unknown status is not success.

After `completed`, check the Horizon balance for the same issuer and the transaction hash if available. Do not report a completed USDC top-up until you have seen the anchor's completion response and verified the balance increase.

### 6.6 Recover an interrupted top-up

The anchor provides no idempotency-key guarantee for deposit creation or simulation. Therefore:

- If the deposit GET response is lost and the ID is unknown, do not blindly create another deposit. Match the same wallet's history through `GET /sep6/transactions?asset_code=USDC`; notify the user if the match is ambiguous.
- If the simulation POST times out, query the same ID; do not automatically simulate it a second time.
- For a known ID, use `GET /sep6/transaction?id=...`. The anchor also documents querying by `stellar_transaction_id` or `external_transaction_id`.
- Client recommendation: use a local wallet/top-up lock, atomic file writes, bounded polling, and resume from the same record when the application restarts.

This flow requires no SEP-24 popup, web interface, or real personal KYC information. The current basic flow does not use SEP-38 rate locking. References: [anchor guide](https://tr-mock-anchor.fly.dev/sep), [full API reference](https://tr-mock-anchor.fly.dev/llms-full.txt), and [SEP-1 metadata](https://tr-mock-anchor.fly.dev/.well-known/stellar.toml).

## 7. Service invocation: input and persistent job identity

All services reject additional input fields. The HTTP JSON body may contain at most 32768 bytes; check this separately from text limits because multibyte characters and JSON escaping affect body size. Provider/model selection is not a public input.

### 7.1 Image generation

`image.generate` generates one square 1K PNG for **0.01 test USDC**. The server uses `google/nano-banana-2-lite`.

```json
{"prompt":"A small red sailboat on a calm turquoise sea, watercolor illustration."}
```

The only input field is `prompt`. Empty or whitespace-only values are not accepted. The upper limit is 4000 according to JavaScript string length; validation occurs before trimming, and leading/trailing whitespace is removed afterward. The result is in `output.images`.

### 7.2 Speech generation

`speech.generate` converts English text into **24 kHz WAV** narration for **0.02 test USDC**:

```json
{"text":"Meet Tide. The reusable bottle built for everyday adventures.","voice":"Craig (en)"}
```

`text` is required, nonempty after trimming, and at most 1000 Unicode code points before trimming. `voice` is optional; its exact allowed values are `Craig (en)` (default), `Olivia (en)`, `Dennis (en)`, and `Sarah (en)`. The result is `output.audio`, including the actual parsed `duration` in seconds. The text limit does not guarantee a narration of at most 30 seconds: use a short script for video composition and check the returned duration before creating the next job.

### 7.3 Slideshow and narration composition

`video.slideshow` turns ordered images into a silent **24 fps MP4** for **0.01 test USDC**:

```json
{
  "images": [
    {"url":"<signed image.generate output URL>","duration_seconds":5},
    {"url":"<signed image.generate output URL>","duration_seconds":5},
    {"url":"<signed image.generate output URL>","duration_seconds":5}
  ]
}
```

Provide 1–6 images in display order. Every image must come from a completed `image.generate` job, have matching dimensions, and be at most 2048 × 2048 pixels. Each `duration_seconds` is 0.5–30 seconds, rounded to milliseconds; their sum must be 1–30 seconds. Rendering uses cumulative frame boundaries rounded upward at 24 fps plus a provider tail frame, so the final duration may exceed the requested sum by up to two frames. The API checks the downloaded duration and rejects larger timing discrepancies. The result is `output.video`, with actual `duration` in seconds.

`video.compose` **version 2** adds narration to that slideshow for **0.01 test USDC**:

```json
{
  "video_url":"<signed video.slideshow output URL>",
  "audio_url":"<signed speech.generate output URL>"
}
```

Both media must be completed Algoria outputs of at most 30 seconds. The slideshow's actual duration must cover the narration. The result is `output.video`, with actual `duration` in seconds. The current merge ends at the narration duration, so use a 15–20 second narration for that target length. Use the separate slideshow step to preserve scene order; composition does not accept image arrays for new jobs. Existing version-1 composition jobs retain their original input contract for recovery.

### 7.4 Video captions

`video.caption` adds animated English subtitles for **0.02 test USDC**:

```json
{"video_url":"<signed video.compose output URL>"}
```

The source must be a completed, narrated `video.compose` result of at most 30 seconds. The result is an MP4 in `output.video`, with actual `duration` in seconds. Caption language, font, and animation settings are fixed by the service; they are not input options.

### 7.5 Source URLs and product-ad workflow

Video services accept only signed URLs of Algoria's bounded, completed outputs. External URLs/uploads, unfinished jobs, and outputs of the wrong service are rejected before a payment quote. A signed source URL grants access to that file; no upstream recovery token is included in the downstream input. URLs must be HTTPS, at most 4096 characters, and carry the storage signature. Source checks limit files to 10 MiB per image, 20 MiB for narration, and 40 MiB for video.

For each **new** downstream job, get current source URLs through authenticated upstream job GETs, verify dimensions/duration, and save its input before POSTing. The server validates source access before issuing the quote and refreshes links internally when submitting the accepted job to fal. After the downstream job has been created, retain its exact original input on every retry, even if those saved URLs have since expired. Do not replace URLs in an existing job's saved body; that is a different input and may produce `409 request-conflict`.

A product-ad flow uses three `image.generate` jobs for product scenes, one short `speech.generate` narration, one `video.slideshow` job whose scene durations cover that narration, one `video.compose` job to combine the two, then one `video.caption` job. Each of the seven jobs has its own UUID, recovery token, approved offer, receipt, and local record. Save the relationships between steps and resume the existing jobs after interruption. Reserve a total **0.09 test USDC** for the seven fixed-price calls; fal processing is billed separately to Algoria.

The repository's operator scripts prepare the additional service receiving wallets and exercise this workflow:

```sh
# From platform/; prepares testnet receiving accounts/trustlines and saves keys locally.
deno run -A --env-file=.env.local scripts/service-wallets.ts --testnet

# After configuring/deploying all five service recipients; invokes seven fal jobs.
deno run -A --env-file=.env.local scripts/demo-ad.ts --live

# Resume using the actual state filename saved by the previous invocation.
deno run -A --env-file=.env.local scripts/demo-ad.ts --live --resume=.local/ad-demo-UUID.json
```

Receiving-wallet setup is an operator task, not a skill-user requirement. The live demo uses the local test payer prepared by the payment helper, saves state before dispatch in ignored `.local/`, and writes the finished MP4 beside its state file. Running these commands consumes server capacity. `--reuse-media=.local/ad-demo-UUID.json` creates a new run that recovers the prior images and narration, and pays only for the three video steps. `--reuse-images=.local/ad-demo-UUID.json` instead retains only the three images and buys fresh narration plus video steps. `--resume` recovers the same current-format run. See the backend verification record for completed live tests.

### 7.6 Persistent job identity

Generate and persist the following **before** the first POST:

- `Idempotency-Key`: a UUID v4 normalized to lowercase (`crypto.randomUUID()`). This also becomes the `job_id`. Although the server accepts uppercase UUIDs, the database returns them in lowercase; compare normalized identities.
- `X-Recovery-Token`: 32 cryptographically random bytes encoded as unpadded base64url; 43 characters.
- API base, service ID/version/resource URL, input, selected network, and payment policy.

The server accepts recovery tokens matching `[A-Za-z0-9_-]{43,128}`. A token must not be a user password or predictable text. The server stores only its hash. If the token is lost, there is no endpoint to recover a job using the wallet address.

Each job response includes its immutable `service_version`. For the same job, the service, version, body, idempotency key, and recovery token remain fixed. `mode` and `wait_ms` may change. Different input under the same ID for the same recognized service returns `409 request-conflict`; an unknown service path returns `404 service-not-found`. Invalid-token access is hidden behind `404`.

## 8. Initial 402 → local signature → execution

The HTTP examples below use `image.generate`; the same payment flow applies to the other services with their own resource, input schema, recipient, and amount. They are templates; do not send `<...>` placeholders literally. Do not generate a new UUID on each retry.

### 8.1 Initial unpaid POST

```http
POST https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate?mode=sync&wait_ms=45000
Content-Type: application/json
Idempotency-Key: <SAVED_UUID_V4>
X-Recovery-Token: <SAVED_RECOVERY_TOKEN>

{"prompt":"A small red sailboat on a calm turquoise sea, watercolor illustration."}
```

This request does not start paid generation; it creates a time-limited job/offer record. The response is `402 Payment Required`, a `PAYMENT-REQUIRED` header, and a JSON body. The following example abbreviates `extensions`; use the actual challenge unchanged:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate",
    "description": "Generate one square 1K PNG image from a text prompt.",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "exact",
    "network": "stellar:testnet",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "amount": "100000",
    "payTo": "GCTVT52AAFK7KYO74JAO3QOLNT6BUYTCZYHTRD7C2VZG6C5CJNRVEV6Y",
    "maxTimeoutSeconds": 120,
    "extra": {"areFeesSponsored": true}
  }],
  "extensions": {},
  "job_id": "<SAVED_UUID_V4>",
  "expires_at": "<ISO timestamp>"
}
```

`PAYMENT-REQUIRED` is the base64-encoded standard x402 v2 challenge. Algoria adds `job_id` and `expires_at` to the JSON body; do not expect them in the header. The x402 SDK's `decodePaymentRequiredHeader` helper can decode it. Check consistency between the header and body for standard fields, and ensure the returned job ID matches the local ID.

The unpaid offer is valid for 10 minutes from job creation. `maxTimeoutSeconds=120` is the separate payment authorization lifetime. Do not treat them as a single timeout.

### 8.2 Validate before signing

The local helper must check all of the following:

- The request/response belongs to the trusted HTTPS Algoria base and the selected service's actual `resource` path.
- `x402Version=2`, `scheme=exact`, and `network=stellar:testnet`.
- The asset exactly matches the expected testnet USDC SAC address.
- `payTo` matches the service recipient approved for this job.
- `amount` is a positive atomic-unit string within both the per-call limit and the remaining total spending budget.
- `extra.areFeesSponsored=true`; the timeout is positive and, under the current contract, no more than 120 seconds.
- The input, job ID, and previous local record are unchanged; no other unresolved payment attempt exists for the same job.

After these checks, atomically reserve the amount in the local budget **before signing or sending the HTTP request**. Parallel calls must not spend the same remaining budget. The user's configured spending policy applies; no mandatory web approval is added to every call. Topping up does not authorize unlimited service spending.

Preserve every field of the selected original offer from `accepts`, especially its `extra` fields. The server compares the payment payload's `accepted` requirements exactly against the requirements saved with the job. Do not reconstruct an offer using only amount/payTo.

### 8.3 Local x402 signature

Verified version combination:

```text
@x402/core     2.22.0
@x402/stellar  2.22.0
@stellar/stellar-sdk 16.2.0
```

The following Deno/TypeScript example illustrates only the local signing layer. A trusted helper process reads the wallet file; the secret key is not supplied through an LLM prompt or tool argument. The calling layer must already have persisted the job, validated the challenge, and atomically reserved the budget.

```ts
import { x402Client } from 'npm:@x402/core@2.22.0/client';
import { encodePaymentSignatureHeader } from 'npm:@x402/core@2.22.0/http';
import type { PaymentRequired } from 'npm:@x402/core@2.22.0/types';
import { createEd25519Signer } from 'npm:@x402/stellar@2.22.0';
import { ExactStellarScheme } from 'npm:@x402/stellar@2.22.0/exact/client';
import { Keypair } from 'npm:@stellar/stellar-sdk@16.2.0';

const NETWORK = 'stellar:testnet';
const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

export async function signApprovedChallenge(
  challenge: PaymentRequired,
  walletPath: string,
  expectedResource: string,
  expectedPayTo: string,
  reservedAmountAtomic: string,
): Promise<string> {
  if (
    challenge.x402Version !== 2 ||
    challenge.resource?.url !== expectedResource ||
    !/^[1-9]\d*$/.test(reservedAmountAtomic)
  ) throw new Error('Unexpected challenge');

  const approved = challenge.accepts.filter((offer) =>
    offer.scheme === 'exact' &&
    offer.network === NETWORK &&
    offer.asset === ASSET &&
    offer.payTo === expectedPayTo &&
    offer.amount === reservedAmountAtomic &&
    offer.extra?.areFeesSponsored === true &&
    Number.isInteger(offer.maxTimeoutSeconds) &&
    offer.maxTimeoutSeconds > 0 && offer.maxTimeoutSeconds <= 120
  );
  if (approved.length !== 1) throw new Error('No unique approved offer');

  const wallet = JSON.parse(await Deno.readTextFile(walletPath));
  if (
    wallet.network !== NETWORK ||
    Keypair.fromSecret(wallet.secretKey).publicKey() !== wallet.publicKey
  ) throw new Error('Invalid local testnet wallet');

  const client = new x402Client().register(
    NETWORK,
    new ExactStellarScheme(createEd25519Signer(wallet.secretKey, NETWORK)),
  );
  const payload = await client.createPaymentPayload({
    ...challenge,
    accepts: approved,
  });
  return encodePaymentSignatureHeader(payload);
}
```

For Node, install the same versions through npm and remove the `npm:` prefix and version suffix from imports; adapt local file reads to the Node API. Revalidate the payment flow whenever changing SDK versions.

The SDK signs the Stellar/Soroban payment authorization. **The client does not separately transfer USDC, submit the payment transaction to Horizon, or call the facilitator's `/settle` endpoint.** The Algoria backend settles payment through the facilitator. This signature is separate from the SEP-10 login signature. The server validates a single SAC transfer authorization and its recipient/amount.

### 8.4 Send the same POST with the payment header

```http
POST https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/services/image.generate?mode=sync&wait_ms=45000
Content-Type: application/json
Idempotency-Key: <SAME_SAVED_UUID_V4>
X-Recovery-Token: <SAME_SAVED_RECOVERY_TOKEN>
PAYMENT-SIGNATURE: <SDK_ENCODED_PAYMENT_PAYLOAD>

{"prompt":"A small red sailboat on a calm turquoise sea, watercolor illustration."}
```

The header is not raw JSON; it is the SDK-encoded x402 v2 payload. Its maximum size is 32768 bytes. Because the signed header carries transfer authorization, do not write it to logs or chat output. If retained for recovery, protect it like other local secrets. Do not reuse it for another job.

Backend sequence: validate the offer/payment → reserve capacity → settle → save the receipt → submit to the provider once → wait for the result or return 202. Discovery metadata is not forwarded to the facilitator; this payment does not register the service in an external catalog.

## 9. Sync, async, and media results

Defaults are `mode=sync` and `wait_ms=45000`. `wait_ms` is an integer from 0–60000. `mode=async` skips waiting for completion, but any supplied wait parameter is still validated.

`wait_ms` is not a strict upper bound on total HTTP duration. Payment verification, settlement, and provider submission are mandatory steps and may exceed it. Even `wait_ms=0` does not skip payment/startup; the client then tracks the job through a 202 response.

- A sync request returns `200` if it prepares the completed result within the wait period.
- If more time is needed, it returns `202` and **the same job**; no second payment or new job is required.
- Async returns `202` after accepting a new job. An async retry for an already completed job may return `200`.
- Losing the HTTP connection does not cancel the job.

Client recommendation: use approximately a 90-second timeout for POST and 45–60 seconds for job GET. These are not API guarantees; GET may take time while refreshing provider status and persisting output. Always recover a timeout through the same job.

Pending job example:

```json
{
  "job_id": "<SAVED_UUID_V4>",
  "service_id": "image.generate",
  "service_version": "1",
  "status": "queued",
  "status_url": "https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/jobs/<SAVED_UUID_V4>",
  "poll_after_ms": 3000,
  "payment": {
    "success": true,
    "network": "stellar:testnet",
    "transaction": "<transaction hash>",
    "payer": "<G_PUBLIC_KEY>"
  },
  "output": null,
  "error": null
}
```

Polling request:

```http
GET https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/jobs/<SAVED_UUID_V4>
Authorization: Bearer <SAVED_RECOVERY_TOKEN>
```

POST carries the recovery token in `X-Recovery-Token`; GET uses `Authorization: Bearer`. Do not put it in a URL/query. Before using `status_url`, verify that it belongs to the expected API base and job path; do not redirect this bearer token to another host.

Successful image job example:

```json
{
  "job_id": "<SAVED_UUID_V4>",
  "service_id": "image.generate",
  "service_version": "1",
  "status": "succeeded",
  "status_url": "https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api/v1/jobs/<SAVED_UUID_V4>",
  "payment": {
    "success": true,
    "network": "stellar:testnet",
    "transaction": "<transaction hash>",
    "payer": "<G_PUBLIC_KEY>"
  },
  "output": {
    "images": [{
      "url": "<private storage signed URL>",
      "content_type": "image/png",
      "width": 1024,
      "height": 1024
    }],
    "url_expires_in": 3600
  },
  "error": null
}
```

`width`, `height`, and `file_size` are optional metadata. The image service targets PNG; its output schema accepts PNG/JPEG/WebP, and the actual `content_type` is authoritative. Speech and video use the same job envelope with a service-specific output:

```json
{
  "audio": {
    "url": "<private storage signed WAV URL>",
    "content_type": "audio/wav",
    "file_size": 720044,
    "duration": 15
  },
  "url_expires_in": 3600
}
```

```json
{
  "video": {
    "url": "<private storage signed MP4 URL>",
    "content_type": "video/mp4",
    "file_size": 1048576,
    "duration": 15
  },
  "url_expires_in": 3600
}
```

These sizes and durations are illustrative. Audio/video `duration` is parsed from the actual output in seconds; use it when constructing a downstream composition. The shared schema permits optional `file_size` and `duration`; clients should require usable duration metadata before starting a dependent video step. Not every receipt includes `payment.amount`; obtain the amount from the job's saved offer. Account for a receipt only once, using `job_id` and transaction hash.

A successful payment receipt may appear in the JSON `payment` field and in the base64-encoded `PAYMENT-RESPONSE` header, which the SDK's `decodePaymentResponseHeader` can decode. The same receipt also appears in subsequent GET/retry responses. This is not a new payment.

Media are stored in private Supabase Storage; the supplied signed URL is valid for 3600 seconds. Anyone with the URL can read the file. When downloading it, **do not send the Algoria recovery token or anchor JWT**. If the URL expires, obtain a new one through an authenticated job GET; do not regenerate or pay again. If the user wants a persistent local file, download the media on the client; the service does not guarantee indefinite retention. Renewed links can be used for a new downstream job; existing downstream jobs continue with their originally saved input as described in section 7.5.

## 10. State machine and recovery rules

An authenticated job GET returns **HTTP 200** for a known job, including failed/uncertain states. Determine success from `body.status`, `output`, and `payment`, not the HTTP code alone.

- **`awaiting_payment`**: No confirmed settlement yet. Use the same POST for a challenge; GET does not produce a 402 challenge. If local history contains an unresolved dispatched authorization, reconcile it first; this status alone does not justify generating a new signature.
- **`settling`**: Payment is being processed; poll. Repeating POST does not start a second settlement. A record unchanged for more than 90 seconds may be presented as `payment-uncertain`.
- **`payment-uncertain`**: The payment outcome is unknown. Do not create a new nonce/signature, job, or payment. Retain the local budget reservation; an operator must reconcile blockchain/facilitator records.
- **`paid`**: Payment is complete; provider submission has not started. **GET does not advance this job.** Repeat POST with the same input + `Idempotency-Key` + `X-Recovery-Token`, **without PAYMENT-SIGNATURE**. No new charge occurs.
- **`submitting`**: Provider submission is in progress; poll. A record unchanged for more than 30 seconds may be presented as `submission-uncertain`.
- **`submission-uncertain`**: The provider may have accepted the request; do not start a new generation/job. An operator must reconcile provider request history.
- **`queued`, `running`, `saving`**: Poll the same job. GET may advance status/result retrieval for the existing provider request and storage persistence; it does not initiate another payment or generation.
- **`result-ready`**: Generation and persistence are complete, but a signed URL could not be prepared within that response's wait budget. Obtain a current URL through job GET.
- **`succeeded`**: Present the media, save the receipt once, and mark the local job complete. A dependent workflow step can now use this output.
- **`failed`**: Terminal service error. Payment may have succeeded. Show the error and receipt together. Do not automatically refund or start a new paid generation; another generation is a separate expense.

General recovery algorithm:

```text
If no local record exists:
  select service → save id/token/input → unpaid POST → validate offer
  reserve budget → sign locally → save dispatch intent → send the same POST

If a local record exists or the HTTP outcome is uncertain:
  do not generate a new id; GET the same job first
  succeeded/result-ready → retrieve the result
  paid → resume the same POST without the payment header
  queued/running/saving/settling/submitting → poll the same job at bounded intervals
  awaiting_payment → inspect local payment history; request an offer through the same POST if needed
  uncertain → preserve state and request operator reconciliation
  failed → show the error and receipt; do not generate again automatically
  404 → verify base/id/token; attempt recovery through the same POST rather than switching to a new id
```

Use `poll_after_ms` or `Retry-After` for polling; the normal value is 3000 ms / 3 seconds. They are not required on every 202 response; a 3-second starting interval is suitable when absent. Client recommendation: use jitter, backoff for transient errors, an overall time/attempt limit, and resume in the next session. Without a background worker, do not promise tracking while the application is closed.

If the response to a POST carrying a payment header is lost, the first action must not be a new payment signature. Even a controlled retry of the same signed authorization must first be reconciled against job status. Do not release the budget reservation or sign with a different nonce until the authorization is proven to have definitively failed or remained unspent.

## 11. Error reference and client decisions

The general error format is `{"code":"...","message":"..."}`. Not every error type requires `message`. Payment errors may return a receipt, and terminal generation errors may return a complete job body.

### 400 / 413 / 415 — correct the request

- `400 invalid-pagination`, `query-required`: correct the discovery query.
- `400 invalid-execution-mode`: invalid mode or wait_ms.
- `400 request-identity-required`: missing or malformed UUID/token.
- `400 invalid-json`, `invalid-input`: the body does not satisfy the selected service's contract.
- `400 invalid-source`, `source-size-or-type`, `source-image-limit`, `source-duration-limit`, `image-size-mismatch`, `narration-too-long`: a video source or scene duration does not satisfy the constraints in section 7. Correct a new job's inputs before payment; preserve an existing job's original body when resuming.
- `400 source-unavailable`: a new job's source URL cannot be accessed; obtain a fresh URL from the source job before creating the downstream request.
- `400 payment-header-too-large`, `invalid-payment-payload`: invalid payment header format/size.
- `413 body-too-large`: the JSON body exceeds 32768 bytes.
- `415 json-required`: `Content-Type: application/json` is required.

### 402 — identify the type first

**Actual offer**: includes a `PAYMENT-REQUIRED` header and standard `accepts`. Sign only after validation and budget checks.

**Payment validation rejection**: may use `accepted_requirements_mismatch`, `invalid_stellar_authorization`, `verification_failed`, or a facilitator error code; the challenge header may be absent. Do not automatically generate a new signature for every 402.

Example of **definitive settlement failure**:

```json
{
  "code": "payment-failed",
  "job_id": "<SAVED_UUID_V4>",
  "payment": {
    "success": false,
    "network": "stellar:testnet",
    "transaction": "",
    "errorReason": "<reason>"
  }
}
```

Check the same job first. Once definitive failure is reconciled, the same unpaid job may obtain a new offer/authorization; validate the budget again. The failed attempt's fingerprint is also recorded; do not resend the same signature indefinitely.

### 404 / 409 — check identity and payment history

- `404 service-not-found`: recheck the service in the catalog; it may be unknown or disabled for new jobs. Existing jobs remain resumable through their original service endpoint.
- `404 job-not-found`: the job does not exist or the token is incorrect. There is no alternative wallet-based authentication.
- `404 not-found`: incorrect route.
- `409 request-conflict`: different input under the same ID for the same recognized service. An unknown service first receives 404 during route validation.
- `409 quote-expired`: the unpaid offer has expired. Do not create a new job before confirming that no dispatched/uncertain authorization exists for the previous job.
- `409 payment-already-used`: the payment authorization has already been used. It cannot be transferred to another job. An authorization consumed on-chain may also be rejected with 402 during verification.

### 429 — server capacity

- `demo-capacity-exhausted`: the global total or concurrent job capacity is full.
- `quote-capacity-exhausted`: unpaid offer capacity is full.

These are not user USDC balance errors. Topping up, creating a new wallet, or generating a new job ID does not resolve them. If a local payment attempt exists, check that job's status first; do not blindly sign and resend. If capacity remains exhausted, an operator must adjust the configuration.

### 502 / 503 — resume the same job

- `502`: POST may return a terminal `failed` job. The body has the job shape; example `error.code` values are `generation-failed`, `empty-result`, and `provider-rejected`. Inspect the payment receipt separately.
- `503 temporarily-unavailable`, `facilitator_timeout`, `facilitator_unavailable`, `facilitator_payer_mismatch`, or other facilitator errors: recover using the same job record. A timeout does not mean that no money moved.
- `503 source-unavailable`: the source check could not complete. Retry the new request without paying; do not treat this as a payment challenge.

Do not interpret an unexpected error code as an instruction to make a new payment. When logging errors, redact payment/recovery headers, JWTs, secrets, and signed URL query strings.

## 12. What exactly is the “demo limit”?

The backend has an **operator setting** to control fal costs. The deployed setting is **30 paid service attempts in total** across all five services and **2 active jobs at a time**. The original migration default is 10 total attempts; the operator raised the deployed total to 30 for repeated demos, keeping concurrency at 2. A complete product-ad workflow consumes seven attempts. This is not a per-user or daily product quota, nor a membership/plan feature requested by the user.

Successful jobs and provider failures consume the total quota. A definitive settlement rejection releases the reserved capacity; uncertain payment/submission records retain it. Separately, at most 1000 unpaid offers are retained; when the limit is reached, expired records without payment attempts may be pruned.

An operator can change the setting through `public.demo_settings`. There is no public endpoint to read or modify capacity. Do not hardcode product rules such as “you have 10 images” or “7 remaining” into the skill. The skill manages its own local budget and treats an API 429 as server capacity.

## 13. Local state and separation of secrets

The model below is a client recommendation, not a file format provided by Algoria. A JSON file or local database may be used.

- **Wallet record:** testnet network, public key, and protected secret-key reference/file. The wallet address may be shown to the user; the secret must not be.
- **Spending policy:** allowed API host/network/asset, per-call limit, total limit, and spent/reserved atomic amounts. Budget checks across parallel jobs must be atomic.
- **Job record:** id, recovery token, API base, service ID/version/resource, exact input, approved offer, quote expiry, local dispatch state, last server status, receipt/transaction hash, and local output path if any.
- **Payment attempt:** signing/dispatch intent and timestamp, reconciliation state, and protected signed header if needed. Do not create two unresolved authorizations for the same job.
- **Top-up record:** wallet, mock TRY amount, creating marker, deposit ID, simulationAttempted, last status, and blockchain hash.

Client recommendation for Unix: a `0700` state directory, `0600` private files, writes through a temporary file followed by atomic rename, and wallet/job locks. Do not add these secrets to git or shared artifacts. Logs can be correlated through nonsecret job IDs, statuses, and transaction hashes.

Keep the three forms of authorization separate:

1. The wallet secret never leaves the local signing layer.
2. The anchor JWT is sent only to the `tr-mock-anchor.fly.dev` authentication/transfer flow.
3. The job recovery token is sent only for the corresponding Algoria API job.

Expose operation results, the public wallet address, balance, job ID, safe errors, and media to the LLM layer. Generate and send payment headers inside the trusted helper; there is no need to pass a header through model output.

## 14. Acceptance tests for the skill developer

Run tests that do not require payment/generation using fixtures and a fake transport. A real end-to-end call incurs real fal costs for Algoria even though it uses testnet USDC; use a limited number for necessary validation.

1. **Discovery:** query/filter/pagination finds the enabled services and uses each actual resource/input_schema/accepts. Five-service fixtures retain five distinct recipients; disabled services are omitted.
2. **Input:** empty, excessively long, or extra-field input is rejected locally. Image, speech, slideshow, composition, and caption inputs follow their own schemas. Reject unsupported voices, external/wrong-type source URLs, mismatched image dimensions, and scene totals that exceed 30 seconds or truncate narration before paying.
3. **Wallet:** created on first use and the same address loaded on subsequent runs; the private key never appears in prompts/logs.
4. **Top-up:** XLM and trustline checks → SEP-10 → one deposit → one simulation → completion/Horizon verification. TRY and USDC units are not confused.
5. **Anchor interruption:** a lost deposit or simulation response does not create a second deposit/simulation; recovery uses the saved record and history.
6. **402:** incorrect network/asset/payTo/resource/amount/sponsorship information is not signed; a normal challenge is processed through the SDK. A 402 without a challenge header does not initiate a new payment.
7. **Sync success:** 200 + succeeded + service-appropriate media + successful receipt are saved once. Audio/video duration comes from the actual response.
8. **Async:** after 202, GET tracking with the same ID/token retrieves the result without a second payment.
9. **Sync fallback:** a short wait_ms produces 202, followed by the same job's result. This is not a separate generation.
10. **HTTP loss/restart:** resume from the local record after a paid POST response is lost or the application closes; preserve the ID/token and exact input, including saved source URLs. Recover each workflow step without creating duplicate jobs.
11. **Paid interval:** if GET returns `paid`, start the provider through the same POST without the payment header; do not remain stuck polling.
12. **Uncertain states:** payment-uncertain/submission-uncertain do not create a new authorization or job; retain the budget reservation.
13. **Budget:** two parallel jobs cannot exceed the total limit; a repeated receipt is not counted as another expense. Do not attempt to resolve 429 by topping up.
14. **Authorization and idempotency:** wrong token returns 404, same ID/different input returns 409; rereading or POSTing a completed job does not charge again.
15. **Output:** renew an expired signed URL through job GET. Do not attach Algoria/anchor credentials to the media request. Fresh URLs are used for new downstream jobs; they do not overwrite an existing job's saved input.
16. **Generation failure:** handle HTTP 200 with job status=failed separately from POST 502; show any successful payment to the user and do not promise an automatic paid retry/refund.
17. **Product-ad chain:** three images → narration → slideshow → composition → captions yields one final MP4 and seven distinct job receipts totaling `900000` atomic test USDC. Source-validation failures do not trigger a paid provider call; disabling a service prevents new jobs while existing ones remain resumable.

The backend passes 76 automated tests. Initial live tests covered image sync, async, and sync→202 fallback. The final five-service workflow produced a 16.58-second narrated, captioned advertisement with seven distinct job receipts; existing images/narration were recovered without repaying. See the backend verification record for exact jobs and media checks. This evidence concerns the backend and demo helper; the unwritten skill has not been tested.

## 15. Code references and handoff scope

Sources for developers with repository access:

- [API routes and job flow](../supabase/functions/api/app.ts)
- [Discovery, JSON Schema, and OpenAPI](../supabase/functions/api/services.ts)
- [Service definitions and input normalization](../supabase/functions/api/catalog.ts)
- [Video source validation and refresh](../supabase/functions/api/sources.ts)
- [x402 and Stellar validation](../supabase/functions/api/payments.ts)
- [Job identity and token validation](../supabase/functions/api/security.ts)
- [Database state transitions](../supabase/functions/api/store.ts)
- [Local test signing helper](../scripts/payment-client.ts)
- [Existing end-to-end test flow](../scripts/e2e.ts)
- [Seven-job product-ad demo and resume flow](../scripts/demo-ad.ts)
- [Operator setup for service receiving wallets](../scripts/service-wallets.ts)
- [Backend verification record](../VERIFICATION.md)

Standards: [Stellar x402 guide](https://developers.stellar.org/docs/build/agentic-payments/x402), [SEP-10 guide](https://developers.stellar.org/docs/build/apps/example-application-tutorial/anchor-integration/sep10), and [Bazaar extension contract](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md). For Algoria-specific recovery headers, job states, and input limits, this API's contract is authoritative.

The next developer's task is to connect discovery, local wallet/top-up, controlled x402 payment, persistent job recovery, and media presentation to the skill environment using this HTTP contract, including dependent steps in a product-ad workflow. Check discovery for the target deployment's enabled services. Skill packaging, command names, and any future MCP tools are outside this document's scope and will be chosen during that implementation.
