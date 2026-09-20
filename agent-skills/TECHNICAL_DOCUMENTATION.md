# Algoria Agent Skills — Technical Documentation

Scope: the `agent-skills/` folder only. Everything described here is implemented
in `plugins/algoria`.

## Overall architecture

The folder ships one plugin, `plugins/algoria`, plus the harness that tests and
builds it (`tests/`, `build/`, `vitest.config.mjs`). The plugin is a set of six
skills (wallet, topup, discover, pay, mcp, memory). Each skill is a `SKILL.md`
telling the agent what to do, and one Node script that does it. The scripts are
thin: they parse flags and print JSON, while the real logic lives in shared
modules under `lib/` (`lib/stellar`, `lib/anchor`, `lib/services`).

There is no server and no daemon. Everything runs locally with Node 22 and
writes to `~/.algoria/` (wallet, deposits, job ledger, memory, locks). The same
code has two front doors: the agent runs a skill script directly, and a human
runs `npx algoria <group>`, which `bin/algoria.mjs` maps onto the same script.
The `@stellar/stellar-sdk` and x402 pieces are pre-bundled into `lib/vendor/`
so an installed plugin works without `pnpm install`.

## Main components and their responsibilities

- `lib/stellar/` — the wallet. `keystore.mjs` holds one wallet per network in
  `~/.algoria/wallet.json` (testnet seed in clear, pubnet seed AES-256-GCM under
  scrypt). `keypair.mjs` and `strkey.mjs` build Ed25519 keys and Stellar `G…`/`S…`
  addresses using only `node:crypto`. `horizon.mjs` reads balances and calls
  Friendbot; `trustline.mjs` signs and submits the USDC `changeTrust`.
- `lib/anchor/` — the TRY→USDC on-ramp. `sep10.mjs` logs in, `sep6.mjs` opens and
  polls deposits, `state.mjs` records them locally, `reconcile.mjs` matches local
  records against the anchor so a deposit is never opened twice.
- `lib/services/` — paid execution. `discovery.mjs` reads Algoria's catalog,
  `stellar8004.mjs` reads the on-chain agent registry, `policy.mjs` validates
  x402 offers and challenges, `client.mjs` / `external-client.mjs` run the
  quote → approve → pay → deliver flow, `state.mjs` keeps budgets and the job
  ledger, `mcp-client.mjs` calls MCP tools without any payment,
  `external-http.mjs` is the hardened outbound HTTP client.
- `lib/memory.mjs`, `lib/lock.mjs`, `lib/cli.mjs`, `lib/install.mjs` — local
  notes and job history, a cross-process directory lock, shared flag/passphrase/
  output helpers, and the `install --agent codex|claude` command.

## Stellar integrations and protocols used

The wallet is plain Stellar: Ed25519 keys in StrKey form, Horizon for account
balances, Friendbot for testnet XLM, and a `changeTrust` operation for the USDC
trustline (a Stellar account cannot hold USDC before that). Payments use x402 v2
with the `exact` scheme on `stellar:testnet`, paying the USDC Stellar Asset
Contract, with sponsored fees. The client only signs the challenge; it never
submits the payment transaction itself.

The on-ramp uses SEP-10 for authentication (the anchor's challenge is verified
against a pinned signing key, then signed locally), SEP-6 for the deposit and
its status, and SEP-12 only when the anchor asks for a KYC formality. Service
discovery for external agents reads the Stellar8004 registry contract on Soroban
testnet through a read-only `simulateTransaction`, so no key or transaction is
involved. MCP services are reached over Streamable HTTP JSON-RPC, with no x402
payment at all.

## Key design decisions and trade-offs

Keys stay on the user's machine and custody depends on the network: a testnet
seed is stored in the clear because testnet assets are worthless and a prompt
would block the agent, while a pubnet seed is always encrypted. Payment is split
into `quote` and `run --approve` against a named budget with a per-call cap, so
an agent can price a task freely but cannot spend without explicit approval.
Trade-off: more steps per task, and more local state to keep consistent.

Everything is pinned and re-validated rather than trusted: the Algoria API
origin, the anchor's host and signing key, the registry contract, and every
x402 offer's scheme, asset, amount and recipient. Registry metadata is treated
as untrusted data, so a service can describe itself but cannot redirect a
payment. StrKey and base32 are implemented in-house so a skill script runs with
no install step, at the cost of maintaining code the SDK already has; tests
cross-check it against the real SDK. The Stellar SDK and x402 pieces are
committed as bundles, which keeps installs working offline but requires a
rebuild step after upgrading a dependency.

## Technical challenges and how we solved them

The hardest problem is paying at most once. A job gets a UUID and a recovery
token written to the ledger before any request goes out, the intent to dispatch
is written before the network call, and a crash or timeout leaves the job in an
`uncertain` phase that refuses to sign again and keeps its budget reserved.
Recovery is by job ID: Algoria jobs can be re-read from the server, external
jobs only expose the locally saved response and are never retried. A
directory-based lock in `~/.algoria/locks` keeps two processes out of the same
job, and every state file is written to a temp file and renamed.

Calling arbitrary registered endpoints is the other risk. `external-http.mjs`
resolves DNS itself, rejects private and reserved IPv4 ranges, and pins the
resolved address for the connection; it allows only public HTTPS on port 443,
no redirects, no compression, no binary bodies, and bounded size and time. MCP
adds its own limits: bounded tool pagination, strict JSON-RPC envelope checks,
no server-initiated requests, and a bearer token that is only sent to an origin
the user bound explicitly. Payment authorizations are stripped from saved
output, and only a fixed set of receipt fields is kept.
