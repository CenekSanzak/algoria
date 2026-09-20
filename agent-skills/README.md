# Algoria Agent Skills

**Buy AI services that go beyond the limits of Claude and Codex — right inside
Claude or Codex.**

This folder holds the part of Algoria that users install. A user adds this
plugin to Claude Code or Codex, and their agent can then hold a Stellar wallet,
buy a service with USDC, and bring the result back into the conversation.

## What problem this solves

People want more from their agent than one model can do: image and video
generation, phone calls, paid MCP tools, paid APIs. Today that means creating
accounts, copying API keys, adding credit cards and, for crypto services,
managing a wallet. Most people stop there.

Service builders have the opposite problem. They have something useful, but no
easy way to reach users.

Algoria connects the two sides through one connection. The user pays in Turkish
lira through a Stellar anchor. They never touch an API key, a seed phrase or a
crypto exchange. Everything runs inside the chat they were already in.

Everything today runs on Stellar **testnet**. The lira are mock lira and the
USDC has no value.

## Links

- Landing page: https://algoria-x.vercel.app/
- Live demo: https://algoria-x.vercel.app/how-to-use
- npm package: https://www.npmjs.com/package/algoria
- Technical documentation: [TECHNICAL_DOCUMENTATION.md](TECHNICAL_DOCUMENTATION.md)

## The six skills

| Skill | What it does |
| --- | --- |
| [`algoria-wallet`](plugins/algoria/skills/algoria-wallet/SKILL.md) | A Stellar wallet on the user's own machine. `onboard` creates it, funds it on testnet and adds the USDC trustline in one command. `balance`, `accounts`, `fund`, `trustline`, `import`, `export` and `forget` cover the rest. |
| [`algoria-topup`](plugins/algoria/skills/algoria-topup/SKILL.md) | Mock Turkish lira in, testnet USDC out, through the TR mock anchor over SEP-6. `start` opens a deposit and gives the user an IBAN, an amount and a reference. The user pays. `status --wait` confirms the USDC arrived. |
| [`algoria-discover`](plugins/algoria/skills/algoria-discover/SKILL.md) | Find services and read their real prices, schemas and payment recipients. Searches the Algoria catalog, and the Stellar8004 registry with `--source stellar8004`. |
| [`algoria-pay`](plugins/algoria/skills/algoria-pay/SKILL.md) | Quote a service, pay for it with x402 inside a named budget, and get the result back. Also recovers a job after a crash or a timeout. |
| [`algoria-mcp`](plugins/algoria/skills/algoria-mcp/SKILL.md) | Call MCP tools from agents in the Stellar8004 registry. This path never signs a payment, so an empty wallet does not block it. |
| [`algoria-memory`](plugins/algoria/skills/algoria-memory/SKILL.md) | Remember preferences, project notes and saved services between sessions, plus a safe view of past jobs. Stored locally, and never a permission to spend. |

The wallet commands follow AgentCash's shape — a wallet created on first use,
one entry point with subcommands, `--json` everywhere — moved over to Stellar.
[agentcash-parity.md](plugins/algoria/skills/algoria-wallet/references/agentcash-parity.md)
says what maps onto what, and what was left out on purpose.

## Install

There are two ways in. The plugin is for agents. npm is for people.

**As an agent plugin.** Both hosts read the marketplace manifest from the
**repository root**, so the source is the repo, not this folder:

```bash
# Claude
/plugin marketplace add CenekSanzak/algoria
/plugin install algoria@algoria-skills

# Codex
codex plugin marketplace add CenekSanzak/algoria
codex plugin add algoria@algoria-skills
```

Use `.` instead of `CenekSanzak/algoria` to install from a local checkout.
`codex plugin list` shows what is installed and
`codex plugin remove algoria@algoria-skills` removes it. If `codex` is not on
your PATH, the ChatGPT desktop app ships one at
`/Applications/ChatGPT.app/Contents/Resources/codex`.

**As a CLI**, for a person or a script, with nothing installed first:

```bash
npx algoria wallet onboard --network testnet
npx algoria topup start --try 200
```

The CLI can also install the plugin for you:

```bash
npx algoria@latest install --agent codex
npx algoria@latest install --agent claude
```

This calls the host's own plugin commands with the GitHub source, so the user
needs no checkout. `--ref` picks a branch or tag (default `main`),
`--cli /absolute/path` picks a host binary, and `--dry-run --json` shows the
commands without running them. On macOS, Codex's app-bundled CLI is found even
when it is missing from PATH. Installing does not create a wallet, and it does
not approve any payment. Open a new task or session afterwards so the skills
load.

To try a change before it is published, pack `plugins/algoria` and run
`npx --package=/absolute/path/algoria-0.8.3.tgz algoria install --agent codex --ref <branch>`.

