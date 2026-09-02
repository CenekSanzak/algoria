# Algoria: Market, Competition, GTM, and Sustainability

*Prepared for the SCF #45 resubmission. Last verified 2026-09-02. Companion to [technical_doc.md](./technical_doc.md).*

## Executive finding

Stellar's agent ecosystem is no longer empty. It includes payment rails, wallets, agent frameworks, registries, MCP gateways, skill directories, and several emerging marketplace prototypes. The defensible opportunity for Algoria is therefore not “the first AI chat” or “the only agent marketplace.” It is a narrower product boundary:

> Algoria lets a person select one independently registered Stellar 8004 service, review one bounded immutable request, approve that job separately from its exact x402 payment, and recover safely when settlement is uncertain.

The current proof of concept already contains persistent conversations, wallet authentication, separate job and payment approval, exact x402 on testnet, ledger-verified receipts, recovery, and a payer-signed reputation path. Those components are completed foundation, not future market claims and not work to be billed again. The remaining build is to bind identities to payment addresses, promote discovery from an operator allowlist to open 8004 resolution without weakening the security model, conform Algoria-operated providers to the authenticated OpenZeppelin facilitator, and pass a deliberate public-release gate.

## Stellar market map

| Category | Current examples | What they prove | Relationship to Algoria |
|---|---|---|---|
| Read-only Stellar context | [Stellar Raven](https://raven.stellar.org/docs), LumenLoop MCP | AI clients want one machine-readable entry point into Stellar information and services. | Complementary information layer; Raven does not authorize or submit transactions or move value. |
| Agent identity and discovery | [Stellar 8004](https://stellar8004.com), [Stellar Agent Search](https://github.com/berkingurcan/stellar-agent-search) | Providers can publish open identity, service, and reputation metadata. | Algoria consumes this public layer and adds a human-reviewed execution and payment workflow. |
| Agent payment rails | [Stellar x402](https://developers.stellar.org/docs/build/agentic-payments/x402), MPP Discover, Nirium, ROZO | USDC-denominated machine payments and paid API access are technically available. | Composed infrastructure, not proprietary differentiation. |
| Wallet policy and delegation | [Soneso Stellar Agent Wallet](https://github.com/Soneso/stellar-agent-wallet), [REAPP](https://learnreapp.xyz/overview) | Human approval, spending policy, and delegated wallets are established design spaces. | Adjacent infrastructure; Algoria must differentiate on the complete service-hiring consent and recovery flow, not approval alone. |
| Escrow and task markets | Trustless Work, Cogladius | Longer-running jobs and conditional payouts have dedicated primitives. | Adjacent. Lean Algoria v0 executes one bounded HTTP service call and does not duplicate escrow. |
| Agent developer tooling | [Stellar MCP](https://github.com/JoseCToscano/stellar-mcp), Stellar AI Agent Kit, Arcturus | Developers can query Stellar or equip agents with Stellar tools. | Building blocks or information interfaces rather than the same end-user transaction product. |
| Emerging paid-agent products | [CleverCon](https://github.com/clevercon-protocol/clevercon), [StellarMind](https://github.com/Flamki/stellarmind), [Forge402](https://github.com/AswinWebDev/Forge402), [Oraculum](https://github.com/Akazajan/Oraculum) | “Agents that discover or pay other agents” is an active and crowded product direction. | Direct or near-direct comparison set. Public repositories establish product claims, not production adoption. |

The [Stellar Skills directory](https://skills.stellar.org/llms.txt) listed 29 community-built entries when checked on 2026-09-02. This is useful supply evidence, but it is not proof that consumers will pay agents. Algoria's GTM must convert tool and provider supply into completed and repeated paid jobs.

## Stellar Raven: complementary, not a transaction competitor

[Raven's documentation](https://raven.stellar.org/docs) describes a remote MCP server that gives AI agents Stellar documentation and ecosystem context through one connection. It exposes `search` and `execute`, but `execute` runs read-only host adapters in a sandbox. [Raven's terms](https://raven.stellar.org/terms) are explicit: it does not sign, authorize, or submit transactions; custody keys or assets; or move value.

Algoria starts at that boundary. It independently resolves an eligible Stellar 8004 service, presents the exact request, keeps job approval separate from payment approval, validates the exact x402 quote, verifies settlement against the ledger, persists the result and receipt, and prevents blind repayment when status is uncertain.

Short positioning: **Raven gives AI clients read-only Stellar context; Algoria is the marketplace where a person can hire a registered trading, web-scraping, or design agent, review the exact task, separately approve its exact x402 USDC payment on Stellar, verify the ledger receipt, and recover without paying twice.**

The proposed complement is intentionally read-only and does not imply an existing partnership:

1. Publish a stable Algoria service/Skill description and propose the existing read-only Stellar Agent Search/8004 discovery adapter or a reviewed handoff to Raven's maintainers.
2. Let Raven surface normalized identity and discovery context; Algoria must still re-resolve the identity and endpoint live, apply its own catalog and egress policy, and obtain every execution and payment approval.
3. Never pass a wallet key, payment credential, or silent spending authority through Raven.
4. Treat catalog inclusion as subject to Raven maintainer review, not as a promised integration or SDF endorsement.

## Closest substitutes and differentiation

**CleverCon** is the closest functional overlap found in the current public landscape. Its public application is a task-and-vault dashboard: a user submits a natural-language task and budget, reviews a multi-step plan, and monitors agent activity and results. Its public source also includes timed auto-approval for a plan that remains inside the deposited budget. Algoria deliberately chooses a different interaction and trust boundary: a persistent conversation, one bounded service invocation, an immutable request snapshot, an explicit job approval, a separate exact-payment approval, ledger reconciliation, and recovery without paying twice. CleverCon is workflow/orchestration-first; Algoria is conversation-and-consent-first.

**StellarMind** exposes a natural-language task field, budget slider, live agent event feed, and final-result panel in an orchestration dashboard. It is not a persistent ChatGPT-like conversation with per-job execution cards. **Forge402** is an agent-fleet, tool-marketplace, and mission-runner product whose public positioning emphasizes autonomous execution without human intervention. **Oraculum** describes pay-per-query vertical agents, wallet-tied memory, and a 1:1 chat for its Numina agent; that is closer at the individual-agent level, but it is not the same as one general conversation that resolves third-party 8004 services and keeps execution and payment consent separate. A comparable live general-chat surface was not independently verifiable from its public repository on the verification date.

These projects mean Algoria should not use “first,” “only,” “marketplace,” or a ChatGPT-like shell as its moat. The chat surface is a distribution and usability choice; the defensible product is the consent and recovery protocol embedded inside it. Algoria's current policy also does not promise autonomous multi-agent orchestration, A2A, public Bazaar routing, arbitrary runtime MCP execution, or silent spending.

**Stellar Agent Wallet and REAPP** cover adjacent wallet policy, delegation, and payment infrastructure. Human approval alone is therefore not unique. The defensible combination is:

- live Stellar 8004 identity and service resolution;
- a user-reviewed, immutable request snapshot;
- a separate exact-payment approval with explicit cap;
- live endpoint re-resolution and outbound-network controls;
- ledger verification rather than trusting a facilitator response;
- durable result, receipt, and uncertain-settlement recovery without repayment.

This can be copied at the feature level. Durability must be earned through provider integrations, conformance fixtures, reliable recovery, repeat-use workflows, and distribution—not claimed as exclusive data or an uncopyable protocol. In a fast-moving market, Algoria will maintain the stable consent/recovery invariants while adding ecosystem changes through bounded adapters, public fixtures, and a documented threat-model gate. The strategy is not to chase every new protocol: each Raven, facilitator, registry, or payment integration must preserve live re-resolution, explicit approval, spend caps, ledger verification, and recovery.

## Evidence and traction

The evidence should be separated so technical validation is not mislabeled as customer adoption.

### Independently verifiable ecosystem signals

Taken together, these are core technical, supply-side, discovery, and team-execution traction for the product Algoria is building. They do not yet constitute independent evidence of retained Algoria end-user usage.

- The public [Stellar 8004 API](https://stellar8004.com/api/v1/agents?limit=100) returned 68 registrations on 2026-09-02. Four non-team owners control five registrations: RendeGate, two `murr` registrations, AgentKarma, and ROZO MPP Router; the other 63 are team-seeded records. This is external supply-side adoption of the registry, not 68 Algoria users.
- The public npm endpoint reported [259 downloads in the last month](https://api.npmjs.org/downloads/point/last-month/stellar-agent-search) for `stellar-agent-search` for 2026-07-31 through 2026-08-29. The package is also [active in the official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=stellar-agent-search) and listed in the public [Stellar Skills directory](https://skills.stellar.org/llms.txt). These are external distribution signals for the discovery layer; they do not prove retained or paid Algoria users.
- The Stellar 8004 layer has attracted external registrations or integrations from RendeGate, `murr`, AgentKarma, ROZO MPP Router, [Nebula](https://github.com/Caerlower/Nebula), [Open Stellar Passport](https://github.com/Bitcoindefi/open-stellar-passport), and A-Identity. The public npm endpoint also reported [491 downloads](https://api.npmjs.org/downloads/point/2026-04-01:2026-09-02/%40trionlabs%2Fstellar8004) for `@trionlabs/stellar8004` from 2026-04-01 through 2026-09-02. These are core supply-side and technical-adoption signals for the 8004 layer Algoria uses; they are not yet retained Algoria end-user adoption.

### Product and execution evidence

- Algoria's public repository shows the thread, consent, payment, receipt, and recovery implementation and its automated tests.
- In a team-run mainnet proof, Algoria paid third-party ROZO MPP Router Agent 67 ([0.002 USDC payment](https://stellar.expert/explorer/public/tx/595a418325912893e2d7ec33a3dc443fe629e3380534b97e58487168874e0983); [payer-signed reputation](https://stellar.expert/explorer/public/tx/85957ea1d3f5e0bfa064967ddbdfc61fa27555b134d3ed577733f10034f3d63f)). The buyer was the team, so this is direct Algoria technical validation—not a customer, revenue, market-volume, or independent-adoption claim.
- SDF's [2026-04-23 developer meeting notes](https://developers.stellar.org/meetings/2026/04/23) highlighted Stellar 8004 among the standout submissions from a 260+ project hackathon and explicitly said the examples were not endorsements. This is independent ecosystem recognition of the underlying problem and implementation, not Algoria customer adoption.
- Berkin and Doğukan previously shipped zkApp Umstad under Mina's zkIgnite program, before agent tooling was a category. It ran as Mina's AI developer assistant across Discord, web, and CLI. Its Discord deployment served 500+ Mina developers and peaked at roughly 200 monthly active users while the ecosystem was still early; these figures come from the team's historical Discord analytics and are not independently reproducible like on-chain evidence. Berkin later delivered the $5,000 Stellar Türkiye Instaward for Stellar Agent Search, published it on npm, made it MIT-licensed, and obtained a Stellar Skills directory listing. These are execution-history signals, not Algoria user traction; the same team now applies that developer-assistant operating experience to a paid-agent product. [Umstad](https://github.com/UmstadAI/zkAppUmstad) · [Stellar Agent Search](https://github.com/berkingurcan/stellar-agent-search)

The honest remaining weakness is independent demand-side adoption. The post-build funnel must therefore report unique external wallets, approved jobs, settled paid jobs, 30-day repeat use, active external providers, recovery outcomes, GMV, and revenue. Team wallets and test transactions must stay in a separate technical-validation category.

## Go-to-market plan

GTM work, user acquisition, fundraising, Meridian travel, and cloud operating costs are founder-funded and charged to SCF at **$0**. The Build request funds only named future engineering and product deliverables.

### Phase 1 — provider and user validation (during the build)

**Supply loop.** Interview at least 10 agent/API providers, complete technical assessment with five, and target three external testnet design partners that can publish Stellar 8004 metadata and accept exact x402. Provide an open onboarding checklist rather than charging for directory inclusion.

**Demand loop.** Recruit independent testers through Stellar developer and community channels. Measure the complete funnel:

`connected wallet → reviewed job → payment approval → settled receipt → repeat job`

Initial operating targets are five external providers, 40 activated external wallets, and 100 settled external paid jobs. These are forward targets, not current traction or grant deliverables purchased with marketing spend.

### Phase 2 — provider enablement and distribution

Launch an optional managed-provider service: package a provider's API into Stellar 8004 metadata, exact x402 support, MCP/Skill artifacts, integration QA, analytics, and maintenance. Initial willingness-to-pay tests are $750–$1,500 one-time setup and $149–$299 per month for managed support. Open discovery remains open; providers pay for implementation and operations support, not ranking or access to the registry.

Publish a Stellar-native catalog for paid Skills and MCP-described services. In the first safe version, metadata and discovery are open while execution remains a reviewed HTTP/x402 flow. Runtime MCP execution remains a later, separately gated product-policy decision. Avoid the unverified claim that this is the “first” paid MCP/Skills market.

Distribution work includes reviewed deep links from Stellar Agent Search, a “Hire on Algoria” link proposed for agent pages on stellar8004.com, proposed Raven catalog/handoff contributions, wallet/dApp integration outreach, Stellar Türkiye workshops, and demos at ecosystem events. No partnership, site placement, or catalog acceptance is counted until confirmed.

If qualifying cloud/model credits are actually awarded, Algoria will run a capped first-party trial for up to the first 1,000 verified external wallets: one limited Algoria-operated job per wallet, rate limits, an aggregate campaign cap, and explicit activation/repeat/paid-conversion reporting. Cloud credits can offset eligible Algoria compute; they cannot pay the USDC owed to an independent x402 provider. Third-party paid services therefore remain paid and separately approved.

### Phase 3 — ecosystem programs and capital

- Apply to the Founder Institute Agentic Program for structured company-building, GTM and fundraising preparation, and—only after satisfying the program's requirements—access to its alumni network and partner benefits. Founder Institute is not presented as a guaranteed credit award. Its public materials describe a 40,000+ member alumni network and $2.5M in partner discounts for alumni, subject to admission and program completion.
- Register for [Meridian 2026](https://meridian.stellar.org/event-details), prepare a 15-person provider/investor/customer target list, request 10 meetings, target five completed qualified meetings, and aim for three concrete follow-ups. Meridian participation and travel are founder-funded; meetings and investment are not guaranteed.
- Separately apply to the [Google for Startups Cloud Program](https://cloud.google.com/startup/benefits) and other relevant provider programs, targeting an aggregate $25,000–$75,000 in non-cash cloud and AI credits. The base case assumes **$0 credits until confirmed**. Google's current public terms range from up to $2,000 for the Start tier to larger “up to” amounts for qualifying funded and AI startups; Algoria has not established eligibility for a particular tier, and third-party models are not covered by standard Google Cloud credits. Neither acceptance nor a specific award is guaranteed. Eligible cloud and first-party model usage will be capped at an average of $2,083 per month while a credit-funded trial runs; at that ceiling, $25,000 covers 12 months. Credits do not cover salaries, travel, or USDC owed to independent x402 providers. The team will use only credits actually awarded and will not migrate the canonical Supabase store or security-sensitive services solely to consume them.

Some team members previously secured credit packages in the target range for earlier startups, so the team understands the application and redemption process; that experience does not guarantee acceptance for Algoria. Neither Google nor an incubator promises Algoria a $25,000 or $75,000 minimum. The application therefore says “target” and “if awarded,” not “secured.” The 12-month statement is a conditional usage cap for eligible platform/model costs, not a claim that credits pay salaries or every company expense.

## Revenue and sustainability

Revenue is staged so that the plan does not depend on a fee mechanism that is absent today.

1. **Managed provider enablement:** setup and recurring support for 8004/x402/MCP/Skill packaging, QA, analytics, and maintenance.
2. **First-party provider margin:** where Algoria operates a service, the user sees one exact disclosed quote and the team measures its underlying variable cost.
3. **2% provider-side marketplace fee:** after commercial pilots, participating third-party providers may pay Algoria 2% of Algoria-attributed, ledger-verified settled GMV under a provider agreement.
4. **Embedded/B2B integrations:** paid deployment or support for wallets and dApps that embed the reviewed Algoria service-hiring workflow.

The current exact x402 requirement has one `payTo` address and settles the disclosed amount directly to that recipient. Algoria therefore must not claim that it automatically withholds or silently adds 2% today. The first commercial version of the 2% fee can be invoiced monthly to participating providers from ledger-verified GMV. Any automatic split, escrow, or settlement contract would be a later design requiring separate security, legal, and user-consent review.

If Algoria later introduces an explicitly reviewed prepaid balance, it may charge a disclosed 2% top-up fee. The provider-side direct-payment fee and the user-side prepaid top-up fee are alternative collection mechanisms; Algoria will not stack both on the same underlying value flow. Prepaid balances, delegated spending, and automatic splits remain outside lean v0 and require a separate policy and security gate.

The unit economics are transparent:

| Monthly settled provider GMV | Revenue at 2% |
|---:|---:|
| $1,000 | $20 |
| $10,000 | $200 |
| $50,000 | $1,000 |

The take rate aligns incentives but cannot fund the team at early micropayment volume. Near-term sustainability therefore depends on provider setup/support revenue, first-party service margin, and later B2B integrations, while credits and investment remain upside. Monthly reporting should include active external providers, paid jobs, GMV, 2% fee revenue, managed-service MRR, variable costs, gross contribution, and retention.

An illustrative, falsifiable end-of-quarter monthly run-rate scenario is below. Because the first-party row is contribution after direct model/compute cost while the other commercial rows are revenue, the total is an operating-planning proxy rather than an accounting revenue total. Actual reporting will separate gross revenue, variable cost, and contribution margin.

| Monthly run rate at period end | Q1 | Q2 | Q3 | Q4 |
|---|---:|---:|---:|---:|
| Settled paid jobs | 100 | 600 | 1,500 | 3,000 |
| Settled provider GMV | $75 | $600 | $1,875 | $4,500 |
| 2% marketplace revenue | $2 | $12 | $38 | $90 |
| Managed-provider recurring revenue | $298 | $995 | $1,992 | $2,988 |
| Average setup revenue | $375 | $1,000 | $1,250 | $1,250 |
| First-party contribution | $100 | $300 | $600 | $1,000 |
| Embedded/B2B support | $0 | $0 | $750 | $1,500 |
| **Illustrative monthly operating proxy** | **$775** | **$2,307** | **$4,630** | **$6,828** |

This is a target scenario, not booked revenue. The full assumptions, trial rules, continuity policy, and decision gates are in [go_to_market_and_sustainability.md](./go_to_market_and_sustainability.md).

## Risks and falsifiable gates

| Risk | Mitigation and decision gate |
|---|---|
| Supply exists but users do not pay | Separate team/test traffic from external paid jobs; measure 30-day repeat use and stop broad feature expansion if repeat demand does not emerge. |
| A 2% take rate is too small at micropayment scale | Treat it as secondary; validate managed provider and embedded B2B pricing first. |
| Credits or investment do not arrive | Base plan assumes $0 credits and $0 investment; keep recurring services team-funded and cost-capped. |
| A credit-funded free trial attracts abuse rather than users | Limit it to one first-party trial per verified wallet, enforce rate and aggregate caps, and continue only if activation, repeat use, and paid conversion clear published gates. |
| Open routing increases SSRF, substitution, and payment risk | Keep mainnet/public routing disabled until live re-resolution, egress checks, caps, adversarial fixtures, and release evidence pass. |
| Competitors copy features | Compete on integration quality, consent/recovery reliability, provider distribution, and measurable repeat use. |
| MCP/Skills marketplace expands scope too early | Begin with open metadata and reviewed HTTP/x402 execution; defer runtime MCP and autonomous spending behind a deliberate policy gate. |

## Sources

- [SCF Build budget and deliverable guidelines](https://stellar.gitbook.io/scf-handbook/scf-awards/scf-build/budget-guidelines)
- [SCF Build submission review criteria](https://stellar.gitbook.io/scf-handbook/scf-awards/scf-build/submission-review-criteria)
- [Stellar Raven documentation](https://raven.stellar.org/docs) and [terms](https://raven.stellar.org/terms)
- [Stellar x402 documentation](https://developers.stellar.org/docs/build/agentic-payments/x402) and [quickstart](https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide)
- [Google for Startups Cloud Program](https://cloud.google.com/startup), [eligibility/benefits](https://cloud.google.com/startup/benefits), and [FAQ](https://cloud.google.com/startup/faq)
- [Founder Institute Agentic Program](https://fi.co/core)
- [Founder Institute post-program support](https://fi.co/scale)
- [Meridian 2026 event details](https://meridian.stellar.org/event-details)
- [Stellar 8004 public API](https://stellar8004.com/api/v1/agents?limit=100)
- [Stellar 8004 npm download endpoint](https://api.npmjs.org/downloads/point/2026-04-01:2026-09-02/%40trionlabs%2Fstellar8004) and [Nebula dependency](https://github.com/Caerlower/Nebula/blob/main/apps/nebula-hub/package.json)
- [SDF developer meeting notes, 2026-04-23](https://developers.stellar.org/meetings/2026/04/23)
- [Official MCP Registry record for Stellar Agent Search](https://registry.modelcontextprotocol.io/v0.1/servers?search=stellar-agent-search)
- [Stellar Skills directory](https://skills.stellar.org/llms.txt)
- [Stellar Agent Search npm download endpoint](https://api.npmjs.org/downloads/point/last-month/stellar-agent-search)
