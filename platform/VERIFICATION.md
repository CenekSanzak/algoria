# Verification — 2026-09-18

Deployed target: `https://vqqbvydiehuwdzbgvmun.supabase.co/functions/v1/api`.
Supabase project: `algoria-platform-dev` / `vqqbvydiehuwdzbgvmun`.

## Initial image-only live validation

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
distinct provider request IDs. At that stage, active jobs were **0** and allowance used was **3 / 10**.

Horizon balances after those initial tests:

- `image.generate` receiver: **0.0300000 test USDC**.
- Local test payer: **4.0492181 test USDC**, from an initial mock-anchor top-up of **4.0792181**.

Anonymous table reads and RPC execution both returned **401**. The `outputs` bucket is private.
Local secrets and wallet files are excluded from Git and have mode 0600; the secret scan of candidate
platform source files found no credential matches.

## Five-service product-ad validation

The deployed catalog now exposes `image.generate`, `speech.generate`, `video.slideshow`,
`video.compose` version 2, and `video.caption`, with five distinct testnet payment recipients.
The additive media migration and receiving-wallet configuration are deployed.

The completed product-ad workflow has seven successful jobs and seven distinct Stellar settlement
receipts, totaling **0.09 test USDC** at the configured prices. The final verification reused the
three previously completed images and the completed narration without charging for them again,
then bought the three final video steps:

- `scene-1` / `image.generate`: `b9a11a9c-a45d-42fc-ad32-eee1eacd8ea6`.
- `scene-2` / `image.generate`: `4f78f314-e2cc-4eb2-8045-012f4836ecaa`.
- `scene-3` / `image.generate`: `51cbc8a0-8ce5-4d4c-bad9-9575c5e4dd6c`.
- `narration` / `speech.generate`: `c526c1a4-3715-424d-a09b-7095d5cc4f35`.
- `slideshow` / `video.slideshow`: `66dc74c4-1fba-4953-9aff-f1e7829c8165`.
- `composition` / `video.compose`: `c8073f9e-6665-4da4-9f78-989023773f54`.
- `captions` / `video.caption`: `6f4fd30e-5190-4c8b-94c7-3c528c887b05`.

`demo-ad.ts` verified discovery, each unpaid 402 offer, completion, unauthenticated result rejection,
and idempotent POST recovery with the same transaction. The final MP4 is **16.58 seconds**,
**1024 × 1024**, **H.264 at 24 fps**, with **24 kHz mono AAC** narration. Local frame inspection
confirmed all three scenes in order and readable highlighted captions. The stored narration is
16.58 seconds; the slideshow is 17.042 seconds. `ffprobe` independently verified the final container
and stream metadata.

Live visual/duration checks caught two provider integration issues before acceptance: the old compose
image track did not sequence scenes correctly, and the dedicated slideshow renderer extended its last
hold. New jobs now use a dedicated slideshow followed by audio merge; terminal frame handling and a
byte-derived duration guard keep timing bounded. Existing version-1 jobs retain their recovery contract.
The merge ends with the narration, which the demo now checks against its 15–20 second target.

The earlier media trials and two direct provider probes remain only in ignored local records;
they are not presented as successful final demos. No ambiguous payment or submission was replayed.
At completion, the API had **0 active jobs**, **17 / 30** total attempts consumed, and concurrency
remained **2**. The operator raised the original total setting from 10 to 30 to permit repeated demos.
Anonymous table reads and RPC execution both still returned **401**.

The final output and recovery state are saved under ignored `.local/ad-demo-9e33b6d3-2d53-4a88-b014-76ec10df9ea4.*`.
Only the MP4 should be shared; the JSON includes private recovery capabilities. Repository reference
snapshots contain only public contracts. The final changed-source secret scan found no leaks.

## Automated validation

Tests exercise API state transitions, payment parsing/tampering/replay, ambiguous settlement,
fal queue errors, Ed25519 callbacks, bounded image retrieval, completion concurrency/storage recovery,
source capability validation, media duration limits, versioned recovery, and actual SQL
migrations/permissions/capacity/leases in PostgreSQL WASM. **76 automated tests pass**;
OpenAPI/Bazaar schemas are validated against actual HTTP responses and examples. Typecheck and lint pass.

The SQL unit test uses one PGlite connection; it validates the migration and transactional rules,
but is not a multi-connection database load test. Live execution validates the hosted runtime and
end-to-end provider/ledger/storage integration. No mainnet operation was performed.

The initial migration was applied through Supabase's HTTPS Management API because the PostgreSQL
port timed out. SQL and CLI migration history were committed in one transaction.

Private integration receipts, including recovery tokens, are retained only in ignored `.local/`.