## How a paid job works

```bash
node plugins/algoria/bin/algoria.mjs discover search image
node plugins/algoria/bin/algoria.mjs discover show image.generate --json
node plugins/algoria/bin/algoria.mjs pay budget --name demo --total 0.03 --per-call 0.02
node plugins/algoria/bin/algoria.mjs pay quote image.generate --input input.json --budget demo --json
node plugins/algoria/bin/algoria.mjs pay run SAVED_JOB_ID --approve --json
node plugins/algoria/bin/algoria.mjs pay status SAVED_JOB_ID --wait --json
```

A working image input is `{"prompt":"A small red sailboat"}`. Budgets are written
in decimal test USDC and counted in whole atomic units. Only set the limits the
user actually approved.

The order matters. `quote` saves the job and its exact input before it sends
anything, so an interrupted job can always be found again by its ID. `run`
reserves the money in the budget before it signs. A payment that times out is
recovered by reading that saved job, never by making a new one. A job that was
already paid is finished with an unsigned request. `status` also refreshes
expired media links without charging again.

`services.json` keeps recovery tokens and signatures with `0600` permissions,
while `pay list` and `pay status` print only public fields. File locks keep two
commands out of the same job or budget. A lock left behind by a crash is only
cleared after checking that its process is really gone.

### Stellar8004 services

The default catalog is Algoria's. `--source stellar8004` reads services straight
from the Stellar8004 registry contract on testnet. Both sources share the same
wallet and the same budgets.

```bash
node plugins/algoria/bin/algoria.mjs discover search render --source stellar8004 --json
node plugins/algoria/bin/algoria.mjs discover show stellar8004:0:0 --json
node plugins/algoria/bin/algoria.mjs pay quote stellar8004:0:0 --method GET --input render.json --budget demo --json
```

An ID names an agent and the position of one of its services. If the metadata
does not give a method, pass `--method`. GET input becomes query parameters and
POST input becomes a JSON body. Listing pages walk agent IDs, so follow
`pagination.nextOffset` even when a page has no matches; agents whose metadata
cannot be read appear under `unavailable`.

Being listed in the registry proves nothing on its own, so `quote` sends an
unsigned request and checks the offer that actually comes back. Only sponsored
exact testnet USDC offers on public HTTPS endpoints are accepted. Private
addresses, redirects, compressed or binary replies and oversized bodies are
refused, and the resolved public IPv4 address is pinned for the connection.
IPv6-only providers are not supported yet.

An external job is paid at most once. Its `status` shows only the reply that was
saved locally — there is no remote polling, no media refresh and no automatic
retry. A lost reply, a bad receipt or an async `202` has to be sorted out with
the provider. Algoria's own jobs keep their full recovery path. See
[external-services.md](plugins/algoria/skills/algoria-pay/references/external-services.md).

### MCP tools

Some registered agents expose MCP tools instead of a paid HTTP endpoint. Those
go through `algoria mcp`, over Streamable HTTP:

```bash
node plugins/algoria/bin/algoria.mjs mcp tools stellar8004:25:0 --json
node plugins/algoria/bin/algoria.mjs mcp call stellar8004:25:0 --tool get_chain_status --input args.json --approve --json
node plugins/algoria/bin/algoria.mjs mcp status SAVED_CALL_ID --json
```

This client never signs an x402 payment and never charges the wallet, so MCP
alone needs no USDC. If a provider answers `401`, `403` or `402`, the call stops
and says so. A tool can still change something on the provider's side, so a call
is saved before it is sent and is never repeated on its own.

### Top-ups

`topup start` first checks the anchor for deposits this wallet already has, and
refreshes them, before opening a new one. If a deposit is still pending it stops
instead of opening a second one, unless the user asks for `--new`. That is what
keeps a user from being billed twice.

## Layout

`agent-skills/` is a **marketplace** holding one **plugin**. Both hosts read the
same `skills/` and `lib/`. Only the manifest that describes them differs.

```
algoria-x/                          the repository, and the marketplace root
  .claude-plugin/marketplace.json   Claude's catalogue  ->  agent-skills/plugins/algoria
  .agents/plugins/marketplace.json  Codex's catalogue   ->  agent-skills/plugins/algoria
agent-skills/                       this directory: the dev harness
  package.json  tsconfig.json       harness: test, typecheck, bundle
  vitest.config.mjs
  tests/                            vitest, run against the plugin's lib/
  build/                            entry points for the two runtime bundles
  plugins/algoria/                  the plugin — nothing here that does not ship
    .claude-plugin/plugin.json      Claude manifest
    .codex-plugin/plugin.json       Codex manifest (stricter: needs `interface`)
    skills/<name>/
      SKILL.md                      what the model reads
      scripts/                      executables the skill runs
      references/                   detail loaded only when needed
    lib/stellar/                    keys, keystore, Horizon, trustlines
    lib/anchor/                     the TR mock anchor: SEP-10, SEP-6, records
    lib/services/                   discovery, x402 payment, MCP, jobs, budgets
    lib/memory.mjs lib/lock.mjs     local notes, and the cross-process lock
    lib/cli.mjs lib/install.mjs     shared flag handling, and `algoria install`
    lib/vendor/                     the two committed SDK bundles
    bin/algoria.mjs                 the `npx algoria` entry point
    package.json                    the published npm package
    assets/                         plugin icon
```

