# Algoria Agent Skills

The skill half of Algoria. These are shipped to users, not developer tooling:
an Algoria user installs this plugin into Claude or Codex, and their agent gains
the ability to hold a Stellar wallet, pay for services over x402, and work
inside the agent economy without leaving the conversation.

This directory is self-contained. It has its own dependencies, its own tests and
its own version, and it does not import from the application at the repository
root.

## Layout

`agent-skills/` is a **marketplace** holding one **plugin**. Both hosts read the
same `skills/` and `lib/`; only the manifest that describes them differs.

```
algoria-x/                          the repository, and the marketplace root
  .claude-plugin/marketplace.json   Claude's catalogue  ->  agent-skills/plugins/algoria
  .agents/plugins/marketplace.json  Codex's catalogue   ->  agent-skills/plugins/algoria
agent-skills/                       this directory: the dev harness
  package.json  tsconfig.json       harness: test, typecheck, bundle
  vitest.config.mjs
  tests/                            vitest, run against the plugin's lib/
  build/                            the SDK bundle's entry point
  plugins/algoria/                  the plugin — nothing here that does not ship
    .claude-plugin/plugin.json      Claude manifest
    .codex-plugin/plugin.json       Codex manifest (stricter: needs `interface`)
    skills/<name>/
      SKILL.md                      what the model reads
      scripts/                      executables the skill runs
      references/                   detail loaded only when needed
    lib/stellar/                    keys, keystore, Horizon, trustlines
    lib/anchor/                     the TR mock anchor: SEP-10, SEP-6, records
    lib/vendor/                     the committed Stellar SDK bundle
    bin/algoria.mjs                 the `npx algoria` entry point
    package.json                    the published npm package
    assets/                         plugin icon
```

The marketplace manifests sit at the repository root because both hosts require
the manifest at the root of whatever source they are given. Nested one level
down, `codex plugin marketplace add <repo>` fails with *marketplace root does
not contain a supported manifest*, which rules out installing from git.

**Everything inside `plugins/algoria/` ships; everything outside it does not.**
Both hosts install a plugin by copying its directory wholesale, and neither
consults `.gitignore` — with the harness and `node_modules` still inside, a Codex
install measured 104MB. Hoisted out, the same install is 444KB. So `package.json`,
`tests/`, `build/` and `node_modules` live at the marketplace root, and the tests
reach into `plugins/algoria/lib/` from there.

Skill scripts import shared code from `lib/`, which sits outside the skill
directory, so install the plugin as a unit rather than copying one
`skills/<name>/` folder on its own.

## Install

Two channels. The plugin is for agents; npm is for people.

**As an agent skill.** Both hosts read a marketplace manifest from the
**repository root**, so the source is the repo, not this directory:

```bash
# Claude
/plugin marketplace add berkingurcan/algoria-x
/plugin install algoria@algoria-skills

# Codex
codex plugin marketplace add berkingurcan/algoria-x
codex plugin add algoria@algoria-skills
```

Use `.` instead of `berkingurcan/algoria-x` to install from a local checkout.
`codex plugin list` shows what is installed, and
`codex plugin remove algoria@algoria-skills` undoes it. If the `codex` CLI is not
on your PATH, the ChatGPT desktop app ships one at
`/Applications/ChatGPT.app/Contents/Resources/codex`.

**As a CLI**, for a human or a script, with nothing installed:

```bash
npx algoria wallet onboard --network testnet
npx algoria topup start --try 200
```

