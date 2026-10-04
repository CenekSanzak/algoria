# Algoria Plugin — Colosseum Architecture and Build Plan

Date: 2026-10-04 · Repository: `algoria-x` · Branch: `colloseum-intro`

Status: proposed additions to the existing Stellar hackathon product. Based on this repository's source, submission, technical documentation, and recorded verification. Existing live services were not called during this review.

## Project description

Algoria lets users buy AI services inside Claude and Codex. The plugin discovers a suitable service, prepares the work, pays within the user's permission, and returns the result. Users keep their conversation, preferences, and job history without managing a separate service account or API key for every provider.

For Colosseum, extend that same plugin with Tempo/MPP payments, ERC-8196 authorization features, and a small local wallet interface with Apple biometric signing.

The demo starts with a familiar request such as “Create an image for my product.” Algoria shows the proposed purchase, the user approves with Touch ID, and the generated image returns to the conversation with a receipt. A second demonstration grants a limited budget and shows both a covered purchase and a blocked purchase.

## What is already built

| Component | Current implementation and evidence |
| --- | --- |
| Claude/Codex plugin | `agent-skills/plugins/algoria`, version 0.8.3; both host manifests and a shared CLI/skill implementation |
| Six skills | Wallet, mock TRY top-up, discovery, payments, remote MCP invocation, and local memory |
| Local wallet and records | Stellar wallet, deposits, budgets, jobs, locks, and preferences under `~/.algoria/`; no persistent wallet daemon today |
| Funding | Mock TRY → Stellar testnet USDC through SEP-10/SEP-6 anchor integration, with pending-deposit reconciliation |
| Discovery and execution | Algoria catalog plus Stellar8004 external discovery; x402 testnet payments; separate unpaid MCP invocation path |
| Paid service backend | `platform/`: Hono/TypeScript on Supabase Edge Functions, Postgres, private Storage, fal media processing, and a configured phone service |
| Useful workflows | Image, speech, slideshow, composition, captions, composite `video.social`, and `phone.call`, subject to deployment configuration |
| Recovery | Saved job identity and recovery token, immutable input, budget reservations, status recovery, signed URL refresh, and no automatic repayment after uncertainty |
| Distribution | Self-contained npm/plugin package with bundled SDKs, installer, root marketplace manifests, and `landing/` onboarding pages |

`agent-skills/SUBMISSON.md` establishes the original product: buy additional AI capabilities from inside Claude/Codex, with a simple funding experience. `platform/VERIFICATION.md` records successful Stellar testnet image and narrated-video runs; those are historical evidence, not a fresh claim about current deployment health. Its recorded test count is also historical.

The root SvelteKit application is a separate older surface. The plugin and `platform/` API are the relevant hackathon foundation.

## User flow

### First use

Install/update the plugin using the existing host installer. A readiness check detects the host, companion availability, Tempo wallet, and balance. The local companion sets up Apple signing once and displays the network clearly. For the first demo, offer labeled Tempo testnet funding and resume the same task after confirmation.

The existing TRY anchor settles on Stellar. It is not a Tempo on-ramp and must not be presented as one. Real fiat funding on Tempo requires a separately verified provider or bridge; it is outside the first demo.

### One purchase

1. The user requests an outcome. The plugin checks readiness/balance, recalls preferences, and discovers a supported service.
2. The assistant prepares the concrete work. Creative tasks still require approval of the actual plan; an existing budget does not approve newly invented scenes or narration.
3. Algoria obtains the live MPP quote and freezes the request. A quote request must not execute an irreversible action.
4. The local wallet view presents the task, provider, token amount, fees if any, network, and expiry. The user selects **Approve with Touch ID**.
5. The native companion validates the displayed request and uses biometric-protected signing. Expired or changed terms require a new review.
6. The plugin pays and follows the saved job. The same activity view becomes progress and then a receipt; the assistant presents the actual result.

A single review can approve both a visible final plan and its exact purchase. If creative review already occurred, do not ask for that same review again. Host-imposed tool permissions remain under host control.

### Limited permission

The user reviews a specific agent, allowed services/recipients, token, total budget, per-purchase cap, and expiry. Touch ID authorizes that permission. Covered purchases then proceed without another biometric prompt. New creative plans still receive content review; scope or budget expansion requires new authorization.

Provide immediate local pause and authenticated on-chain revocation where applicable. Show revocation as pending until confirmed. Already-submitted payments cannot be cancelled by revoking future access.

## Proposed architecture

```text
Claude / Codex
      |
Existing Algoria skills + CLI
      |
Local task coordinator and persistent job ledger
      |-- Discovery, preferences, plans, budgets, recovery
      |-- Local wallet view and native macOS companion
      |       +-- Touch ID / Secure Enclave owner signer
      |       +-- Restricted delegated signer and policy checks
      |-- Tempo / MPP client adapter ------> Tempo
      +-- Paid HTTP request --------------> Algoria platform or external MPP service
                                                |
                                     MPP verification / settlement
                                     Existing jobs, providers, storage
                                                |
                                     Result + receipt back to plugin
```

### Reuse and changes by location

