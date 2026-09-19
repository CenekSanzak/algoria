# algoria

For every new paid task, **check the USDC wallet balance first**, before service
discovery, planning, quotes or payment attempts. If empty, provide the funding
link immediately, verify the deposit, then resume the original task within its
approved budget. The installed skills state this order in their entrypoints.

A personal context and execution layer above service discovery catalogs.
Algoria keeps the user's preferred services, project context, job history and
spending limits together, then uses discovery and x402 to get work done.
Stellar8004 and Bazaar are infrastructure to build on, not competing products
that Algoria needs to replace.

Today, executable integrations are Algoria's own x402 catalog and Stellar8004
testnet registrations exposing x402 or remote MCP tools. MCP does not require
USDC funding; its tools may target other chains, so the registration network
does not authorize cross-chain actions. Bazaar/other bookmarks work in memory;
live Bazaar discovery/payment adapters are not implemented yet. A saved endpoint
does not bypass supported-network, payment or provider checks.

Creates a wallet, funds it on testnet, adds the USDC trustline so it can hold
USDC, and tops it up with mock Turkish lira through a sandbox anchor. The secret
seed never leaves your computer. Discover Algoria services, pay within a named
testnet USDC budget over x402, and recover the result using its saved job ID.

No install, no API key, no account:

```bash
npx algoria wallet onboard --network testnet
```

That command creates the wallet, funds it from Friendbot, and adds the trustline.
Run it again and it reports what was already done.

For natural-language use in your coding agent, **version 0.5.1 and later** also
provide a one-command plugin installer:

```bash
npx algoria@latest install --agent codex
# Or:
npx algoria@latest install --agent claude
```

Run this in a normal terminal, from any directory, then open a new task/session.
Node 22+ and the chosen application with plugin support must already be installed.
The installer adds the GitHub marketplace and installs Algoria using the host's
own CLI. It can find Codex inside Codex.app/ChatGPT.app on macOS without PATH
setup. It does not create wallets or authorize spending.
On Codex, it also refreshes only the `algoria-skills` Git marketplace before
installing, so repeating the command picks up new plugin versions from the
selected branch instead of an older marketplace snapshot.

`--ref <branch-or-tag>` selects a GitHub version (default `main`), `--cli` accepts
an absolute host executable path, and `--dry-run` previews commands without
running them. `--json` emits a machine-readable summary. For example:

```bash
npx algoria@latest install --agent codex --ref codex/stellar8004-testnet-services
```

Before this version is published, `@latest` still downloads the previous npm
release. An unpacked checkout or a supplied `algoria-0.7.0.tgz` can exercise the
same installer: `npx --package=/absolute/path/algoria-0.7.0.tgz algoria install --agent codex --ref <branch>`.
If a host rejects an existing marketplace with a different source, the installer
reports its error and stops; it does not remove existing marketplaces or plugins.

## Commands

```bash
npx algoria memory recall --json
npx algoria memory remember --scope project:campaign --key style --value "Warm cinematic colours"
npx algoria memory save-service --source algoria --service image.generate
npx algoria memory forget --scope project:campaign --key style
npx algoria mcp tools stellar8004:25:0 --json
npx algoria mcp call stellar8004:25:0 --tool get_chain_status --input args.json --approve --json
npx algoria mcp status SAVED_CALL_ID --json
npx algoria wallet onboard --network testnet   # create + fund + trustline
npx algoria wallet balance --json              # USDC and XLM
npx algoria wallet accounts                    # every wallet on this machine
npx algoria topup start --try 200              # open a deposit, get bank details
npx algoria topup status --wait                # follow it until the USDC lands
npx algoria discover search image             # live service catalog
npx algoria discover show image.generate       # schema, price and recipient
npx algoria pay budget --name demo --total 0.03 --per-call 0.02
npx algoria pay quote image.generate --input input.json --budget demo --json
npx algoria pay run SAVED_JOB_ID --approve --json
npx algoria pay status SAVED_JOB_ID --wait --json
```

Memory is a private local JSON file at `~/.algoria/memory.json`, with atomic
writes and no new runtime dependencies. Existing `services.json` supplies safe
job history without copying payment secrets, raw prompts or signed media URLs.
Remembered preferences do not authorize payments. Scheduling is a separate host
capability, not something a memory note activates.

Successful media jobs expose `delivery` hints. The agent uses a verified host
preview, keeps the saved job ID for recovery, and refreshes expired Algoria media
URLs with `pay status`. A generated image and a working chat embed are different
outcomes; display failure must never trigger another paid generation.

`npx algoria` lists everything. `npx algoria wallet` lists just that group.

Every command takes `--json`, so it composes into scripts.

For the image example, `input.json` contains `{"prompt":"A small red sailboat"}`.
Use the ID returned by `quote` in `run` and `status`. The quote does not pay;
`--approve` authorizes execution within the named budget. Keep the same ID after
timeouts: uncertain payments retain their budget reservation and are never
automatically signed again. `pay list` finds saved jobs, and `pay budget --name
demo` shows remaining, spent and reserved test USDC. Other services' input
schemas come from `discover show`, including video workflows using prior results.

