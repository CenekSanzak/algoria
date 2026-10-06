# Algoria Plugin UX — Repository Review and Proposal

Date: 2026-10-04 · Repository: `algoria-x` · Branch: `colloseum-intro`

Scope: actual plugin source in `agent-skills/plugins/algoria`, its tests and documentation, and the service backend in `platform/`. This is source review, not a completed usability study or a new live-payment validation.

## Product experience to preserve

The original Stellar submission promises additional AI capabilities inside Claude/Codex, without users managing separate provider accounts or API keys. The plugin already coordinates planning, funding, discovery, payments, and delivery. Improve that experience while adding Tempo, policy permissions, and Apple biometric signing.

Several good behaviors already exist: one-command onboarding, previous-deposit reconciliation, approval reuse for an already-approved plan, composite-service preference, atomic budgets, paid-job recovery, and explicit media-preview verification. The proposal below makes them more consistent; it does not present them as missing features.

## Findings and improvements

Paths below are relative to `agent-skills/plugins/algoria` unless stated otherwise.

| Current evidence | UX implication | Proposed improvement |
| --- | --- | --- |
| `lib/install.mjs` checks host capabilities and requires a new session; shipped code has bundled dependencies | Setup is already automated, but failures still require interpreting host output | A compact readiness report and one next action; integrate the signed native companion into this path |
| Discovery skill checks balance first; top-up opens/reuses a mock-anchor payment link | Returning users resume safely, but first use can leave the conversation before seeing the service price | For Tempo, show local funding readiness and the selected task's funding need; use explicit testnet faucet funding initially. Do not imply the Stellar TRY anchor funds Tempo |
| Six skill scripts coordinate separate memory/discovery/budget/quote/run/status calls | Smoothness depends on the host model following a long sequence | Shared task coordinator with durable state, structured results, and minimal progress narration; keep existing primitives reusable |
| Discovery uses literal keywords; skill guidance translates Turkish requests and falls back to catalog listing | Matching quality depends on the assistant's query choice | Normalize known capabilities and language aliases, preserve the requested provider, and retain live schema/quote validation |
| `references/planning.md` requires concrete creative approval, but reuses approved plans/budgets | Consent is meaningful; careless UI simplification could remove creative review | One visible final plan plus purchase review where practical. Ask again only for a changed plan, missing authority, or changed terms |
| `video.social` already packages scenes, speech, timing, composition, and captions into one purchase | We already avoid repeated payments for the flagship workflow | Prefer the existing composite endpoint; expose its real progress stages and one receipt |
| `lib/services/client.mjs` uses `--approve` as the representation of approved spending | Current enforcement relies partly on agent/skill behavior | The Tempo signer requires a human-authenticated purchase or a verifiable existing delegation; a flag cannot create new authority |
| `lib/services/state.mjs` preserves spent/reserved budgets and exact decimal arithmetic | Good recovery foundation, but Stellar units are embedded in presentation | Token-aware amounts; readable totals plus exact details; show available versus reserved funds clearly |
| `lib/services/delivery.mjs` distinguishes generated output from actual preview delivery | Delivery is already treated carefully, but host-specific display can still fail | Persist one result card and offer Reopen result / Refresh access for the same paid job |
| `platform/` distinguishes payment, provider submission, rendering/storage, and result readiness | One generic spinner would hide useful information | Display the real stage, elapsed time, and relevant next action; no invented percentages |
| `lib/stellar/keystore.mjs` and `lib/cli.mjs` use local seeds and passphrase input | Current storage is not a biometric signing boundary | Separate native Tempo signer using Touch ID and Secure Enclave key access controls |

## Proposed user journey

### Ready wallet, new task

“Create an image for my product.” → Algoria finds a service and prepares the requested work → the local purchase view appears → **Approve with Touch ID** → payment and generation progress → the result appears in the conversation with a short receipt.

The purchase view shows the provider, requested result, token amount, any fee, network, and expiry. Keep raw transaction fields expandable. Preserve creative review when the assistant has introduced meaningful choices. Do not ask the user for service IDs, command arguments, or budget names.

### Permission already granted

Show “Covered by your task budget” and the remaining allowance. Continue without another payment prompt, while keeping purchase activity visible. An existing budget does not approve a newly invented creative plan. A larger amount, new provider, or longer expiry requires an explicit new grant.

### Interrupted or failed task

Restore the same task after a host restart. Refresh status or access to the existing artifact; never create another purchase to repair a display failure. Preserve the paid receipt even when the service fails. Tell the user when operator reconciliation is required rather than implying every uncertain job can recover automatically.

## Local UI rules

- Three small views: Overview, Purchase review, and Permissions/activity.
- Automatically present the purchase view in a supported host surface or a compact local companion window. No routine manual approval link.
- Keep one task identity through preparation, payment, execution, and recovery.
- One short start message, then meaningful state changes; no narration of every skill command.
- Queue concurrent approvals instead of stacking biometric prompts.
- Preserve keyboard navigation, readable labels/amounts, and clear testnet status.
- Host tool approvals are separate and cannot be bypassed by the wallet.
- Cancellation before signing prevents payment. After submission, show the actual state and do not imply a refund.

