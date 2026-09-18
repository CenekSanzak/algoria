# Algoria Agent Skills

The skill half of Algoria. These are shipped to users, not developer tooling:
an Algoria user installs this plugin into Claude or Codex, and their agent gains
the ability to hold a Stellar wallet, pay for services over x402, and work
inside the agent economy without leaving the conversation.

This directory is self-contained. It has its own dependencies, its own tests and
its own version, and it does not import from the application at the repository
root.

## Install

```bash
/plugin marketplace add ./agent-skills
/plugin install algoria@algoria-skills
```

Or copy a single skill directory into `~/.claude/skills/` — each one stands on
its own.

## Skills

| Skill | What it does |
| --- | --- |
| [`stellar-wallet-local`](skills/stellar-wallet-local/SKILL.md) | Create and manage a Stellar wallet on the user's own machine: generate a keypair, encrypt it at rest, fund it on testnet, read balances, import and export seeds. |

## Layout

```
agent-skills/
  .claude-plugin/        plugin and marketplace manifests
  skills/<name>/
    SKILL.md             what the model reads
    scripts/             executables the skill runs
    references/          detail loaded only when needed
  lib/                   shared code imported by scripts
  tests/                 vitest, run against lib/
```

## Runtime has no dependencies

Skill scripts run on Node 22+ with nothing installed. A user who copies a skill
folder onto a fresh machine can run it immediately — no `npm install`, no
network fetch, no lockfile resolution standing between them and their wallet.

This means Stellar's StrKey encoding and ed25519 derivation are implemented in
`lib/stellar/` on top of `node:crypto` rather than imported. The correctness
argument for that is the test suite: `@stellar/stellar-sdk` is a devDependency,
and `tests/strkey.test.mjs` checks every encode, decode and derivation path
against it.

## Development

```bash
pnpm install --ignore-workspace   # this package is not in the root workspace
pnpm test
pnpm check                        # tsc --noEmit over JSDoc-typed .mjs
```

`--ignore-workspace` keeps this package out of the root app's dependency graph,
so the two can be installed, tested and released independently.

Running the tests never touches a real wallet: `ALGORIA_HOME` is redirected to a
temp directory before the keystore module is imported.

One cosmetic note — esbuild warns that it cannot find the root app's
`.svelte-kit/tsconfig.json` while loading the Vitest config. It is reading the
repository root's tsconfig on the way past; nothing in this package depends on
it, and the warning disappears once the root app has been built.

## Security posture

- A secret seed never leaves the user's machine, and no script prints one unless
  the user asks for it by name.
- A passphrase is never accepted as a command-line argument.
- A pubnet wallet must be encrypted.
- The network is always explicit. Nothing here defaults to real money.

See [`skills/stellar-wallet-local/references/keystore.md`](skills/stellar-wallet-local/references/keystore.md)
for the on-disk format and threat model, and [`CONVENTIONS.md`](CONVENTIONS.md)
for the rules every skill in this package follows.
