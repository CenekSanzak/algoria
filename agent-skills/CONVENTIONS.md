# Authoring an Algoria skill

Rules for anything added under `skills/`. They exist because these skills ship
to users who will point them at real money.

## Shape

Everything below is relative to the plugin root, `plugins/algoria/`.

**Nothing goes in the plugin root that does not ship to users.** Both hosts
install a plugin by copying its directory wholesale and neither reads
`.gitignore`, so a test file or a stray `node_modules` is shipped to every user
who installs it. The harness — `package.json`, `tests/`, `build/`,
`node_modules` — therefore lives one level up, at the marketplace root.

```
skills/<skill-name>/
  SKILL.md              required
  scripts/*.mjs         optional, executable
  references/*.md       optional, loaded on demand
```

The directory name, the `name:` in the frontmatter, and the way the skill is
referred to in prose all match. Lowercase, hyphenated.

## SKILL.md

Frontmatter carries `name` and `description`. The description is the only thing
the model sees before deciding whether to load the skill, so it names the
trigger, not the implementation:

```yaml
description: Create and manage a local Stellar wallet on this machine — ...
  Use when the user wants a Stellar wallet, an address to receive XLM or
  USDC, a funded testnet account, or a way to pay for Algoria services.
```

Those two keys are the whole budget. Claude accepts more and Codex accepts a
different more; `name` and `description` are the intersection, and a skill that
stays inside it installs into both hosts unchanged. Codex rejects a description
containing `<` or `>`, and caps it at 1024 characters.

The body is instructions for an agent that has already decided to act. Lead with
what must be true before anything runs, then the commands, then the guardrails.
Detail that is only occasionally needed goes in `references/` so it costs
nothing until it is wanted.

**Never write a command that assumes a working directory.** Claude exports
`CLAUDE_PLUGIN_ROOT`; Codex expects to be run from the plugin root and sets
nothing. Open the body by resolving one variable that covers both, then write
every command against it:

```bash
WALLET="${CLAUDE_PLUGIN_ROOT:-.}/skills/algoria-wallet/scripts/wallet.mjs"
```

## Scripts

- **Node 22+. Reach for a dependency only when the alternative is hand-rolling
  cryptography or wire formats.** Creating a key and reading a balance need
  nothing; signing a transaction needs the SDK. When a command does need one,
  import it lazily, so the commands that do not need it keep working.
- **A runtime dependency must be bundled, not installed.** A user who installed
  this plugin from a marketplace never ran `pnpm install`, so `node_modules` is
  not there. The Stellar SDK reaches runtime through `loadSdk()` in
  `lib/stellar/sdk.mjs`, which loads the committed bundle at
  `lib/vendor/stellar-sdk.mjs`. Needing a new symbol means adding it to
  `build/stellar-sdk-entry.mjs`, running `pnpm bundle:sdk`, and committing the
  result — a symbol that is not in the entry point does not exist at runtime.
  Verify by hiding `node_modules` and running the command.
- **Shared code lives in `lib/`**, imported by relative path. Two skills needing
  the same logic is the signal to move it there, not to copy it.
- `install` is the CLI bootstrap exception: it delegates to `lib/install.mjs`
  because it installs the plugin before skills are available. It has no wallet
  or payment side effects and needs no installed skill to run.
- **One entry point per skill**, with subcommands named for what they do — the
  whole surface then fits in one table in SKILL.md. Exactly one subcommand may
  reveal a secret, and it is named for that.
- **That entry point exports `main(argv)`** and keeps its
  `isMain(import.meta.url)` guard from `lib/cli.mjs`, so the file runs both
  directly (the agent's path) and through `bin/algoria.mjs` (the `npx` path).
  Never read `process.argv` anywhere but that guard: a script that reaches for it
  directly works in one channel and silently ignores the other's arguments.
- **A new skill needs a `GROUPS` entry in `bin/algoria.mjs`**, or it exists for
  agents and not for `npx` users. The dispatcher maps a name onto a `main()` and
  does nothing else — logic there is logic one channel has and the other lacks.
- **A message telling the user to retype a command goes through `commandName()`.**
  Hard-coding `wallet.mjs` makes the instruction wrong for `npx` users, and
  hard-coding `algoria wallet` makes it wrong for the agent.
- **A setup command that reaches a working state in one call.** `onboard` is the
  pattern: create, fund, and satisfy every precondition, then say plainly
  whether the result is ready to use.
- **`--json` on every script that produces a result**, so an agent can parse it
  instead of reading prose.
- **Exit non-zero with one clear line on stderr.** Use `run()` from `lib/cli.mjs`.

## Secrets

- A secret is never a command-line argument. Arguments show up in `ps`, in shell
  history, and in the conversation transcript. Accept them from a file, an
  environment variable, or a TTY prompt — `resolvePassphrase()` in `lib/cli.mjs`
  implements that order.
- Normal output contains no secret. A script that reveals one requires an
  explicit flag and says what the consequence is.
- Nothing written into a project directory, a commit, or a log may contain key
  material.

## Real money

- **The network is explicit.** `resolveNetwork()` has no default, deliberately.
  A skill that could touch pubnet asks rather than assumes.
- **Testnet is not funds.** Never describe a testnet balance as money.
- **Destructive or irreversible actions confirm first**, and say what cannot be
  undone. A lost passphrase is a lost wallet; users hear that before they choose
  one, not after.

## Tests

Every module in `lib/` has tests in the harness's `tests/`, at the marketplace
root, importing across into `plugins/algoria/lib/`. They are deliberately not
inside the plugin, because anything in there ships. Where a hand-rolled implementation
replaces a standard library — as `strkey.mjs` replaces `@stellar/stellar-sdk` —
the test cross-checks against that library, which stays a devDependency.

Tests never touch real user state. Redirect `ALGORIA_HOME` to a temp directory
before importing any module that reads it, and never call a network endpoint
that writes.

## Two hosts

The plugin ships one `skills/` tree and one `lib/`, described by two manifests:
`.claude-plugin/plugin.json` for Claude and `.codex-plugin/plugin.json` for
Codex. They are maintained side by side, not generated from each other, because
Codex validates its manifest against a strict schema — unknown fields are
rejected, and a full `interface` block plus strict semver is required.

Adding a skill means nothing more than a new `skills/<name>/`: both hosts
discover the directory, and neither manifest lists skills individually.

Before pushing a change to either manifest or any `SKILL.md`, run Codex's own
validators — they are stricter than Claude's and they ship with Codex:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/algoria
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  plugins/algoria/skills/<name>
```

Validation is necessary but not sufficient: it reads manifests, not behaviour.
Before shipping, install the plugin and run the skill from the *installed* copy,
which has no `node_modules` and no harness — that is what catches a file that
never shipped or a dependency that was never bundled. `README.md` has the
commands.

## Two channels

The same directory is the plugin and the published npm package. Hosts read the
manifests; npm reads `package.json`; neither sees the other's files. There is no
build step and no second copy of `lib/`, and it stays that way.

**`package.json` must declare no `dependencies`.** The Stellar SDK is bundled
into `lib/vendor/` so that an installed plugin needs no `npm install` and `npx
algoria` is a self-contained download. One dependency undoes both. A test enforces it.

Before publishing, check what npm would ship — `npm pack --dry-run` — and install
the tarball somewhere clean. `added 1 package` is the pass; more than that means
something crept in.

## Versioning

The version lives in **three** files and all three must agree: both manifests and
`package.json`. Bump them together when a skill's behaviour changes in a way a
user would notice. Codex requires strict semver, so that is the format for all
three. `tests/manifests.test.mjs` fails when they drift.
