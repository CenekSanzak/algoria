# Verification — 2026-09-18

Deployed target: `https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api`.
Supabase project: `algoria-platform-dev` / `vqqbvydiehuwdzbgvmun`.

## Live results

Three real fal images and three Stellar testnet payments completed successfully:

- Sync: HTTP 200 with stored image and payment receipt.
  Job `7b33a795-5248-4bf3-bbf2-7b1f8012b381`;
  transaction `0d5a7c39f38155a8b7272d20ffb9ef12f8a94b8a18284edaed258135ea712209`.
- Async: HTTP 202, followed by the same job's successful status result.
  Job `a9328ed2-1824-440e-8fb6-9e17488ff49c`;
  transaction `0c03e572e8c3260d169ac8e64cb367c4ecdd48dc212bbea8ef78c1bc5fb87769`.
- Sync fallback (`wait_ms=0`): HTTP 202, followed by completion without another payment or generation.
  Job `c0a116e9-4dd3-46b5-850b-4319ef1b7b4e`;
  transaction `75a53765bc16db61f54130985412aada6fc2a2f1ae63568860e71ffe59e44e54`.

Each scenario verified discovery, unpaid 402, standard x402 receipt header, private stored output
availability, rejection of unauthenticated result reads, idempotent retry with the same transaction,
and rejection of changed input under the original request ID.

All three fal webhook signatures were accepted and recorded. All three jobs are `succeeded`, with
distinct provider request IDs. Final active jobs: **0**. Demo allowance used: **3 / 10**.

Horizon balances after the tests:

- `image.generate` receiver: **0.0300000 test USDC**.
- Local test payer: **4.0492181 test USDC**, from an initial mock-anchor top-up of **4.0792181**.

Anonymous table reads and RPC execution both returned **401**. The `outputs` bucket is private.
Local secrets and wallet files are excluded from Git and have mode 0600; the secret scan of candidate
platform source files found no credential matches.

## Automated validation

Tests exercise API state transitions, payment parsing/tampering/replay, ambiguous settlement,
fal queue errors, Ed25519 callbacks, bounded image retrieval, completion concurrency/storage recovery,
and actual SQL migrations/permissions/capacity/leases in PostgreSQL WASM. **43 automated tests pass**;
OpenAPI/Bazaar schemas are validated against actual HTTP responses and examples. Typecheck and lint pass.

The SQL unit test uses one PGlite connection; it validates the migration and transactional rules,
but is not a multi-connection database load test. Live execution validates the hosted runtime and
end-to-end provider/ledger/storage integration. No mainnet operation was performed.

The initial migration was applied through Supabase's HTTPS Management API because the PostgreSQL
port timed out. SQL and CLI migration history were committed in one transaction.

Private integration receipts, including recovery tokens, are retained only in ignored `.local/`.
