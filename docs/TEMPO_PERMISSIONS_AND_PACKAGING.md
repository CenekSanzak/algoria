# Tempo permissions and packaging — 0.11.0

Date: 2026-10-05 · `algoria-x` · `colloseum-intro`

## What users get

Approve a scoped budget with Touch ID → prepare an image task → review the exact
purchase with Touch ID → retrieve the result and receipt. Stop future local
dispatches immediately with `revoke`. No routine wallet links.

The grant sets a host label (Claude/Codex), fixed image endpoint, exact recipient,
Tempo testnet/PathUSD, total lifetime cap, per-purchase cap and expiry. Limits are
chosen by the user, not the assistant. Grants and replacements require biometric
key use; reading usage and revoking do not. Maximum grant lifetime is 30 days and
total cap is 100 test PathUSD. Gas is separate from service-price accounting.

Every purchase **still requires Touch ID**. This release does not enable an
autonomous delegated signer. Wallets remain disposable and testnet-only.

## Implementation and boundaries

- The shared fixed schema has canonical field ordering. The native bundled
  builder derives its review and SHA-256 digest from those exact fields.
- Security.framework uses an ephemeral Secure Enclave P-256 key with
  `privateKeyUsage` and `biometryCurrentSet`; there is no live software fallback.
  The approval receipt contains only the policy, public key, digest and signature.
  The plugin checks its signature and equality with the requested scope.
- The native purchase builder verifies the receipt, endpoint/service constraints,
  token, recipient, per-purchase cap and current expiry. It still constructs only
  the existing challenge-bound MPP transfer, never caller-supplied calldata.
- The atomic local ledger enforces total spending and reservations across jobs.
  A grant/change preserves usage, including uncertain payments. Old MPP budgets
  without signed receipts cannot reserve a new purchase until reapproved.
  Untagged Stellar budgets keep their existing meaning.
- Permission checks run at reservation, after the wallet queue, before purchase
  review, and atomically with saving dispatch. Revocation or expiry during review
  prevents the plugin from returning to its broadcast step. Changed policy IDs
  cannot silently authorize an already-queued approval under a replacement. A
  later explicit same-task run can adopt the replacement before dispatch, without
  resetting reservations, and still requires the purchase Touch ID review.
- Dispatch persistence is the local revocation boundary. A saved dispatch or
  transaction may still complete; revocation cannot claw back a returned
  signature or undo settlement. Recovery remains available for those jobs and
  never creates a new signature. Uncertain reservations are not released.
- Cancellation before dispatch releases that purchase reservation. Cancellation
  of a grant/change leaves the budget unchanged. A revoke during a grant cannot
  be silently overwritten; a later explicit biometric regrant can restore it.

These are **local-only limits**, not host-independent security. Same-user
malicious software can replace the ledger or configured ad-hoc companion. A
self-contained public receipt is not a hardware attestation or a pinned owner
identity. Claude/Codex labels are not cryptographically authenticated agents.
The actual payment signing operation still requires human Touch ID and native
review. Persistent wallets, authenticated IPC and key recovery remain separate
unfinished work.

## ERC-8196 / Tempo feasibility decision