## Using it as an agent skill instead

This package is also a Claude and Codex plugin. Installed that way, your agent
gains the wallet as a skill and decides when to use it, rather than you typing
commands:

```bash
# Claude
/plugin marketplace add CenekSanzak/algoria
/plugin install algoria@algoria-skills

# Codex
codex plugin marketplace add CenekSanzak/algoria
codex plugin add algoria@algoria-skills
```

Then ask naturally: *"Bana ürünüm için seslendirmeli bir reklam videosu üret"*
or *"Generate an image for my product"*. The agent discovers matching services,
builds the necessary workflow, prepares the wallet, pays within your approved
budget, and returns the media. You do not type `algoria pay` or know service IDs.
Without an existing spending authorization, it first shows the plan's total
test USDC cost; a previously approved budget covers its included steps.

This requires the updated plugin to be installed and enabled in the host.
Its skills support automatic selection, but selection is made by the host's
agent. The current catalog supports images, speech and slideshow-based video
workflows; it cannot perform every arbitrary task.

You can also ask for an external service from **Stellar8004 testnet**. The agent
reads on-chain registrations, checks an unsigned x402 quote, then uses the same
wallet and approved budget. Algoria stays the default catalog. CLI equivalents:

```bash
algoria discover search render --source stellar8004 --json
algoria discover show stellar8004:0:0 --json
algoria pay quote stellar8004:0:0 --method GET --input render.json --budget project --json
```

The example RenderGate input is `{"url":"https://stellar.org"}`; inspect current
metadata before using it. Public HTTPS x402 accepts sponsored testnet USDC.
Entries with `transport: mcp` use `algoria mcp tools` and `algoria mcp call`;
these do not quote, sign or charge through x402. Discovery pagination scans
agent IDs; follow `nextOffset` even if a search page is empty.

MCP supports public HTTPS Streamable HTTP (JSON/POST SSE), current tool schemas,
and local call history. Legacy session-based versions negotiate from 2025-11-25;
stateless 2026-07-28 basic tool list/call is selectable with `--protocol`.
Interactive input rounds and parameter-mirrored headers in that newer revision
are not implemented. Old standalone SSE endpoints, stdio, A2A and IPv6-only
hosts are not supported. HTTP 401/403 or 402 never triggers an automatic payment.
Provider bearer access can be supplied via `--token-file` plus the matching
`--auth-origin`; OAuth/SIWE login is not automated and tokens are never persisted.

The A-Identity example's `args.json` is `{}`. Read-only calls already authorized
by the task need no additional user prompt; `--approve` represents that scope.
MCP may also expose purchases, escrow and policy changes; those need their own
applicable authorization. Lost call responses are retained as uncertain and
never automatically dispatched twice. `status` is local-only, not remote recovery.

To update later:

```bash
# Claude (restart Claude Code afterwards)
claude plugin marketplace update algoria-skills
claude plugin update algoria@algoria-skills

# Codex
codex plugin marketplace upgrade algoria-skills
codex plugin add algoria@algoria-skills
```

## Things worth knowing

- **`testnet` is the default, and testnet balances are not money.** Real funds
  need `--network pubnet`, typed deliberately.
- **A funded Stellar account still cannot hold USDC** until it has a trustline.
  `onboard` handles that. `usdc: null` means the trustline is missing, which is
  not the same as a zero balance.
- **Testnet seeds are stored unencrypted**, in `~/.algoria/wallet.json`. A
  passphrase there protects nothing and blocks automation. **Pubnet seeds are
  always encrypted** (AES-256-GCM, scrypt), and the passphrase is never accepted
  as a command-line argument.
- **A lost passphrase is a lost wallet.** There is no recovery path — nothing is
  held anywhere that could restore one.
- **`--try 200` is 200 mock lira, not 200 USDC** (roughly 4 USDC). The top-up
  anchor is a sandbox: no real bank, no real lira, no mainnet.
- The top-up skill never simulates your bank transfer. `pay run --approve`
  authorizes a service payment locally; the backend settles it through x402.
- Payment services currently support testnet only. Signed authorizations and
  recovery tokens stay in `~/.algoria/services.json` with mode 0600. Keep that
  file for recovery; for Algoria jobs, use `pay status` to refresh an expired media URL.
- Stellar8004 service results and receipts are saved locally. Their `pay status`
  does not poll a server or refresh links. An uncertain payment/result must be
  reconciled with the provider; it is never automatically paid again.

## Requirements

Node 22 or newer. No runtime npm dependencies — Stellar, x402 and schema
validation code are bundled. Wallet key operations work offline; discovery,
funding, payment signing through RPC, execution and result recovery need network access.

MIT licensed. Part of [Algoria](https://algoria-agent-economy.berkingurcan.chatgpt.site/).
