# Algoria API

Independent hackathon API in `platform/`. TypeScript + Hono, Supabase Edge Functions/Postgres/Storage,
Stellar testnet x402, and fal's persistent image queue.

Base URL: `https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api`

For the future local wallet/skill client, see the
[skill integration handoff](docs/SKILL_INTEGRATION.md): discovery, mock-anchor top-up,
x402 signing, sync/async execution, persistent recovery, and acceptance tests.

## Use the API

- `GET /discovery/resources`: Algoria's own service catalogue; filters `type`, `network`, `scheme`, `payTo`, `extensions`, `limit`, `offset`.
- `GET /discovery/search?query=image`: simple service search.
- `GET /v1/services/image.generate`: complete request schema, payment conditions, execution modes.
- `GET /openapi.json`: HTTP contract.
- `POST /v1/services/image.generate?mode=sync`: generate one square 1K PNG.
- `GET /v1/jobs/{job_id}`: recover status, payment receipt and output.

The sole input is `{ "prompt": "A red sailboat, watercolor illustration" }` (1–4000 characters).
No provider/model/quality selection is exposed. The provider is Nano Banana 2 Lite.

Before the first request, the client generates and saves two values:

1. A UUID v4 sent as `Idempotency-Key`.
2. A random 32-byte base64url secret sent as `X-Recovery-Token`.

An unpaid call returns standard x402 v2 `402` with `PAYMENT-REQUIRED`. A local wallet signs the
Stellar testnet authorization. Repeat the same input and headers with `PAYMENT-SIGNATURE`.
The demo price is **0.01 test USDC** (`100000` atomic units). Each service has its own receiving wallet.

`sync` is the default, with a 45-second waiting budget; `wait_ms` accepts 0–60000. Payment and provider
submission are mandatory acceptance steps; a very short wait does not skip them. Completion within the
remaining budget returns `200` with image and receipt. Otherwise `202` returns the same job and status URL.
`mode=async` returns `202` after acceptance. Poll using `Authorization: Bearer <recovery token>`.
`result-ready` means generation/storage finished but a result URL could not be delivered within this
response's waiting budget; the status endpoint returns a fresh link.

Keep the same identity/input/token on retries, including after network loss or a mode change. Never
make a fresh payment just because a request timed out. Terminal retries reuse the receipt and output.
Different input under an existing ID returns `409`. Lost recovery tokens cannot be recovered from a
wallet address; there are no hosted user accounts.

Outputs live in a private Supabase Storage bucket. Response URLs expire after one hour; authenticated
job polling issues a fresh URL. No payment or generation occurs on status reads.

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

The database atomically limits the demo to **10 paid production attempts total** and **2 active jobs**.
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
blindly. A known `paid` job which has not entered `submitting` can be resumed by retrying its original
request. An accepted fal request whose ID was lost must be matched by an operator before attachment;
there is no automatic resubmission or refund path.

The project is Stellar testnet only. MCP, skill/plugin, wallet management product, editing service and
marketing website remain separate later work.
