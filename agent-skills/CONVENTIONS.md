# Authoring an Algoria skill

Rules for anything added under `skills/`. They exist because these skills ship
to users who will point them at real money.

## Shape

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

The body is instructions for an agent that has already decided to act. Lead with
what must be true before anything runs, then the commands, then the guardrails.
Detail that is only occasionally needed goes in `references/` so it costs
nothing until it is wanted.

## Scripts

- **Node 22+. Reach for a dependency only when the alternative is hand-rolling
  cryptography or wire formats.** Creating a key and reading a balance need
  nothing; signing a transaction needs the SDK. When a command does need one,
  import it lazily and fail with a message naming the fix, so the commands that
  do not need it keep working uninstalled.
- **Shared code lives in `lib/`**, imported by relative path. Two skills needing
  the same logic is the signal to move it there, not to copy it.
- **One entry point per skill**, with subcommands named for what they do — the
  whole surface then fits in one table in SKILL.md. Exactly one subcommand may
  reveal a secret, and it is named for that.
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

Every module in `lib/` has tests in `tests/`. Where a hand-rolled implementation
replaces a standard library — as `strkey.mjs` replaces `@stellar/stellar-sdk` —
the test cross-checks against that library, which stays a devDependency.

Tests never touch real user state. Redirect `ALGORIA_HOME` to a temp directory
before importing any module that reads it, and never call a network endpoint
that writes.

## Versioning

`.claude-plugin/plugin.json` carries the version for the whole package. Bump it
when a skill's behaviour changes in a way a user would notice.
