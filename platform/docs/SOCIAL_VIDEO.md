# Social video service

`video.social` is a discoverable HTTP/x402 service, not a new skill. It runs on the
existing Supabase API project. fal performs all image/audio generation, slideshow
rendering, audio merging and captions. Supabase orchestrates short persistent
steps and holds private reference/output files; it does not run FFmpeg.

## Conversation and contract

All discovered services follow the plugin's shared planning guidance. The agent
explains its intended work, expected output and estimated total cost, discusses
revisions, and obtains missing plan/budget authorization. For this service the
approved input contains the brief, ordered scene prompts, exact narration,
reference roles, voice and captions choice. The server executes that immutable
plan; it does not invent new narration after approval. No server-side LLM key is
required. A generic natural-language-only HTTP request is not the service contract;
the conversational client compiles the plan for a nontechnical user.

Defaults: five scenes in conversation, Olivia's English female voice, captions,
vertical 9:16 output. The schema permits 1–5 scenes, 0–4 references and four preset
English voices. Reference roles are product, person or style. A product-only ad
works without a person photo, and text-only generation works without references.
The output is a still-image sequence with narration and optional animated captions,
not generated live-action clips or a talking avatar. No automatic Instagram/TikTok
posting occurs.

The fixed package price is **0.11 test USDC**, including any internal stages, even
when the approved plan uses fewer scenes or disables captions. Live discovery and
the definitive x402 quote are authoritative. Real fal provider fees are borne by
the service operator and are separate from testnet USDC.

## API

- `GET /v1/services/video.social`: live schema, payment requirements, planning and
  reference-upload instructions. Also included in `/discovery/resources` and search.
- `POST /v1/references/{uuid_v4}`: raw PNG/JPEG/WebP, maximum 10 MB, with a random
  `X-Recovery-Token`. Save UUID/token before upload. Returns a private signed URL.
  Repeating the same UUID/token/bytes refreshes its URL; changed content is rejected.
  Demo admission is bounded to 200 stored references total. Operators must manage
  retention; this release does not expose deletion or unlimited upload storage.
- `POST /v1/services/video.social`: the normal saved Idempotency-Key, recovery token,
  402 offer and x402 payment flow. One user purchase and one capacity reservation.
- `GET /v1/jobs/{id}`: authenticated status, progress and final signed MP4 URL.
  It can advance internal stages already authorized by the paid plan, without a
  new payment or repeated generation. Ordinary standalone jobs keep their original
  status behavior.

References must be uploaded through this API and their signed capability must be
valid when the quote is created. Once admitted, the same persisted input is used
on retries and the server refreshes its reference links internally. Arbitrary
external URLs are not fetched. Files are forwarded only to fal for this workflow.

The existing plugin CLI can upload an attachment without introducing a new skill:

```sh
node /absolute/plugin/skills/algoria-pay/scripts/pay.mjs upload-reference /absolute/photo.png --json
# After interruption / before a fresh quote:
node /absolute/plugin/skills/algoria-pay/scripts/pay.mjs upload-reference /absolute/photo.png --id SAVED_UUID --json
```

## Execution and recovery

Five image submissions and speech start concurrently. With reference photos the
image provider is fal's Nano Banana 2 edit endpoint; text-only plans use the existing
Nano Banana 2 Lite endpoint. After WAV duration is verified, scene holds are
allocated in 24 fps frames covering the narration. The existing fal
`images-to-video` then `merge-audio-video` endpoints render the result. Optional
`auto-subtitle` follows. Generated media is downloaded with the existing bounded,
trusted-host validators, then retained in private storage.

English narration is capped at 500 characters / 65 words; recommend 15–25 seconds.
Actual audio over 29.8 seconds or video over 30.05 seconds fails the job rather
than clipping speech. Up to 0.2 seconds of render timing variance is accepted.
Images must have consistent dimensions and approximately 9:16 aspect ratio.

A PostgreSQL parent lease fences step updates. `submitting` is persisted before
any provider dispatch; accepted fal IDs are saved before later stages. Signed fal
callbacks, authenticated status and a one-minute cron recovery tick share that
lease. A stopped browser/client does not stop the job. Download/storage failures
reuse the existing provider ID. Lost provider acceptance produces
`submission-uncertain` and holds capacity for operator reconciliation; there is
no automatic provider resubmission or refund. A definitive failed stage retains
completed artifacts and the payment receipt. A new generation needs a new decision.

## Deployment

Target is the existing **algoria-platform-dev** Supabase project
`vqqbvydiehuwdzbgvmun`, Stellar testnet only. No external 8004 registration is
implied by Algoria catalog discovery.

Run these sequentially from `platform/`:

```sh
deno run -A --env-file=.env.local scripts/service-wallets.ts --testnet
node scripts/social-deploy.mjs
node scripts/infra.mjs secrets
node scripts/infra.mjs deploy
```

The additive `202609190001_social_video` migration preserves existing jobs and
payment RPCs. The deployment helper records migration history, creates/updates a
Vault workflow credential and schedules the bounded recovery tick through pg_cron
and pg_net. Only this credential authorizes `/internal/social/tick`; request bodies
do not select jobs or spend amounts. Existing environment values and recipient
keys stay local. Do not run wallet/config writers concurrently.

To disable new purchases remove the social recipient configuration; retain the
workflow runtime to recover existing paid jobs. Disable the cron task separately
only after pending jobs have been reconciled.

## Verification

```sh
deno task check
deno task test
deno lint supabase/functions/api scripts
# Explicit paid live test; one 0.11 test USDC purchase and real fal usage:
deno run -A --env-file=.env.local scripts/social-e2e.ts --live --input=.local/approved-plan.json --reference=.local/product.png
# Never start a new run after a lost paid response:
deno run -A --env-file=.env.local scripts/social-e2e.ts --live --resume=.local/social-e2e-UUID.json
```

The live helper retains request identity and dispatch state before payment, polls
only that job, verifies MP4 duration/aspect ratio and checks terminal idempotency.
The reference flag is a PNG product-reference convenience for the demo; the API
and plugin upload helper support PNG, JPEG and WebP.

### Live verification, 2026-09-19

Job `7991c0dd-8770-4486-a4e7-318ca9c2eafa` completed a product-only reference
workflow with five images, Olivia narration and captions. PostgreSQL confirmed
**one payment attempt, nine steps and nine distinct fal request IDs**. The final
MP4 is 768 × 1376, 24 fps, H.264/yuv420p + AAC, 13.62 seconds, 1,214,338 bytes.
Terminal POST retry returned the same transaction/output. The cron task was
active and its most recent execution succeeded. A clean packaged plugin without
node_modules discovered the new service and its upload contract.

The first run exposed fal's edit response returning null width/height metadata.
The service now reads bounded PNG IHDR dimensions directly, covered by regression
tests. After independently checking the existing five PNGs, the operator resumed
the incorrectly failed retrieval steps using their saved fal IDs. No image was
regenerated and no second payment was made. This was an evidence-backed repair of
this test job, not an automatic retry policy for failed paid jobs.

Payment transaction:
`43e58fb80e43b2c7aab0ee6f5b7c119a85b16c5d14baa9873d9546aa05dcb980`.

Validation: 84 backend tests, 222 plugin tests, TypeScript/Deno checks, Deno lint,
skill and plugin validators. Video/audio streams and representative captioned
frames were inspected locally. No person-reference identity test was performed;
that optional mode accepts the same multi-reference edit contract.
