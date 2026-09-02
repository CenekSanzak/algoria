# Algoria: Go-to-Market and Sustainability Plan

*Prepared for the SCF #45 resubmission. Last verified 2026-09-02. All figures below are targets or scenario assumptions unless explicitly labeled as current evidence.*

## Executive plan

Algoria's near-term sustainability does not depend on winning startup credits or on a 2% transaction fee reaching scale immediately. Managed provider setup and support, contribution from Algoria-operated services, and later embedded/B2B integrations fund the early operating period; the marketplace fee becomes material as paid-job volume grows. The grant request contains **$0 for marketing, cloud hosting, monitoring vendors, model/API credits, user subsidies, fundraising, or event travel**. Those activities are founder-funded or pursued through separate startup programs.

Algoria will enter the market through a focused two-sided loop: help Stellar agent and API providers become safely discoverable and payable, then bring users into a conversation-first client where every job and payment remains explicitly reviewed.

The post-grant business has four staged revenue sources:

1. managed provider setup and support;
2. contribution margin from Algoria-operated services;
3. a 2% marketplace service fee on Algoria-attributed, ledger-verified paid-job GMV from participating providers; and
4. later embedded/B2B integrations for wallets and dApps.

The 2% marketplace fee is not presented as sufficient by itself at early micropayment volume. Near-term sustainability depends primarily on provider services, first-party contribution, and B2B support while the marketplace grows.

## Target users and initial wedge

### Supply: Stellar providers

The first provider segment is a team that already has a useful HTTP API or agent capability but does not yet have complete Stellar 8004 metadata, exact x402 support, recovery behavior, a Skill/MCP description, or integration evidence. Algoria will offer an open onboarding checklist and an optional paid managed-enablement service.

Initial supply targets:

- interview at least 10 agent/API providers;
- technically assess five;
- onboard three external testnet design partners;
- reach five active external providers after the controlled public release; and
- publish conformance and recovery evidence without selling directory ranking.

### Demand: people who want one bounded outcome

The initial demand segment is a Stellar wallet user or builder who wants to hire one service without granting autonomous spending authority. Algoria's acquisition message is not “another AI chat.” It is: describe one outcome, review the exact request, approve the job, separately approve the exact payment, and keep a verifiable receipt and recovery path.

The measured funnel is:

`external wallet connected → exact request reviewed → job approved → payment approved → receipt settled → repeat job within 30 days`

Initial demand targets are 40 activated external wallets and 100 settled external paid jobs. These are forward operating targets, not current traction and not grant-funded acquisition deliverables.

## Distribution plan

### 1. Provider-led distribution

Every onboarded provider receives a reviewable service page, 8004 identity and endpoint evidence, an exact-price/recovery description, and a deep link into the relevant Algoria job flow. Providers can send existing users into a pre-scoped task without granting Algoria silent execution or payment authority.

### 2. Stellar developer and community channels

The team will publish reproducible demos and onboarding workshops through Stellar developer channels, Stellar Türkiye, the public Stellar Agent Search package, the Stellar Skills directory, and appropriate ecosystem events. It will also propose a “Hire on Algoria” link for agent pages on stellar8004.com. Team/test traffic will remain separate from external-wallet metrics; no site placement is counted until accepted.

### 3. Raven and ecosystem handoffs

Subject to Raven maintainer review, Algoria will propose its existing read-only Stellar Agent Search/8004 discovery adapter or a reviewed handoff. Raven can supply context or normalized discovery information; Algoria will still re-resolve identity and endpoints live, apply its own catalog and egress policy, and obtain every execution and payment approval. This is a proposed complement, not an existing partnership, and lean v0 does not execute arbitrary runtime MCP tools.

### 4. Embedded distribution

After the direct product proves repeat use, Algoria will offer wallets and dApps a reviewed service-hiring flow through deep links or a bounded integration package. Commercial terms can combine a one-time implementation fee with recurring support. Mainnet and broader automation remain behind the documented release gate.

## Trial strategy if startup credits are awarded