The marketplace manifests sit at the repository root because both hosts want the
manifest at the root of whatever source they are given. One level down,
`codex plugin marketplace add <repo>` fails with *marketplace root does not
contain a supported manifest*, which would rule out installing from git.

**Everything inside `plugins/algoria/` ships. Everything outside it does not.**
Both hosts install a plugin by copying its folder whole, and neither reads
`.gitignore` — with the harness and `node_modules` still inside, one Codex
install came to 104MB. So `package.json`, `tests/`, `build/` and `node_modules`
stay at the marketplace root, and the tests reach down into
`plugins/algoria/lib/` from there.

Skill scripts import shared code from `lib/`, which sits outside the skill
folder. Install the plugin as a whole; do not copy one `skills/<name>/` folder
on its own.

## Two channels, one source

`plugins/algoria/` is the plugin and the npm package at the same time. The hosts
read the manifests and ignore `package.json`. npm reads `package.json` and
ignores the manifests. Nothing is generated, and there is no second copy of
`lib/` that could drift.

This only works because the SDKs are bundled: the package declares **no
dependencies**, so `npx algoria` downloads one self-contained thing. A test
checks that `dependencies` stays empty, because adding one would quietly break
it.

Every skill script exports `main(argv)` and keeps the `isMain(import.meta.url)`
guard from `lib/cli.mjs`. The same file therefore runs as
`node skills/…/wallet.mjs onboard`, which is how the agent calls it, and through
`bin/algoria.mjs`, which is how `npx` calls it. `bin/algoria.mjs` only
dispatches. If a flag ever works in one channel but not the other, that file has
grown behaviour it should not have.

One detail worth knowing: a message that tells the user to retype a command goes
through `commandName()`, which reads `ALGORIA_INVOKED_AS`. The dispatcher sets
it. Working the channel out from `process.argv[1]` looks the same and is not —
npm installs a bin as `node_modules/.bin/algoria`, with no extension, so a
filename check misses every npx user.

## Two hosts, one plugin

The skills themselves need no changes between hosts. Their frontmatter uses only
`name` and `description`, which is what both hosts accept. Three things did need
care.

**The manifests are not interchangeable.** Codex checks
`.codex-plugin/plugin.json` against a strict schema. It rejects unknown fields
and wants a full `interface` block (`displayName`, `shortDescription`,
`longDescription`, `developerName`, `category`, `capabilities`, `defaultPrompt`)
and strict semver. Claude wants none of that. So the two manifests are kept side
by side instead of generated from each other, and the version is bumped in both.

**Script paths cannot depend on the working directory.** Claude sets
`CLAUDE_PLUGIN_ROOT`. Codex runs from the plugin root. So every `SKILL.md` starts
by resolving one variable that covers both:

```bash
WALLET="${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/skills/algoria-wallet/scripts/wallet.mjs"
```

**An installed plugin has no `node_modules`.** Which is what the next section is
about.

## Dependencies, and why there are almost none

Creating a wallet, reading a balance, funding an account and exporting a seed all
run on Node 22+ with nothing installed. Stellar's StrKey encoding and ed25519
derivation are written out in `lib/stellar/` on top of `node:crypto` instead of
imported, and `tests/strkey.test.mjs` checks every encode, decode and derivation
against `@stellar/stellar-sdk` so the hand-written version cannot drift.

Two places do need real XDR: `lib/stellar/trustline.mjs` signs and submits the
`changeTrust` transaction, and `lib/anchor/sep10.mjs` verifies and signs the
anchor's challenge. Between them that covers `onboard` and every top-up command.

Nobody runs `pnpm install` inside a plugin they installed from a marketplace, so
the SDK cannot be a runtime dependency. Instead `build/stellar-sdk-entry.mjs`
names the eight symbols the package really uses, and `pnpm bundle:sdk` compiles
them into `lib/vendor/stellar-sdk.mjs` — about 300KB, committed, against 28MB
for the installed package. `loadSdk()` in `lib/stellar/sdk.mjs` prefers that
bundle and falls back to a real `@stellar/stellar-sdk` when one is there, so a
development checkout works either way.

