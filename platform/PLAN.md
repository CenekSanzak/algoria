# Algoria — Hackathon API MVP Plan

Status: **v0.4 approved and the API implemented.** Live verification: `VERIFICATION.md`; current usage: `README.md`.

The user authorized application implementation, package installation, migrations, testing, and deployment. A service recipient wallet and a local test wallet were also created, the test wallet was funded with testnet USDC through the TR mock anchor, and the supplied connection credentials were stored locally. The following sections record the approved design.

## 1. Confirmed scope

- The new project will be created under `platform/` in this repository, independently of the existing Svelte application.
- Only the HTTP API and discovery layer for services offered by Algoria will be developed.
- The first real service generates a single image; editing comes later.
- The same service will support sync and async calls. Sync is the default; when the wait expires, the same job can be tracked asynchronously.
- Payments use only Stellar testnet USDC and x402 v2 `exact`.
- Each Algoria service will have its own payment recipient wallet; services will not share a recipient wallet.
- The wallet lives on the user's or agent's computer. Key storage, budget enforcement, and signing are client responsibilities.
- Users will fund their local wallets through the mock anchor. There is no Algoria balance or prepaid deposit into Algoria.
- Users will access the service through local AI clients such as Codex or Claude; the contract delivered here is a standard HTTP API.
- Hosting will use free tiers; fal usage is billed separately.
- New Supabase project: `https://vqqbvydiehuwdzbgvmun.supabase.co`.

This phase will not develop an MCP server, skill/plugin, local wallet, or mock anchor client as a product. The authorized local wallet creation and mock top-up preparation do not include those products. There is no web application, browser wallet connection/payment approval, user registration, Supabase Auth, user dashboard, mainnet support, external service registration, or CDP Bazaar integration. A promotional website is separate from the API and is a future task.

Context from the earlier “Evaluate: Mock Anchor Usage” conversation: the anchor funds a local wallet with test USDC; the agent pays as it uses services within the user's authorization and budget. This plan provides the service side for that client behavior without including client implementation in scope.

## 2. Technology and free hosting recommendation

**TypeScript + Hono + Supabase Edge Functions + Supabase Postgres/Storage.**

- The API runs as a single deployment on Deno-based Supabase Edge Functions. Hono groups the discovery, execution, status, and webhook routes.
- The gateway is configured with `verify_jwt = false` for this public function; external clients do not need a Supabase account or JWT. Required checks are applied at the route level through x402, recovery tokens, and webhook signatures.
- Postgres stores job and payment records; SQL migrations and narrowly scoped database functions handle atomic operations. The MVP does not need an additional ORM.
- Generation runs in fal's durable queue. No continuously running Node worker, Redis instance, or second job queue of our own is required.
- The fal webhook records the result. If a webhook is missed, reading the job status can query the existing fal request; it does not start another generation.
- Output is copied to Supabase Storage and delivered through a time-limited access URL.
- Inputs are validated with Zod/JSON Schema; the HTTP contract is published as OpenAPI.

At the time of research, Supabase Free includes 500,000 Edge Function invocations per month, a 500 MB database, and 1 GB of Storage. Edge Functions have a 150-second wall-time limit and a 2-second CPU limit. For async calls, the API submits the job to fal and returns `202`. For sync calls, it waits for a bounded period: `200` if the result is ready, or `202` for the same job if it is not. Generation runs in fal's durable queue in both modes; long-running work is not left in a background promise that may be terminated. [Free plan](https://supabase.com/pricing), [function limits](https://supabase.com/docs/guides/functions/limits), [Hono support](https://hono.dev/docs/getting-started/supabase-functions)

The first implementation step will test the x402/Stellar npm packages in this runtime and measure the limits. Compatibility has not yet been verified at this point in the plan. If incompatibilities emerge, the runtime decision will be revised; there will be no automatic upgrade to a paid plan. Because Cloudflare Free has a 10 ms CPU limit, it is not being selected as the primary payment runtime without verification. [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)

A single project is sufficient: `platform/supabase/functions/`, `platform/supabase/migrations/`, and tests. This MVP does not need a multi-application monorepo, Next.js, or a separate web package.

## 3. First service

- Algoria service ID: `image.generate`.
- A dedicated testnet recipient wallet has been created locally for this service. Each service added later will receive its own recipient wallet.
- Recommended fal endpoint: **`google/nano-banana-2-lite` — Nano Banana 2 Lite**. This is the closest official match found for the inexpensive “mini” model the user recalled.
- MVP input: `prompt`. Output: one 1:1, 1K PNG image.
- Provider options are fixed on the server: one image, `limit_generations: true`, thinking disabled; arbitrary model or quality parameters are not exposed.
- A fixed testnet USDC price is configured per call. The initial demo recommendation is `0.01` test USDC; it is not presented as real money or reimbursement for fal costs.