Same code either way — see [Two channels](#two-channels-one-source) below.

## Skills

| Skill | What it does |
| --- | --- |
| [`algoria-wallet`](plugins/algoria/skills/algoria-wallet/SKILL.md) | A Stellar wallet on the user's own machine. `onboard` creates it, funds it on testnet, and adds the USDC trustline in one command; `balance`, `accounts`, `fund`, `trustline`, `import`, `export`, `forget` cover the rest. |
| [`algoria-topup`](plugins/algoria/skills/algoria-topup/SKILL.md) | Mock Turkish lira into testnet USDC, through the TR mock anchor over SEP-6. `start` opens a deposit and hands the user an IBAN, an amount and a reference; the user pays; `status --wait` confirms the USDC landed. |

The command surface is modelled on AgentCash's wallet flow — auto-created wallet,
one entry point with subcommands, `--json` everywhere — adapted to Stellar. See
[agentcash-parity.md](plugins/algoria/skills/algoria-wallet/references/agentcash-parity.md)
for what maps onto what and which of their choices were deliberately not copied.

## Two channels, one source

`plugins/algoria/` is simultaneously the plugin and the published npm package.
Hosts read the manifests and ignore `package.json`; npm reads `package.json` and
ignores the manifests. Nothing is generated, and there is no second copy of
`lib/` that could drift from the first.

This works only because the SDK is bundled: the package declares **no
dependencies**, so `npx algoria` is a 111KB download with nothing behind it. A
test asserts that `dependencies` stays absent, because adding one would quietly
undo it.

Each skill's script exports `main(argv)` and keeps a
`import.meta.url === file://${process.argv[1]}` guard, so the same file runs both
as `node skills/…/wallet.mjs onboard` (how the agent calls it) and through
`bin/algoria.mjs` (how `npx` calls it). `bin/algoria.mjs` is a dispatcher only —
if a flag ever works in one channel and not the other, that file has grown
behaviour it should not have.

One wrinkle worth knowing: messages that tell a user to retype a command go
through `commandName()`, which reads `ALGORIA_INVOKED_AS`. The dispatcher sets
it. Inferring the channel from `process.argv[1]` instead looks equivalent and is
not — npm installs a bin as `node_modules/.bin/algoria`, with no extension, so a
filename check misses every npx user.

## Two hosts, one plugin

The skills themselves are portable with no changes: their frontmatter uses only
`name` and `description`, which is the intersection of what both hosts accept.
Three things did need care.

**The manifests are not interchangeable.** Codex validates `.codex-plugin/plugin.json`
against a strict schema — it rejects unknown fields and requires a full
`interface` block (`displayName`, `shortDescription`, `longDescription`,
`developerName`, `category`, `capabilities`, `defaultPrompt`) plus strict semver.
Claude requires none of that. So the two manifests are maintained side by side
rather than generated from one another, and the version is bumped in both.

**Script paths cannot rely on the working directory.** Claude exports
`CLAUDE_PLUGIN_ROOT`; Codex's convention is to run from the plugin root. Every
`SKILL.md` therefore opens by resolving one variable that covers both:

```bash
WALLET="${CLAUDE_PLUGIN_ROOT:-.}/skills/algoria-wallet/scripts/wallet.mjs"
```

**An installed plugin has no `node_modules`.** Which is what the next section is
about.

## Dependencies, and why there is almost none

Wallet creation, balance reads, funding and seed export run on Node 22+ with
nothing installed. Stellar's StrKey encoding and ed25519 derivation are
implemented in `lib/stellar/` on top of `node:crypto` rather than imported, and
`tests/strkey.test.mjs` cross-checks every encode, decode and derivation path
against `@stellar/stellar-sdk` so the hand-rolled version cannot drift.

Two things do need real XDR: `lib/stellar/trustline.mjs` signs and submits a
`changeTrust` transaction, and `lib/anchor/sep10.mjs` verifies and signs the
anchor's SEP-10 challenge. Between them that covers `onboard` and every top-up
command — most of what the plugin is for.

Nobody runs `pnpm install` in a plugin they installed from a marketplace, so the
SDK cannot be a runtime dependency. Instead `build/stellar-sdk-entry.mjs` names
the eight symbols the package actually uses and `pnpm bundle:sdk` compiles them
into `lib/vendor/stellar-sdk.mjs` — 302KB, committed, versus 28MB for the
installed package. `loadSdk()` in `lib/stellar/sdk.mjs` prefers that bundle and
falls back to a real `@stellar/stellar-sdk` when one is present, so a
development checkout works either way.

Rebuild and commit the bundle when the SDK version changes or a new symbol is
needed; a symbol not listed in the entry point does not exist at runtime.

## Development

Everything below runs in `agent-skills/`, the marketplace root — not in the
plugin directory.

```bash
pnpm install --ignore-workspace   # this package is not in the root workspace
pnpm test
pnpm check                        # tsc --noEmit over JSDoc-typed .mjs
pnpm bundle:sdk                   # regenerate the plugin's lib/vendor/ bundle
```

`--ignore-workspace` keeps this package out of the root app's dependency graph,
so the two can be installed, tested and released independently.

Running the tests never touches a real wallet: `ALGORIA_HOME` is redirected to a
temp directory before the keystore module is imported. The same variable is the
way to exercise the scripts by hand without touching `~/.algoria`.

To check the plugin the way Codex will, run its own validators — they ship with
Codex and need `pyyaml`:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/algoria
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/algoria/skills/algoria-wallet
```

To check the whole install path the way a user will get it, install it and run a
command from the installed copy rather than from the checkout:

```bash
codex plugin marketplace add .            # from the repository root
codex plugin add algoria@algoria-skills
cd ~/.codex/plugins/cache/algoria-skills/algoria/<version>
ALGORIA_HOME=$(mktemp -d) node skills/algoria-wallet/scripts/wallet.mjs onboard \
  --network testnet --json
```

That is the test that catches a missing file or an unbundled dependency, because
the installed copy has no `node_modules` and no harness. Use a throwaway
`ALGORIA_HOME` so it cannot touch a real wallet.

One cosmetic note — esbuild warns that it cannot find the root app's
`.svelte-kit/tsconfig.json` while loading the Vitest config. It is reading the
repository root's tsconfig on the way past; nothing in this package depends on
it, and the warning disappears once the root app has been built.

## Security posture

- A secret seed never leaves the user's machine, and no command prints one
  unless the user asks for it in that turn.
- A passphrase is never accepted as a command-line argument.
- A pubnet wallet is always encrypted; a testnet wallet is deliberately not,
  because a passphrase there protects nothing and blocks the agent.
- `testnet` is the default. Real money requires typing `--network pubnet`.
- The anchor is a sandbox and testnet-only, and its host, signing key and USDC
  issuer are pinned. If any of them moves, the top-up stops instead of signing.
- A top-up is never simulated for the user. Sending the money is their step.

See [keystore.md](plugins/algoria/skills/algoria-wallet/references/keystore.md)
for the on-disk format and threat model, [CONVENTIONS.md](CONVENTIONS.md) for
the rules every skill in this package follows, and [TEST_GUIDE.md](TEST_GUIDE.md)
for how to check all of it by hand before a demo.
