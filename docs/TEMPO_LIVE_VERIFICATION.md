# Published Tempo image purchase: live verification

Verified on 2026-10-06 using the downloaded **algoria 0.11.0 npm package**,
the local macOS signing companion, and the deployed Supabase image service.

## Result

- The user approved a one-image budget with Touch ID, then separately reviewed
  the exact purchase and signed it with Touch ID.
- Tempo Moderato (`eip155:42431`) settled **0.010000 test PathUSD**. No real
  chain funds were used. One real fal image generation was authorized and completed.
- The backend verified the MPP receipt and delivered one 1024 × 1024 PNG. Its
  sailboat image was opened and visually verified in the in-app browser.
- Reopening the completed task with `pay run SAVED_ID --approve` returned the
  **same transaction and image**, without requesting another signature.
- The isolated test budget shows spent `0.0100000`, reserved `0.0000000`, and
  remaining `0.0000000`. Its local spending permission was revoked after testing.

Public receipt references:

| Field | Value |
| --- | --- |
| Task | `a8408fad-f12f-417e-b79e-9641e2c56dd8` |
| Transaction | `0x53cc7a9487114ca39c6a62216b4a795e2d0cf2ce378e8939a1ae24be9dcdb937` |
| Testnet service receiver | `0x4e8b68c1efb666d2ef074f3b442076c5edc24e70` |
| API deployment | Supabase project `vqqbvydiehuwdzbgvmun`, function `api`, version 37 |

Private recovery tokens, wallet keys, server secrets, and expiring media-access
URLs are intentionally excluded from this document.

## Release and deployment fixes

`algoria@0.11.0` is published and was installed into a fresh temporary npm cache.
The release smoke test now separates npm notices from the version output,
uses an isolated cache, retries propagation longer, and checks versions that
were already published when a workflow is rerun. These workflow edits still
need to be committed and merged; the live package itself was already published.

Only three Tempo server settings were added: receiver, fixed image price, and
the stable MPP challenge secret. Existing provider credentials and capacity
limits were retained. The testnet-only receiver key remains Git-ignored locally;
it was not sent to the backend. Never send real funds to this receiver.

Comparing the actual previous deployment uncovered two live changes missing
from the merged source: the `ALGORIA_SERVICE_ROLE_KEY` fallback and Turkish
phone support. Both were preserved in the Tempo deployment and regression tests.
Deployment sources and a pre-Tempo rollback copy were retained locally.

The normal deployment endpoint returned internal errors, although server-side
bundling succeeded. The same tested source was activated successfully using
Supabase's documented [bundle-only and atomic-update flow](https://supabase.com/changelog/33720-deploy-and-update-edge-functions-using-the-management-api).
Only the existing `api` function was updated; no project restart, database
upgrade, or key rotation was performed.

## Checks and limits

- Plugin type check and **274 tests** passed.
- Backend type check and **103 tests** passed.
- Safe Tempo configuration planning: **7 tests** passed.
- Live published-CLI → native Touch ID → Tempo → MPP verification → fal → private
  storage → browser delivery and same-task recovery all succeeded.

This is a disposable, testnet-only wallet demonstration, not a persistent
production wallet. Permissions remain local-only and do not claim ERC-8196
compliance. A complete new-install, natural-language conversation in both
Claude and Codex was not performed in this run.

## Git recovery

The checkout is back on `colloseum-intro`, with conflicts resolved and source
edits preserved. Generated build files and private wallet state are not staged.
Local `main` was safely fast-forwarded to the already-fetched merged commit.
A recovery stash was retained. No commits or pushes were made in this run.
