# Algoria API

Independent hackathon API in `platform/`. TypeScript + Hono, Supabase Edge Functions/Postgres/Storage,
Stellar testnet x402, and fal's persistent media queues.

Base URL: `https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api`

For the future local wallet/skill client, see the
[skill integration handoff](docs/SKILL_INTEGRATION.md): discovery, mock-anchor top-up,
x402 signing, sync/async execution, persistent recovery, and acceptance tests.

## Use the API

- `GET /discovery/resources`: Algoria's own service catalogue; filters `type`, `network`, `scheme`, `payTo`, `extensions`, `limit`, `offset`.
- `GET /discovery/search?query=image`: simple service search.
- `GET /v1/services/{service_id}`: complete request schema, payment conditions, execution modes.
- `GET /openapi.json`: HTTP contract.
- `POST /v1/services/{service_id}?mode=sync`: pay for and execute the selected service.
- `GET /v1/jobs/{job_id}`: recover status, payment receipt and output.

The five implemented services share the same payment and job contract. Discovery lists only enabled services:

- `image.generate`: `{ "prompt": "A red sailboat, watercolor illustration" }`, 1–4000 characters;
  one square 1K PNG. **0.01 test USDC** (`100000` atomic units).
- `speech.generate`: `{ "text": "Meet Tide, your everyday bottle.", "voice": "Craig (en)" }`;
  nonempty English text up to 1000 characters. Optional voice is `Craig (en)` (default),
  `Olivia (en)`, `Dennis (en)`, or `Sarah (en)`. Returns 24 kHz WAV and its actual duration in seconds.
  **0.02 test USDC** (`200000` atomic units).
- `video.slideshow`: `{ "images": [{ "url": "<signed image URL>", "duration_seconds": 15 }] }`;
  1–6 completed Algoria images of matching dimensions. Each scene lasts 0.5–30 seconds; their sum
  must be 1–30 seconds. Returns an ordered 24 fps silent MP4 with its actual duration.
  **0.01 test USDC** (`100000` atomic units).
- `video.compose` (version 2): `{ "video_url": "<signed slideshow URL>",
  "audio_url": "<signed narration URL>" }`; adds a completed `speech.generate` output to a
  `video.slideshow` output. The video must cover the narration, and both must be at most 30 seconds.
  Returns MP4 and its actual duration. **0.01 test USDC** (`100000` atomic units).
- `video.caption`: `{ "video_url": "<signed composition URL>" }`; a completed `video.compose`
  output of at most 30 seconds. Adds animated English subtitles and returns MP4 with actual duration.
  **0.02 test USDC** (`200000` atomic units).

No provider/model/quality selection is exposed. Video inputs accept current signed URLs of Algoria's
bounded, completed outputs; external uploads are not accepted. Sources are validated before a quote
and their links refreshed internally at provider submission. For a new downstream job, retrieve fresh
source URLs through authenticated job GETs before saving its input. Once a job exists, preserve that
exact original input on retries, including its saved URLs.

Before the first request for each job, the client generates and saves two values:

1. A UUID v4 sent as `Idempotency-Key`.
2. A random 32-byte base64url secret sent as `X-Recovery-Token`.

An unpaid call returns standard x402 v2 `402` with `PAYMENT-REQUIRED`. A local wallet signs the
Stellar testnet authorization. Repeat the same input and headers with `PAYMENT-SIGNATURE`.
Each service has its own receiving wallet and fixed price listed above; use its actual 402 offer.

`sync` is the default, with a 45-second waiting budget; `wait_ms` accepts 0–60000. Payment and provider
submission are mandatory acceptance steps; a very short wait does not skip them. Completion within the
remaining budget returns `200` with media and receipt. Otherwise `202` returns the same job and status URL.
`mode=async` returns `202` after acceptance. Poll using `Authorization: Bearer <recovery token>`.
`result-ready` means generation/storage finished but a result URL could not be delivered within this
response's waiting budget; the status endpoint returns a fresh link.

Keep the same identity/input/token on retries, including after network loss or a mode change. Never
make a fresh payment just because a request timed out. Terminal retries reuse the receipt and output.
Different input under an existing ID returns `409`. Lost recovery tokens cannot be recovered from a
wallet address; there are no hosted user accounts.

Outputs live in a private Supabase Storage bucket. Response URLs expire after one hour; authenticated
job polling issues a fresh URL. No payment or generation occurs on status reads.
Disabling a service prevents new POST jobs; existing jobs can still be recovered and resumed.

The API publishes Bazaar metadata locally. Payment verification/settlement sends only payment fields
to the facilitator, excluding discovery metadata. No third-party service registration or external
catalogue publication is performed.

## Development and checks

Run from this directory. Deno 2.9.6 was used; `npx --yes deno@2.9.6` can substitute for `deno`.

