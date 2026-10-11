# Algoria: Colosseum submission roadmap

Research checked: 11 October 2026. This is a proposed roadmap, not a claim that the remaining work is complete. No purchases, outreach, submissions, or code changes are authorized by this document.

## Recommendation

Stay on Tempo. Freeze feature expansion until submission. Turn the working product into a convincing, verifiable startup story: a real task, a clear local approval, a delivered result, and evidence that someone wants to use it again.

Lead with the user's outcome, not a wallet or a protocol acronym:

> Claude and Codex can plan the work. Algoria connects them to paid services that finish it. Ask for a social video, approve the purchase with Touch ID, and get the result back in your conversation.

More precise than “Claude cannot make videos”: assistants can call integrated tools. The gap we address is discovering, buying, and safely completing external services without making the user integrate each provider themselves.

## Verified competition facts

- Deadline: **12 October 2026, 11:59 p.m. Pacific**, equivalent to **13 October, 09:59 in Istanbul**.
- Tempo track: **$100,000 across 10 products**. Overall awards include $30,000 for the grand champion and $15,000 for each of 20 other standout teams. Track awards can supplement overall awards.
- Official judging covers functionality, potential impact, novelty, UX, open-source/composability, and business plan. Submission content must be English; each person can enter only one team/project. See [official rules, sections 5–8, 12 and 14](https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf) and [event awards](https://colosseum.com/worldsfair).

The current [FAQ](https://colosseum.com/hackathon) also emphasizes traction, founder-market fit and communication. It asks for a 2–3 minute presentation and a separate product demo of no more than 3 minutes. Disclose the existing Stellar work; identify the work completed during this competition. Check the actual submission form early for its required fields.

**Funding is separate from prize eligibility.** The [accelerator FAQ](https://colosseum.com/accelerator) explicitly requires some Solana integration. The [cross-chain expansion announcement](https://blog.colosseum.com/expanding-the-arena/) retains that investment focus. Do not present a Tempo-only entry as automatically eligible for the advertised venture funding. Do not bolt on a token Solana feature at the last minute; revisit a meaningful integration only if accelerator eligibility becomes a primary goal.

I did not locate a separate public Tempo-specific judging rubric. Treat the official event criteria as authoritative, and ask organizers about unresolved track details rather than inventing sponsor requirements.

## Why Tempo fits—and what is not unique

[Tempo](https://tempo.xyz/solutions/agentic-payments/) explicitly focuses on agent wallets, spending permissions and paid API access. [MPP](https://mpp.dev/) already connects agents with services including fal, Parallel and model APIs. This supports our direction; it is not evidence of a partnership or endorsement of Algoria.

There is real overlap: [Mercator](https://mercator.sh/docs) already describes discovery, immutable multi-tool plans, paid durable jobs and Claude/Codex setup. Therefore “agents can pay,” “no API keys,” and “one recoverable job” are not sufficient novelty claims by themselves.

Our proposed wedge is **human-supervised service checkout and finished creative work in an existing assistant workflow**. Demonstrate the combination: native local review, hardware-backed signing, an understandable exact plan, a useful output, and recovery without a second purchase. Do not claim we are the first or the only product to offer these features.

## Current product: evidence versus remaining gaps

Checked the actual repository on `main`, commit `5e6bf29`, and public metadata on 11 October. Read-only GETs confirmed all three MPP services on Tempo Moderato (`42431`):

| Service | Listed test PathUSD price | Evidence boundary |
| --- | ---: | --- |
| `image.generate` | 0.01 | A previous live Touch ID purchase and same-job recovery are documented in `TEMPO_LIVE_VERIFICATION.md`; repeat only if needed for the current release. |
| `phone.call` | 0.10 | Deployed route; this review did not perform or establish a live Tempo call. |
| `video.social` | 0.11 | Deployed route and offline coverage; a live Tempo video purchase is still pending. |

The registry returned `algoria@0.12.0`. This does not prove a user's installed copy or companion is up to date. Backend availability and npm publication are not an installed-host test.

Current limits to state clearly:

- macOS companion alongside the host, not a panel embedded inside Claude/Codex.
- Disposable testnet wallets, not persistent production wallets.
- Initial budget approval has its own biometric step; each purchase still needs Touch ID. “One Touch ID” only describes the returning purchase flow after setup, not first use.
- Limits, expiry and revocation are locally enforced. They are not on-chain agent delegation or full ERC-8196 compliance.
- Social output is a vertical montage of generated still scenes, English narration and optional captions. It does not automatically publish to TikTok.
- Test PathUSD is not revenue. Providers incur real costs. The listed prices do not establish sustainable dollar pricing or margins.
- The pitch animation is illustrative, not live proof. Clean installation and natural-language execution in both hosts still need explicit verification.

## What to emphasize

| Official criterion | Algoria's story | Evidence to prepare |
| --- | --- | --- |
| Functionality | The assistant delivers a finished artifact, not just a payment. | Recorded actual purchase, usable MP4, confirmed explorer receipt. |
| Potential impact | People already working in an assistant can access services without separate provider integrations. | A narrow customer profile and observed workflow pain. |
| Novelty | Outcome-focused workflows plus understandable local spending control. | Honest comparison with MPP clients, Mercator and conventional API integrations. |
| UX | The user reviews the job and price, approves locally, and receives the result in the conversation. | Real flow, separate first-use setup, measured prompts/clicks/wait time. |
| Open-source/composability | Existing plugin and services use open payment infrastructure. | Accessible repository, architecture, new-work diff, provider integration recipe. |
| Business plan | A focused first market and a plausible paid service business. | Pilot feedback, provider costs, pricing hypothesis, distribution plan. |

These are our proposed evidence choices, not extra organizer requirements or promises of winning.

## Before submission: strict priority order

### P0 — Prove the hero flow today

1. Choose one practical example: “Create a short vertical launch video for my coffee shop.” Use a fictional brand or assets we have permission to use.
2. Agree on the exact scenes, narration, captions, and voice. Obtain separate user approval for one real provider-backed video, the 0.11 test PathUSD payment plus bounded network fees, and an expiring video-only budget. Prior image approval does not authorize this.
3. Use the published plugin and matching 0.12.0 companion. Show review, genuine Touch ID, actual payment, provider stages and delivered MP4.
4. Open the explorer receipt and play the actual MP4. Save a sanitized evidence record with release, host, date, transaction, job identity and observed outcome; keep keys/recovery tokens private.
5. Recover the same completed job once. Confirm the same transaction/result and no second purchase. Test cancellation before signing separately. Do not create a second paid job to simulate recovery.

Done when: one real video purchase, correct receipt, playable result, and documented recovery. If the video path cannot be stabilized promptly, make the already-proven image path the honest primary demo and label video's remaining status. Never disguise an animation as a live run.

### P0 — Verify the experience in both hosts

Use isolated host profiles so existing user setups are preserved. Actually load the installed plugin in Claude and Codex; installer dry-runs are insufficient. Check version, companion detection, unsupported Touch ID messaging, cancellation, expired/revoked budget rejection and same-job recovery.

Use the host used in the hero demo for the approved paid run. The second host can initially receive installation/readiness and no-payment checks; label the evidence accordingly. A second paid run requires separate approval.

Only fix blockers: missing install steps, confusing wording, lost task recovery, stale companion/version detection, or unsafe retry behavior. Do not introduce persistent wallets, new chains or delegated signing before submission.

### P1 — Gather demand evidence in parallel with preparation

Proposed first customer: indie founders and small marketing teams already using Claude/Codex to prepare launch content. Phone calls demonstrate future breadth; do not split the main sales story between unrelated customer groups yet.

Target, not an existing result: observe 3–5 people trying the workflow, with at least one person outside the team. Ask what they use now, where they get stuck, whether they would repeat the task, and what they would pay. Record permissioned quotes and actual failures. Distinguish interested people, completed tasks, repeat users and paying customers.

Measure first-use setup time, returning-user prompts/approvals, time to output, success rate and recovery outcome. Do not invent a sub-minute generation claim. A small honest sample beats unsupported adoption numbers.

Proposed distribution: targeted creator/founder communities and existing plugin installation channels, followed by provider integrations. This is a hypothesis to test, not an established acquisition engine. Outreach must be separately authorized.

### P1 — Make the business credible

Record actual image, speech, rendering, storage and support costs for the demo. Model contribution margin as real customer revenue minus provider, payment, infrastructure and support costs. Explore a transparent workflow fee or provider revenue share; do not claim it is implemented or profitable.

Explain why users choose Algoria over installing a provider tool or paying directly: fewer integrations, an approved finished workflow, understandable spending and reliable result recovery. Test this claim with the pilot users rather than asserting a moat.

### P0 — Package and submit on 12 October

Internal target: **submit by 22:00 Istanbul time on 12 October**, leaving a substantial buffer before the official cutoff.

- Presentation: problem, customer, real outcome, differentiation, business hypothesis and team.
- Product demo: actual assistant → approval → Touch ID → service → output → receipt. If generation is sped up or cut, label that edit and give the measured real duration. Keep a playable recording as a fallback, clearly identified as recorded.
- Keep the four-slide pitch; replace illustrative-only proof with a genuine demo clip or clearly linked evidence when available. Do not silently relabel the simulated walkthrough as live.
- Ensure every team member has registered, the repository is accessible, and links work in a signed-out browser. Follow actual form limits and retain submission confirmation.
- Add a short “Before / During this hackathon” disclosure, backed by repository history. Separate reused Stellar/plugin/media work from new Tempo/MPP, native signing, permissions and UX changes; do not call all video orchestration new without checking its history.
- Keep testnet labels, platform limitations, local permission boundaries and pending checks visible in the technical appendix.

## Best stretch goal—only after P0 is complete

Prove one independently operated MPP provider, or demonstrate an independent compatible client against an Algoria endpoint. This could strengthen the ecosystem story beyond our own three services.

Time-box the feasibility check. Do not weaken the native endpoint allowlist or approval/input binding to support arbitrary URLs. Verify network/token support, provider recovery semantics and real prices; any paid call needs approval. If integration threatens demo reliability, defer it. A fourth service by itself is lower value than stronger proof.

## After submission: staged product roadmap

**Week 1: trustworthy distribution.** Deliver a Developer ID-signed/notarized companion, version-aware setup, a small compatibility matrix and documented unsupported-device behavior. Add opt-in, privacy-preserving reliability measurements and provider-failure reconciliation. Start the persistent-wallet recovery and lifecycle design before storing funds long term.

**Weeks 2–3: safe repeat use.** Build persistent wallet lifecycle/recovery and audit the threat model. Prototype Tempo access keys on the exact target network, SDK and protocol version before enabling delegation. [TIP-1011](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1011.md) specifies periodic token limits and target/function/recipient constraints, but those do not automatically enforce HTTP service IDs or exact request bodies. Retain application-layer input/endpoint checks and independently test expiry, revocation and over-limit rejection.

Keep human approval as the default. Any opt-in unattended mode needs an explicitly approved restricted key, secure storage, prompt-injection defenses and tested containment. It is a separate product/security milestone, not an optimization to silently enable.

**Weeks 3–4: interoperability and economics.** Add one independent provider end to end with the same safe approval and recovery experience. Validate willingness to pay with repeat users. Introduce real-funds/mainnet support only after custody/recovery, price adequacy, refunds/reconciliation, abuse controls and security review are ready. Do not simply change the chain ID.

**ERC-8196 workstream: explicit feasibility gate.** The [current specification](https://eips.ethereum.org/EIPS/eip-8196) is marked Final and requires more than local budgets: an on-chain wallet/module interface, ERC-8126 verification gating, policy-bound execution, replay controls and a hash-chained audit trail. Build a requirement-by-requirement matrix and verify dependencies/P-256 integration before committing to conformance. Tempo-native access keys and Touch ID do not by themselves implement ERC-8196. Decide whether standards compliance solves a real customer need before adding this complexity.

## Consensus proposal

**Now:** real Tempo video proof → clean host UX → a few real users → concise honest submission.

**Next:** installable secure wallet → restricted repeat use → independent providers → sustainable real-money service.

No new chain, token, general marketplace, or full standards implementation before the deadline. Winning cannot be guaranteed; this plan concentrates on the strongest evidence we can realistically add.