The base operating plan assumes **$0 in cloud or model credits**. Algoria will apply separately to the Google for Startups Cloud Program and relevant incubators. If qualifying credits are actually awarded, the team will run a capped first-party trial for up to the first 1,000 verified external wallets:

- one limited Algoria-operated trial job per wallet;
- wallet-level eligibility, rate limits, and an aggregate campaign cap;
- no subsidy for third-party x402 USDC principal;
- no silent payment authorization and no relaxation of the per-job/server hard caps; and
- explicit reporting of activation, completed trials, 30-day repeat use, and paid conversion.

Cloud or model credits can offset eligible Algoria compute and first-party inference. They cannot pay the USDC owed to an independent x402 provider. The campaign therefore never advertises all marketplace services as free.

The credit-runway claim has an explicit spending gate: eligible cloud and first-party model usage will be capped at an average of **$2,083 per month** while the trial runs. At that ceiling, $25,000 covers 12 months. This is a conditional usage policy, not a claim that Algoria has received credits or that every vendor cost qualifies.

Suggested experiment gates are at least 20% activation from eligible signup to completed trial, at least 10% 30-day repeat use, and at least 5% conversion to a paid job. These are decision thresholds, not promised outcomes.

## Incubators, credits, and fundraising

Algoria will apply to the Founder Institute Agentic Program for structured company-building, go-to-market and fundraising preparation, and—only after satisfying the program's requirements—access to its alumni network and partner benefits. Founder Institute is not presented as a guaranteed credit award: its public materials describe a 40,000+ member alumni network and $2.5M in partner discounts for alumni, subject to program admission and completion.

Separately, Algoria will apply to the Google for Startups Cloud Program and other relevant provider programs, targeting an aggregate **$25,000–$75,000 in non-cash cloud and AI credits**. Some team members previously secured credit packages in this range for earlier startups, so the team understands the application and redemption process; that experience is not a guarantee that Algoria will qualify or receive the target amount.

Google's public program currently advertises different benefits by eligibility tier, from up to $2,000 for the Start tier to larger “up to” amounts for qualifying funded and AI startups. Algoria has not established eligibility for a particular tier. Acceptance and the awarded amount are discretionary, and third-party models are not covered by standard Google Cloud credits. The financial base case therefore remains $0 credits until an award is confirmed. Under the $2,083 monthly eligibility cap above, the lower end of the target would cover 12 months of eligible cloud and first-party model usage. It does not cover salaries, travel, or USDC owed to independent x402 providers, and Algoria will not move its canonical Supabase store or security-sensitive services merely to consume a credit.

For Meridian 2026 in Lisbon on October 28–29, the team will register, seek an appropriate demo or ecosystem-showcase opportunity only if applications remain open, build a named list of 15 providers, customers, and investors, request 10 meetings, target five completed qualified meetings, and pursue three concrete follow-ups. The published speaker-application deadline has passed, so this plan does not assume a speaking slot. Travel, tickets, presentation work, and fundraising are charged to SCF at $0. Meetings, showcase acceptance, and investment are not assumed.

## Revenue model

### Managed provider enablement

Algoria will test a $750–$1,500 one-time setup price and $149–$299/month for ongoing conformance, analytics, documentation, and maintenance. Providers pay for implementation and support, not access to the open registry or preferential ranking.

### First-party service contribution

Where Algoria operates a service, the user sees one exact disclosed x402 quote. Algoria reports gross revenue, underlying model/compute cost, and contribution margin separately.

### Paid Skills and MCP-described services catalog

After the controlled HTTP/x402 flow proves repeat use, Algoria will add a Stellar-native catalog for paid services that publish Skill or MCP discovery artifacts. Registry discovery and listing remain open; providers pay through the same managed-enablement, support, or attributed-job fee paths described here—not for preferential ranking. Arbitrary runtime MCP execution, delegated spending, MPP, and autonomous tool use remain outside lean v0 until separately reviewed and gated.

### 2% paid-job marketplace fee

After provider pilots and signed commercial terms, participating providers may pay Algoria 2% of Algoria-attributed, ledger-verified settled GMV. Exact x402 currently sends the disclosed amount to one `payTo` recipient, so Algoria will not claim a hidden automatic split. The initial implementation is a monthly provider invoice reconciled against ledger-verified jobs.