The exact embedded UI support must be tested per host/version. A companion window is an honest, reusable local option; do not describe it as an inline host widget if it is separate.

## Apple biometric signing plan

### Native owner signer

Build a compact Swift/SwiftUI macOS companion. Use LocalAuthentication and a Secure Enclave P-256 key, with key-use access controls such as `privateKeyUsage` and `biometryCurrentSet`. Touch ID must protect signing itself; a separate successful authentication check followed by unrestricted software signing is insufficient. [Apple Secure Enclave](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave), [biometric access control](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)

The Node runtime submits a structured purchase or permission. The companion validates the provider/recipient, token, amount, chain, nonce, expiry, and request reference; shows a trusted summary; constructs the payload; and returns only the signature/result. No owner secrets go to Node, shell arguments, logs, or model context. Do not expose arbitrary digest signing to the agent.

Use authenticated local IPC with a narrow request protocol. A process running locally is not automatically trusted: account for other local processes, request substitution, and same-user file access. Signing identity, protected key access, explicit intent review, and on-chain limits are the actual boundaries.

### Two clear modes

1. **Approve once:** review the exact purchase, then Touch ID for that signature. Recheck expiry/content after authentication; do not reuse a broad unlocked session across unrelated purchases.
2. **Approve a budget:** Touch ID signs a bounded permission/access-key authorization. A protected delegated signer executes covered purchases without repeated biometrics. Show that these payments use an existing grant; do not claim each was individually biometric-approved.

Allow immediate local pause. Permission expansion and owner-key changes need fresh authentication. On-chain revocation may also require an owner signature and must show pending/confirmed status separately.

### Compatibility and recovery

Tempo supports P-256 accounts, but a Secure Enclave key requires a custom signing bridge; the raw-private-key convenience API cannot consume it. Prove digest hashing, signature encoding, address derivation, and transaction acceptance with the pinned SDK. [Tempo P-256 accounts](https://viem.sh/tempo/accounts/account.fromP256)

ERC-8196 contract verification must accept the selected signature scheme. Ordinary secp256k1 `ecrecover` does not verify P-256. Check deployed Tempo verification support and the MPP execution path; Apple authentication does not replace ERC-8126 verification. [Tempo signature verification](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1020.md), [ERC-8196](https://eips.ethereum.org/EIPS/eip-8196)

Target Touch ID-capable Macs first. Face ID via a separate Apple device is later work. Handle unavailable hardware, unenrolled biometrics, lockout, cancellation, and enrollment changes. Biometric-required mode must not silently fall back to passwords or an unprotected software key. [LocalAuthentication](https://developer.apple.com/documentation/localauthentication)

An enclave key is device-bound; a copied key reference is not a portable backup. Define independent recovery and key rotation before real funds. For the testnet demo, disclose reset/refunding limitations. Browser passkeys are an alternative, but do not promise biometric-only authentication or device-bound storage merely because WebAuthn is used.

### Packaging

Keep native source/build tests outside `plugins/algoria`, in line with `agent-skills/CONVENTIONS.md`. Ship a signed, versioned companion through a checked installation path. Plan Developer ID signing/notarization and required entitlements. Test both host installations and npm packaging on a clean machine without developer dependencies. This is new packaging work; it is not already supplied by the current Node-only plugin.

## Build and verification priorities

1. Real Touch ID-protected signing accepted by Tempo; cancellation and payload substitution rejected.
2. One existing image service using MPP end to end, with automatic local approval and result delivery in both hosts.
3. Reusable task state, readiness, error actions, and recovery. Preserve existing paid-job protections.
4. Biometric permission grant, uninterrupted covered purchases, and blocked expired/revoked/over-budget requests, including concurrency.
5. Composite social-video progress and receipt through the same path after the image flow is stable.

Proposed UX targets, not measured results: one final purchase review plus Touch ID for a ready wallet; no routine approval URLs; no repeated onboarding; no duplicate request for an already approved plan; one persistent task; no new payment after uncertain settlement or failed media preview.

Test with unfamiliar users in actual Claude/Codex installations. Record time to first result, number of unnecessary questions, approval interactions, confusing states, and recovery success. Use existing plugin tests as the regression baseline and add native/MPP checks during implementation. Do not run paid provider tests without an explicit test budget.

## Related documents

- [Architecture and implementation plan](./COLOSSEUM_TEMPO_PLAN.md)
- [Original Stellar submission](../agent-skills/SUBMISSON.md)
- [Current plugin architecture](../agent-skills/TECHNICAL_DOCUMENTATION.md)
- [Plugin conventions](../agent-skills/CONVENTIONS.md)
- [Current planning rules](../agent-skills/plugins/algoria/skills/algoria-discover/references/planning.md)
- [Composite video contract](../platform/docs/SOCIAL_VIDEO.md)