fal publishes token-based pricing for this model rather than a fixed price per image. A 1K output can be estimated at approximately **$0.042 + text tokens**; actual usage cost will be recorded. This estimate combines fal's rates with Google's token count for a 1K output. [fal model/pricing](https://fal.ai/models/google/nano-banana-2-lite), [API schema](https://fal.ai/models/google/nano-banana-2-lite/api), [Google token calculation](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite-image)

Because testnet USDC does not cover real fal costs, the server limits the total number of demo generations and concurrent jobs. A fal budget for live trials will be set separately after approval.

## 4. Our own Bazaar-compatible discovery layer

The service definition is kept in one place in code: ID/version, description/tags, HTTP endpoint, input/output schemas, fixed price, Stellar testnet payment requirements including the service-specific recipient address (`payTo`), and the internal handler.

Our catalogue and the `extensions.bazaar` metadata in the `402` response are generated from this definition. Bazaar here means schema and HTTP discovery compatibility; it does not mean registering or publishing with CDP, or importing services from it. The facilitator is contacted only for payment verification and settlement. [Bazaar specification](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md)

API routes:

- `GET /discovery/resources`: service catalogue and standard filters.
- `GET /discovery/search?query=...`: simple description/tag search over the same records. No separate search model or vector database.
- `GET /v1/services/:service_id`: full service schema and usage details.
- `POST /v1/services/:service_id?mode=sync|async`: generic execution route charged through x402; defaults to `sync`.
- `GET /v1/jobs/:request_id`: free access to status, receipt, and result.
- `POST /webhooks/fal`: provider completion notification.
- `GET /health` and `GET /openapi.json`: operational and integration information.

When a service is added, the client learns its endpoint and schema through discovery. A new client integration is not required for each service. MCP tools are neither designed nor created in this work.

### Sync and async response contract

- `mode=sync` is the default. The initial recommendation is a 45-second wait; clients can request a shorter wait or a maximum of 60 seconds through `wait_ms`. The server may reduce this upper bound based on the runtime and remaining request time.
- The wait budget is measured from the start of the paid HTTP request; payment, fal submission, result retrieval, and Storage persistence share this budget. Timings will be measured during runtime verification after approval.
- If the output is stored within the wait period, `200 OK` returns `job_id`, `status: succeeded`, the result, and the payment receipt together. The client does not need a separate job query.
- If the wait expires before the job reaches a terminal state, `202 Accepted` returns the same `job_id`, the actual status, `status_url`, a suggested polling interval, and the payment receipt if available. This continues the same job; it is not another payment or generation call.
- `mode=async` returns `202` after the payment/submission steps without waiting for generation to finish. The client tracks progress through `GET /v1/jobs/:request_id`.
- If a definitive error is discovered while waiting, it is not disguised as a timeout; the documented error code, `job_id`, and current payment state are returned. If the settlement outcome is uncertain, the status is explicitly `payment-uncertain`, and fal generation does not start.
- Both modes use the same job/provider request record and result format. `mode`/`wait_ms` only control how long to wait for the response; they are not included in the paid input hash or price. Retrying with the same identity in a different mode does not create another job.
- A client disconnect or sync timeout does not cancel the fal job. Sync polling and the webhook use the same idempotent completion path: an atomic claim per job, a fixed Storage file path, and terminal-state protection. `200` is not returned until the file and result record are ready; if persistence is still in progress, the same job returns `202`.
- Discovery and OpenAPI explicitly describe supported modes, the default, the wait limit, and `200`/`202`/error responses. The implementation does not switch to fal's separate direct sync endpoint; only our response-waiting behavior changes.

## 5. HTTP and x402 flow

1. The client reads the catalogue and service schema.
2. It generates a random `request_id` and a strong recovery token locally for the call, preserving both when retrying the same logical job.
3. It calls the service with the input, `Idempotency-Key: request_id`, and `X-Recovery-Token`.
4. The API first checks the input and demo capacity. A valid unpaid request receives `402 Payment Required` and standard x402 payment requirements. Generation does not start.
5. The local wallet layer checks the budget, signs the Stellar authorization entry, and repeats the same request with the standard `PAYMENT-SIGNATURE`. Algoria does not request browser approval or a private key.
6. The API verifies the payment authorization, atomically reserves demo generation capacity in the database, settles through the facilitator, and records the outcome against the job. A definitive payment failure releases the reservation; an uncertain transaction retains it. This prevents parallel calls from exceeding the fal spending limit.
7. Once payment is confirmed, one generation request is submitted to fal's queue, and the provider `request_id` is stored. An async call returns `202`; a sync call waits for the same job's result within the remaining wait budget. The x402 payment receipt is preserved in the response.
8. If sync completes, the result is returned directly with `200`. If async was selected or the sync wait expired, the client queries the result using the same job ID and recovery token. The webhook or a status query for the existing provider request completes the job.

Result access without an account/login: the recovery token is an access credential for a specific job, and only its hash is stored in the database. Status requests send it as `Authorization: Bearer ...`; it is not placed in URLs or logs. Knowing only the public wallet address or job ID does not grant access to results. Because the client creates the token before the first call, it can recover the same job even if the response is lost after payment.

The first valid call binds the input, service version, recovery token hash, and payment requirements, including the service-specific `payTo`, to the job as an immutable snapshot. Later changes to the service wallet or configuration do not change the recipient for retries and recovery of that job. Reusing the same identity with different input or a different token produces a conflict and does not grant access to the previous record. If an unpaid quote expires, a new request is prepared with a new call ID; an uncertain payment requires recovery of the existing job rather than a new payment.

## 6. A small but reliable job record

The following data responsibilities are sufficient initially:

- `jobs`: request identity, service/input snapshot, recovery token hash, payment and generation states, provider request ID, output, and error.
- `payment_attempts`: x402 requirements with a snapshot of the service-specific `payTo`, authorization fingerprint, verified payer address, associated job, and testnet settlement reference.
- `webhook_events`: event records that prevent the same notification from being applied again.
- Storage: completed job outputs. There are no user/account/API key tables.

Paid generation starts only after verified payment. The same payment proof cannot be attached to a second job; database uniqueness constraints and claims protect concurrent requests. USDC amounts are stored in atomic units.

The blockchain, database, and fal do not share a single transaction. Intent is recorded before payment or submission. If it is unclear whether fal accepted a request, it is not blindly resubmitted. If a provider request ID exists, that request is tracked; otherwise, the uncertain state is left for an operator. Tests after approval will specifically cover these gaps.

Webhook signatures are verified; repeated notifications do not create another result or generation. If the fal result has been retrieved but Storage persistence is incomplete, only file persistence is retried. A status query does not start another payment or generation.

If the process stops after settlement but before submission begins, the record is not lost. An operator can recover a job that was definitively never submitted; an attempt with an uncertain outcome, such as `submitting`, is not automatically resubmitted. No general-purpose workflow engine is introduced.

Definitive failures are reported explicitly; the same payment is not collected again. The testnet demo does not include an automatic refund product or interface; an operator can replenish test funds if needed. Public API access does not grant Supabase administrative access: routes enforce their own x402/token checks, and the database/Storage administrator key remains server-side only.

## 7. Implementation order and acceptance criteria after approval

1. **Minimal API/runtime:** Hono Edge Function, Supabase connection, and x402/Stellar package compatibility. Acceptance: the new project runs independently and health responds; the existing Svelte application is unchanged.
2. **Service definition and discovery:** one image service, Bazaar metadata, JSON Schema, and OpenAPI. Acceptance: an HTTP client can discover what to call and how; invalid input does not start a paid operation.
3. **Testnet x402:** unpaid `402` → local signature → settlement → result, using a test handler that incurs no real cost. Acceptance: the wrong network/asset/amount and payment replay are rejected; the record exactly matches the on-chain payment.
4. **fal, sync, and async results:** Nano Banana 2 Lite, queue submission, bounded sync waiting, webhook, status queries, and Storage. Acceptance: a sync result is returned in one response; on timeout, the same job is tracked asynchronously; direct async execution works. One testnet payment produces one real output; lost responses and retries do not create a second generation.
5. **Free deployment and demo:** API at the Supabase URL, logs, and a small integration example. Acceptance: an external HTTP client completes the discovery → x402 → job → image flow. A local wallet/plugin can use this API; those products are not built in this delivery.

Focused tests to run after approval: schema/price validation; valid/invalid x402; retries with the same identity and conflicts for different input; attaching the same payment proof to a second job; missing/incorrect recovery tokens; fal and webhook failures/retries; response loss after payment and after provider submission; output access. Also verify sync `200`, direct async `202`, completion of the same job after a sync timeout, retries with a different mode, connection loss, and concurrent sync/webhook completion. Live fal trials remain within the specified budget.

## 8. Information needed before implementation

No additional secrets are needed for planning. Current preparation status:

- The Supabase project URL and database password were received; the database password was stored in a local file excluded from Git. Supabase CLI login and access to the new project were verified.
- The fal API key was received and stored in a local file excluded from Git. The user authorized end-to-end completion/testing; live trials will be limited to a few images. The global demo generation limit is 10, with a concurrent job limit of 2.
- A dedicated recipient wallet for `image.generate` and a separate local client testnet wallet were created; private keys are stored locally outside Git.
- The local test wallet received 4.0792181 test USDC in exchange for 200 mock TRY through the TR mock anchor; the on-chain balance and accepted USDC issuer match were verified. XLM funding and the USDC trustline are ready for the service recipient.
- The testnet facilitator choice and any required credentials will be finalized during implementation. The initial candidate is the official testnet facilitator; its `/supported` capabilities will be checked again at that stage.

The user's wallet private key is never given to the payment-receiving server. Local wallet management, budgeting, mock anchor top-up, MCP, and skill/plugin products remain within the scope of future client work; this phase performs only the explicitly authorized one-time local wallet preparation. The API discovery/payment contract is completed independently of those products.

Additional references: [Stellar x402](https://developers.stellar.org/docs/build/agentic-payments/x402), [testnet facilitator support](https://www.x402.org/facilitator/supported), [fal queue](https://fal.ai/docs/documentation/model-apis/inference/queue), [fal webhook](https://fal.ai/docs/documentation/model-apis/inference/webhooks).