### Later 2% top-up fee

If Algoria later introduces an explicitly reviewed prepaid balance, it may charge a disclosed 2% fee when a user tops up. The direct-pay provider fee and the prepaid top-up fee are alternative collection mechanisms for the same marketplace economics: Algoria will not stack both fees on the same underlying value flow. A prepaid balance, automated split, escrow, or delegated spending path requires a separate product-policy, security, legal, and consent review and is not part of lean v0.

### Embedded/B2B integrations

Wallets and dApps may pay a one-time integration fee and recurring support for a branded, bounded service-hiring flow. Pricing will follow evidence from the first pilots rather than being represented as booked revenue today.

## Illustrative 12-month projection

This is a falsifiable operating scenario, not booked revenue, contracted demand, or a grant deliverable. Each row is the target monthly run rate at the end of the period. Because the first-party row is contribution after direct model/compute cost while the other commercial rows are revenue, the total is an operating-planning proxy rather than an accounting revenue total. Actual reporting will separate gross revenue, variable cost, and contribution margin.

| End-of-period monthly run rate | Q1 | Q2 | Q3 | Q4 |
|---|---:|---:|---:|---:|
| Settled paid jobs/month | 100 | 600 | 1,500 | 3,000 |
| Average provider price | $0.75 | $1.00 | $1.25 | $1.50 |
| Settled provider GMV/month | $75 | $600 | $1,875 | $4,500 |
| 2% marketplace revenue | $2 | $12 | $38 | $90 |
| Managed-provider recurring revenue | $298 | $995 | $1,992 | $2,988 |
| Average setup revenue/month | $375 | $1,000 | $1,250 | $1,250 |
| First-party contribution/month | $100 | $300 | $600 | $1,000 |
| Embedded/B2B support/month | $0 | $0 | $750 | $1,500 |
| **Illustrative monthly operating proxy** | **$775** | **$2,307** | **$4,630** | **$6,828** |

The table makes the central economic point visible: at $4,500 monthly marketplace GMV, a 2% fee produces only $90. Provider enablement, first-party contribution, and B2B support must fund the early operating period while usage compounds.

## Post-grant continuity and cost discipline

- SCF pays only for the named future build artifacts; all GTM and operating costs remain $0 in the request.
- The base case assumes no incubator acceptance, cloud/model credit, investment, or Meridian-driven deal.
- Until recurring gross contribution reaches $3,000/month, the founders will cap cash operating spend at $1,500/month and keep mainnet/public-routing expansion behind evidence gates.
- Credits, if received, reduce eligible compute costs but are recorded as non-cash offsets, not revenue or traction.
- If managed-provider demand or repeat paid use does not emerge by month six, the team will stop broad marketplace expansion, preserve the secure direct product, and concentrate on the provider/B2B segment with demonstrated willingness to pay.

## Reporting and decision gates

Algoria will publish or maintain a monthly operating record covering:

- active external providers;
- unique activated external wallets;
- approved jobs, settled paid jobs, and 30-day repeat use;
- team/test traffic separately from external activity;
- GMV and 2% fee revenue;
- provider setup revenue and managed-service MRR;
- first-party variable cost and contribution margin;
- recovery outcomes and duplicate-payment prevention; and
- trial subsidy cost, abuse rate, and paid conversion where a credit-funded trial exists.

## Sources

- [Google for Startups Cloud Program eligibility and benefits](https://cloud.google.com/startup/benefits)
- [Google for Startups Cloud Program FAQ](https://cloud.google.com/startup/faq)
- [Founder Institute Agentic Program](https://fi.co/core)
- [Founder Institute post-program support and partner benefits](https://fi.co/scale)
- [Meridian 2026 event details](https://meridian.stellar.org/event-details)
- [Stellar x402 documentation](https://developers.stellar.org/docs/build/agentic-payments/x402)
- [Stellar Raven documentation](https://raven.stellar.org/docs) and [terms](https://raven.stellar.org/terms)