- `agent-skills/plugins/algoria/lib/services/`: preserve discovery, saved requests, reservations, delivery, and uncertainty rules; separate Stellar x402 specifics from the execution lifecycle and add MPP support.
- New Tempo wallet/signing adapters: use explicit chain/token profiles and token decimals. Do not reuse Stellar address validation, seven-decimal amounts, SEP-10, or Horizon settlement assumptions.
- `skills/` and shared CLI: keep the six-skill entry points; route new Tempo flows through shared modules. Update network, funding, approval, and delivery instructions consistently.
- New native companion source outside the distributable plugin root: compact macOS approval UI, authenticated local communication, biometric signing, and permission management. Package only built runtime assets through a verified distribution process.
- `platform/supabase/functions/api/`: add MPP quote/verification/settlement for an initial existing image service. Preserve service schemas, provider execution, idempotency, recovery tokens, storage, and result delivery. Version payment records to distinguish chain/protocol/token. A client-only port cannot pay the existing Stellar-only endpoints.
- `platform/` follow-up: enable the existing composite `video.social` through the same payment adapter. Its internal fal stages remain one user purchase; do not bill every stage again.
- `landing/`: update setup and demo guidance after the tested flow is stable.

An external MPP provider can prove interoperability, but own-service MPP support is part of demonstrating the existing product on Tempo. No external service's result-recovery support should be assumed from MPP alone.

## Apple biometric signing

Use a small signed Swift/SwiftUI macOS companion with a Secure Enclave P-256 key and Apple's LocalAuthentication/key access controls. Require Touch ID at owner-key use. The agent submits a structured request; the companion validates it, shows the trusted summary, and constructs the signed payload. Do not expose unrestricted digest signing or return private keys to Node/model context.

Approve-once requests authenticate each payment. Delegation authenticates the permission once, then a restricted signer handles covered purchases. Keep these two meanings clear in the UI.

Prototype the custom Tempo signer bridge, hashing/encoding, MPP settlement, and P-256 contract verification. An SDK function accepting a raw private key cannot consume a non-exportable enclave key. A biometric prompt by itself is not a spending policy.

The first supported biometric environment is a Touch ID-capable Mac. Do not promise Face ID on Mac. Handle cancellation, lockout, unsupported hardware, and enrollment changes explicitly, with no silent software-key fallback. Device-bound key recovery/rotation must be designed before real-funds use. Testnet reset/refunding is only a demo recovery path.

## ERC-8196 scope

Add signed permissions/actions bound to a policy hash, expiry, nonce replay protection, revocation, and linked audit records. Extend application policies with service/request restrictions and token-specific budgets.

Full conformance additionally requires the specified on-chain wallet interface and ERC-8126 verification before agent actions. Verify the actual dependency, P-256 verifier, and MPP-compatible execution path early. Native-value limits alone do not constrain token-transfer amounts. If only the selected features are implemented, label them **ERC-8196-inspired**, not fully compliant. Mock risk scores cannot demonstrate production verification. [ERC-8196](https://eips.ethereum.org/EIPS/eip-8196)

## Build plan

1. **Prove the critical path:** from the source plugin, present a local approval in Claude and Codex; use Touch ID to sign a Tempo testnet payment; verify settlement and return completion. Resolve native packaging and ERC-8196 integration feasibility.
2. **Port one existing service end to end:** MPP on the image endpoint and client, token-aware records, exact approval binding, budget reservations, recovery, and result preview. Preserve Stellar behavior behind its existing adapter.
3. **Add policy permissions and polished UX:** biometric grants, bounded delegated execution, expiry/revocation, policy-linked receipts, readiness handling, persistent task progress, and actionable recovery.
4. **Extend and demonstrate:** optionally port composite social video after image payments work. Record the useful result, biometric purchase, limited permission, and blocked overspend. Update installation and landing guidance.
5. **Validate and submit:** plugin unit/type checks, installed-package validation without development dependencies, platform tests, native signing tests, and explicit host UX checks. Disclose reused Stellar work and new Tempo/policy/UI work in the submission.

Follow `agent-skills/CONVENTIONS.md`: tests/build tooling stay outside the shipped plugin, runtime dependencies are bundled, both manifests agree, and npm/plugin distribution remain self-contained. Treat adding a native companion as an explicit packaging extension requiring clean-machine validation.

Acceptance includes rejection, changed/expired quote, biometric cancellation, duplicate approvals, concurrent purchases, restart, revoked permission, lost paid response, and failed preview. These must not silently create a second payment. Live media tests incur real provider costs even when chain funds are testnet; run them only with a deliberate test budget.

## Scope for agreement

Build the existing Claude/Codex service-buying plugin on Tempo, with MPP at both payment ends, useful ERC-8196 policy features, and a smooth local wallet using Touch ID. Start with the existing image service; reuse the social-video workflow after the payment/signing path is proven.

First-demo exclusions: a new general chatbot, a replacement marketplace, a production Tempo fiat on-ramp, streaming payments, and unverified claims of full ERC-8196 compatibility.

## References

- [Original submission](../agent-skills/SUBMISSON.md)
- [Plugin technical documentation](../agent-skills/TECHNICAL_DOCUMENTATION.md)
- [Plugin conventions](../agent-skills/CONVENTIONS.md)
- [Service backend](../platform/README.md)
- [Recorded verification](../platform/VERIFICATION.md)
- [Social-video contract](../platform/docs/SOCIAL_VIDEO.md)
- [UX and biometric proposal](./PLUGIN_UX_PROPOSAL.md)
- [Colosseum event](https://colosseum.com/worldsfair) and [submission requirements](https://colosseum.com/hackathon)
- [MPP SDK](https://github.com/wevm/mppx), [Tempo access keys](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1011.md)
- [Apple key protection](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