[ERC-8196](https://eips.ethereum.org/EIPS/eip-8196) defines an on-chain wallet
interface, ERC-8126 risk verification, policy-bound execution and hash-linked
audit requirements. This direct P-256 MPP signer implements none of that contract
interface or verification dependency. **Do not claim full ERC-8196 compliance.**

Tempo's own [TIP-1011 specification](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1011.md)
describes access-key spending limits and target/selector/recipient scopes,
including `transferWithMemo`. This suggests a feasible future chain-enforced
delegation route, but it is not ERC-8196 by itself. Its deployment on our target
network, pinned SDK integration, restricted signer lifecycle, fee accounting and
MPP end-to-end behavior still need dedicated integration proof before enabling
autonomous spending. No access key or policy contract was deployed here.

## Assistant/user flow

1. Check readiness and current service metadata (no payment).
2. Confirm total, per-call cap, host label, recipient and expiry with the user.
3. Create/change the budget. The native permission window opens automatically;
   the user can cancel or approve with Touch ID. No faucet or transfer occurs.
4. Prepare/reuse the image task. Explicit faucet consent is still required for
   a disposable purchase wallet. The actual purchase gets its own Touch ID review.
5. Show real progress, result and receipt; reopen the saved task for recovery.
6. On request, revoke immediately locally. Preserve submitted jobs and receipts.

Use the installed helper's absolute `PAY` path. These are examples, not spending
authority; replace the placeholders with the user's terms and actual metadata:

```sh
node "$PAY" readiness --json
node "$PAY" budget --name demo --total 0.03 --per-call 0.02 --protocol mpp --agent codex --recipient ACTUAL_SERVICE_RECIPIENT --expires USER_APPROVED_ISO_DATE --json
node "$PAY" task --input /absolute/path/image.json --budget demo --json
node "$PAY" task SAVED_ID --approve --fund-testnet --wait --json
node "$PAY" budget --name demo --json
node "$PAY" revoke --name demo --json
node "$PAY" task SAVED_ID --wait --json
```

## Installation and reproducible packaging

The plugin version is 0.11.0 in both host manifests and npm metadata. The npm
archive now includes both hidden host-manifest directories and no runtime
dependencies, tests or development tooling. The companion stays separate.

The installer accepts `--source /absolute/local/marketplace/root` for development
files, mutually exclusive with `--ref`. It never checks out `main`. Git source
installation retains marketplace refresh; local Codex installation skips the
unsupported Git-only upgrade operation. Older Claude versions without marketplace
`--scope` use their user-level registration and explicit user-level plugin install.
An existing marketplace-source conflict fails rather than removing user settings.

```sh
# From algoria-x/agent-skills: creates a clean package and temporary host profiles.
node build/verify-package.mjs --hosts
# From native/tempo-signing-proof:
npm run build
node scripts/check-purchase-runtime.mjs
npm run package
```

The smoke test uses the real installed Claude and Codex CLIs, isolated config/state
directories, and a temporary local marketplace built from the actual npm tarball.
It verifies installed-copy versions, implementation equality, help/readiness and
the bundled SDK without `node_modules`. No normal user host profile is changed.
It tests CLI installation, not a natural-language conversation inside either app.
Official authoring references: [OpenAI packaging](https://developers.openai.com/plugins/build/plugins)
and [Claude plugins](https://code.claude.com/docs/en/plugins).

The native build produces `Algoria-Tempo-Companion-0.11.0.zip` under ignored
`.build/`, with a SHA-256 checksum. It is **ad-hoc signed development packaging**,
not a notarized installer. No release is published or pushed.

## Verification

Completed locally:

- 269 plugin tests, including signed scope/limits, legacy-budget rejection,
  grant cancellation, changed receipt, expiry, concurrent overspending, preserved
  usage on regrant, revocation races, duplicate dispatch and recovery after revoke.
- 32 native tests, including cross-runtime permission digest/signature agreement,
  substituted policy/destination/expiry rejection and Apple high-S normalization.
- 102 backend tests, including challenge/memo verification, cross-job payment
  replay rejection, delayed settlement and exactly-once provider submission.
- Native compilation and real JavaScriptCore offline permission-backed purchase;
  these use explicit software test keys and **do not prove Touch ID**.
- Real Claude/Codex isolated installations and installed dependency-free commands.
- Skill validation, manifest consistency and packaging checks.

Still pending: live new budget approval/Cancel checks with a person present,
both-host natural-language UX/accessibility, Developer ID signing/notarization,
clean-machine acceptance, authenticated IPC and chain-enforced permissions.
Any live image-provider test requires a separately approved cost budget.