```sh
deno task check
deno task test
deno lint supabase/functions/api scripts
deno task dev
```

`.env.local` holds local configuration. Copy `.env.example` when setting up another machine.
For local development set `ALGORIA_API_BASE_URL` to a reachable HTTPS endpoint if testing live fal
callbacks. Unit tests use injected providers and a PostgreSQL WASM instance, with no payments or fal spend.

`scripts/payment-client.ts` is an integration-test signing helper, not the future wallet/skill product.
Local wallet JSON files and integration receipts are stored in ignored `.local/`, mode 0600.

Live tests each generate **one paid fal image** and spend **0.01 test USDC**:

```sh
deno run -A --env-file=.env.local scripts/e2e.ts sync --live
deno run -A --env-file=.env.local scripts/e2e.ts async --live
deno run -A --env-file=.env.local scripts/e2e.ts fallback --live
```

Each test preserves the job ID and recovery token in `.local/` before any payment. It validates
discovery, 402, settlement, output availability, access control, idempotent retries and input conflicts.

The product-ad demo chains **three images → narration → slideshow → composition → captions** into a narrated MP4.
Its seven jobs invoke fal seven times and spend **0.09 test USDC** in total
(`3 × 0.01 + 0.02 + 0.01 + 0.01 + 0.02`). Testnet payment does not make fal processing free.
The operator prepares the four additional service receiving wallets once, then deploys their public
addresses and prices with the API configuration. Keys stay in ignored local files:

```sh
deno run -A --env-file=.env.local scripts/service-wallets.ts --testnet
deno run -A --env-file=.env.local scripts/demo-ad.ts --live
deno run -A --env-file=.env.local scripts/demo-ad.ts --live --resume=.local/ad-demo-UUID.json
```

The demo saves each step's input, ID, recovery token, and payment state before dispatch. Resume with the
actual saved filename to recover those same jobs. Its final MP4 is saved beside that state file.
Use `--reuse-media=.local/ad-demo-UUID.json` instead of `--resume` to reuse a completed run's three images and narration while buying only the three video steps. `--reuse-images=.local/ad-demo-UUID.json` retains only the images and buys fresh narration plus video steps. See [VERIFICATION.md](VERIFICATION.md) for completed live validation.

## Deployment

The commands below target only `vqqbvydiehuwdzbgvmun` and refuse other project refs.
Supabase CLI login is `npx supabase login`. No key is printed by the helper.

```sh
node scripts/infra.mjs link
node scripts/infra.mjs keys
node scripts/infra.mjs migrate
node scripts/infra.mjs secrets
node scripts/infra.mjs deploy
```

If the PostgreSQL port is unavailable, `scripts/management.mjs` is an HTTPS fallback for the initial
migration. It uses `SUPABASE_ACCESS_TOKEN` or the existing Supabase CLI macOS Keychain entry, without
printing or persisting it. `status` inspects schema presence; `migrate` applies the SQL and records CLI
migration history in one database transaction. It refuses to rerun over an existing platform schema.

The function has `verify_jwt=false`. HTTP routes enforce x402, recovery tokens and signed fal callbacks;
Supabase Auth is not part of this product. Tables/RPCs are inaccessible to anon/authenticated DB roles.
Only the service-role backend accesses records and private storage.

## Limits and recovery

The deployed database atomically limits the demo to **30 paid production attempts total** across all
services and **2 active jobs**. The original migration default is 10 total attempts; the operator raised
the deployed total to 30 for repeated demos. A complete product-ad demo consumes seven attempts.
`deno run --allow-net --allow-env --env-file=.env.local scripts/status.ts` shows capacity and job states
without prompts, wallet keys or recovery tokens, and checks anonymous DB access is denied.
Successful jobs and provider failures consume the total allowance. A definite settlement rejection
releases capacity; uncertain payment/submission holds its slot. Only an operator can raise limits in
`public.demo_settings`. At most 1000 unpaid quotes are retained; expired quotes without payment attempts
are pruned when that cap is reached.

fal submission occurs once after payment. Polling and signed callbacks share a database completion
lease and deterministic storage path. Retrieval/storage failures retry the existing provider request.
A callback whose result cannot yet be persisted returns 503 so fal can retry.

`payment-uncertain` or `submission-uncertain` requires operator reconciliation. Inspect the job and
payment attempt against the facilitator/ledger or fal request history. Do not reset it or replay settlement
blindly. A known `paid` job which has not entered `submitting` requires the original POST with the same
input, ID, and recovery token, without `PAYMENT-SIGNATURE`; GET does not submit it to the provider.
An accepted fal request whose ID was lost must be matched by an operator before attachment;
there is no automatic resubmission or refund path.

The project is Stellar testnet only. MCP, skill/plugin, wallet management product, image editing and
marketing website remain separate later work.
