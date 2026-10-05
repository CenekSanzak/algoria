# Algoria — Tempo implementation plan

Date: 2026-10-05 · Repository: `algoria-x` · Branch: `colloseum-intro`

Status: proposed implementation sequence, not completed work. Builds on [architecture](./COLOSSEUM_TEMPO_PLAN.md) and [UX proposal](./PLUGIN_UX_PROPOSAL.md).

Progress, 2026-10-05: the isolated [native signing proof](../native/tempo-signing-proof/README.md) now builds and has completed a user-approved Secure Enclave/Touch ID signing flow with confirmed Tempo testnet settlement. See [verification evidence and remaining phase-1 checks](../native/tempo-signing-proof/VERIFICATION.md). Plugin/platform baseline tests now pass after dependency repair in phase 2. Packaged native installation, live installed-host purchase validation, and full policy-contract feasibility remain pending.

## Outcome

Keep Algoria as a Claude/Codex plugin for buying AI services. Add Tempo/MPP, a lightweight local wallet with Touch ID, and policy-based spending permissions. Reuse the existing services, memory, planning, budgets, and paid-job recovery. No replacement chatbot or separate marketplace.

## 1. Establish the baseline and prove signing

- Record current plugin/platform test results and installed-package behavior; preserve the Stellar path as a regression baseline.
- Pin the Tempo/MPP dependencies and verify testnet token, fee, settlement, and signature requirements before implementation depends on them.
- Create native companion source outside the shipped plugin directory. Prototype a Secure Enclave P-256 key whose signing operation requires Touch ID.
- Open the companion automatically from both host installations, pass a structured test purchase, and prove the signature is accepted on Tempo testnet.
- Test cancellation, lockout, changed payload, and unavailable hardware. No silent software-key fallback.
- Check ERC-8196 wallet/dependency requirements, P-256 verification, and compatibility with the chosen MPP payment path. Record whether full conformance is feasible or the release will explicitly use selected ERC-8196-inspired features.

**Exit:** verified native signing path and a written policy integration decision. Do not build the complete wallet UI around an unproven signing bridge.

## 2. Implement Tempo/MPP on both sides

Progress, 2026-10-05: [MPP image payments are implemented](./TEMPO_MPP_IMPLEMENTATION.md)
in the plugin, native purchase signer and existing backend, with offline integration
and recovery coverage. Live image-provider validation and deployed configuration
are still pending; the companion currently uses disposable testnet keys.

- Add a Tempo wallet/payment adapter without changing the existing Stellar adapter's behavior.
- Make amounts and persisted payment records explicit about chain, token, decimals, and payment protocol; preserve old records through versioned migration tests.
- Add MPP challenge, payment verification, and settlement to the existing image-service endpoint in `platform/`.
- Add the matching plugin MPP client. Freeze the service input, quote, payment destination, amount, network, and task identity before approval.
- Bind the trusted wallet review to that exact purchase. Reject stale or substituted requests and changed prices.
- Preserve server-side idempotency, recovery tokens, saved receipts, and the existing provider/storage pipeline.

**Exit:** one image purchase settles on Tempo, executes once, and returns its result and receipt. Network retries cannot cause duplicate service execution or blind repayment.

## 3. Connect a smooth end-to-end user journey

- Add a durable task coordinator around the existing discovery, planning, payment, status, and delivery modules.
- Keep the six skill entry points, but simplify their coordination and present useful outcomes instead of internal steps.
- Build three compact companion views: wallet/readiness, purchase review, and permissions/activity.
- Show the local purchase window automatically; no routine approval links. Queue simultaneous requests rather than stacking Touch ID prompts.
- Combine final creative-plan review and exact purchase approval where practical. Reuse an already-approved plan without removing meaningful consent.
- Display real payment/generation/delivery states and restore the same task after restart. Refresh expired result access without paying again.
- Make first-use funding explicitly Tempo testnet funding; the existing Stellar TRY anchor is not a Tempo on-ramp.

**Exit:** a ready user can ask for an image, review one purchase, use Touch ID, and see the result in either host. Host-required tool permissions remain separate.

## 4. Add bounded spending permissions

- Define the permission model: agent, token, allowed destination/service, per-purchase limit, total allowance, expiry, and policy identifier.
- Require Touch ID to grant or expand authority. Covered purchases use a restricted delegated signer, not an unrestricted owner-signing endpoint.
- Implement policy-bound actions, nonce/replay protection, expiry, audit links, and revocation. Distinguish local service rules from limits actually enforced on-chain.
- For full ERC-8196, implement and test its required interface and verification dependencies; otherwise label the selected features accurately. Do not use mock verification to claim conformance.
- Reserve budget atomically across concurrent purchases. Keep uncertain payments reserved until reconciled.
- Show immediate local pause and pending/confirmed on-chain revocation separately. Do not imply revocation reverses a submitted payment.

**Exit:** one biometric grant permits an in-scope purchase; overspend, replay, wrong destination, expired permission, and confirmed revocation are rejected at the intended enforcement boundary.

## 5. Harden installation, security, and recovery

- Use a narrow authenticated local communication protocol. The companion validates and constructs signed payloads; the agent never receives owner keys or arbitrary signing authority.
- Package a signed, versioned native companion and validate notarization/entitlements and clean-machine installation. Keep development tooling outside the distributable plugin.
- Validate both host manifests, bundled dependencies, CLI installation, and installed operation without development dependencies.
- Test rejection, biometric cancellation, duplicate approval, concurrent spending, restart during payment, lost payment response, provider failure, and broken media preview.
- Ensure secrets and recovery credentials stay out of conversation output and logs.
- Document unsupported Macs and device-bound key reset/recovery limitations. Real-funds support stays out of scope until independent recovery and key rotation are designed and verified.

**Exit:** automated regression checks pass, both hosts are tested manually, and recovery never silently initiates another purchase. Live provider tests require a separately approved cost budget.

## 6. Prepare the hackathon demo and submission

- After the image flow passes, optionally enable the existing composite social-video service through the same MPP adapter, with one purchase and real stage progress.
- Update installation and landing guidance to match tested behavior.
- Demonstrate: useful result → exact Touch ID purchase → bounded permission → allowed purchase → blocked overspend → receipt/recovery.
- Recheck current event rules and submission requirements before recording/submitting. Clearly separate reused Stellar work from new Tempo, policy, native-signing, and UX work.

**Exit:** reproducible installation, a short working demo, and an honest feature/limitation checklist.

## Delivery order and scope control

Implement phases in order. Phase 1 resolves signing and policy risks early; phase 2 establishes the paid service path; phases 3–5 make it usable and safe; phase 6 packages the demonstration. Treat each phase as a reviewable change with tests, not a single large rewrite.

Required first release: existing plugin + image service + Tempo/MPP at both ends + local Touch ID review + bounded permissions + recovery + both-host installation checks. Full ERC-8196 conformance is gated by phase 1 findings and must not be claimed prematurely.

Stretch: composite video and an external MPP service interoperability demo. Excluded initially: production fiat funding/bridging, streaming payments, a new marketplace, Face ID on another device, and production real-funds recovery.

Before live execution, confirm the demo test budget and native signing/distribution credentials. Neither is needed to begin local implementation and automated tests.