Rebuild and commit the bundle when the SDK version changes or a new symbol is
needed. A symbol that is not in the entry point does not exist at runtime.

The payment side pins `@x402/core` and `@x402/stellar` 2.22.0 and the same
Stellar SDK 16.2.0 as the platform. `build/services-sdk-entry.mjs` bundles local
signing, the header codecs, the read-only registry call and JSON Schema
validation into a second bundle, about 590KB. Neither the installed plugin nor
the npm package needs `node_modules`.

## Development

Everything below runs in `agent-skills/`, the marketplace root — not in the
plugin folder. Use pnpm 10.30.3, pinned in this folder's `package.json`; the
standalone lockfile is in pnpm's version 9 format. Both PR CI and the npm release
read that pin.

```bash
pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm test
pnpm check                        # tsc --noEmit over JSDoc-typed .mjs
pnpm bundle:sdk                   # wallet and SEP-10 bundle
pnpm bundle:services              # x402 signing, registry reads, schema validation
```

`--ignore-workspace` keeps this package out of the root app's dependency graph,
so the two are installed, tested and released on their own.

The tests never touch a real wallet: `ALGORIA_HOME` is pointed at a temp folder
before the keystore module is imported. Use the same variable to try the scripts
by hand without touching `~/.algoria`.

To check the plugin the way Codex will, run its own validators. They ship with
Codex and need `pyyaml`:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/algoria
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/algoria/skills/algoria-wallet
```

To check the whole install path the way a user gets it, install the plugin and
run a command from the installed copy, not from the checkout:

```bash
codex plugin marketplace add .            # from the repository root
codex plugin add algoria@algoria-skills
cd ~/.codex/plugins/cache/algoria-skills/algoria/<version>
ALGORIA_HOME=$(mktemp -d) node skills/algoria-wallet/scripts/wallet.mjs onboard \
  --network testnet --json
```

That is the test that catches a missing file or a dependency that was never
bundled, because the installed copy has no `node_modules` and no harness. Use a
throwaway `ALGORIA_HOME` so it cannot touch a real wallet.

One cosmetic note: esbuild warns that it cannot find the root app's
`.svelte-kit/tsconfig.json` while loading the Vitest config. It reads the
repository root's tsconfig on the way past. Nothing here depends on it, and the
warning goes away once the root app has been built.

## Releasing

Bump `version` in `plugins/algoria/package.json`, `.claude-plugin/plugin.json`
and `.codex-plugin/plugin.json`, then merge to `main`. That is the release. A
test fails if the three disagree.

- **npm:** [`publish-npm.yml`](../.github/workflows/publish-npm.yml) runs the
  type check, the tests and a check that the committed bundles still match the
  lockfile, then publishes if npm does not have that version yet. A push with no
  bump is checked and skipped. No token is stored — npm trusts that workflow
  file directly, and every release carries a provenance attestation.
- **Plugins:** both hosts install from GitHub, so merging is the release. Both
  decide "is there an update?" by comparing `version`, so a change merged
  without a bump never reaches anyone who already has the plugin.

Users update with the hosts' own commands. The plugin has none of its own:

```bash
# Claude (restart Claude Code afterwards)
claude plugin marketplace update algoria-skills
claude plugin update algoria@algoria-skills

# Codex (it also upgrades Git marketplaces on its own)
codex plugin marketplace upgrade algoria-skills
```

`npx algoria` needs nothing: it fetches the newest version each time.

## Security

- A secret seed never leaves the user's machine, and no command prints one
  unless the user asks for it in that turn.
- A passphrase is never accepted as a command-line argument.
- A pubnet wallet is always encrypted. A testnet wallet is deliberately not,
  because a passphrase there protects nothing and only blocks the agent.
- `testnet` is the default. Real money needs `--network pubnet`, typed out.
- The anchor is a sandbox and testnet-only. Its host, signing key and USDC
  issuer are pinned, and the top-up stops instead of signing if any of them
  moves.
- A top-up is never simulated for the user. Sending the money is their step.
- Service metadata, tool descriptions and results are treated as data, never as
  instructions, and they can never change where a payment goes.

## More documentation

- [TECHNICAL_DOCUMENTATION.md](TECHNICAL_DOCUMENTATION.md) — architecture,
  components, Stellar protocols, design decisions and the hard problems.
- [CONVENTIONS.md](CONVENTIONS.md) — the rules every skill here follows.
- [TEST_GUIDE.md](TEST_GUIDE.md) — how to check all of it by hand before a demo.
- [keystore.md](plugins/algoria/skills/algoria-wallet/references/keystore.md) —
  the on-disk wallet format and its threat model.
