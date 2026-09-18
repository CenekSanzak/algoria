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

Skill scripts import shared code from `lib/`, which sits outside the skill
directory, so install the package as a unit rather than copying one
`skills/<name>/` folder on its own.

## Skills

| Skill | What it does |
| --- | --- |
| [`algoria-wallet`](skills/algoria-wallet/SKILL.md) | A Stellar wallet on the user's own machine. `onboard` creates it, funds it on testnet, and adds the USDC trustline in one command; `balance`, `accounts`, `fund`, `trustline`, `import`, `export`, `forget` cover the rest. |
| [`algoria-topup`](skills/algoria-topup/SKILL.md) | Mock Turkish lira into testnet USDC, through the TR mock anchor over SEP-6. `start` opens a deposit and hands the user an IBAN, an amount and a reference; the user pays; `status --wait` confirms the USDC landed. |

The command surface is modelled on AgentCash's wallet flow — auto-created wallet,
one entry point with subcommands, `--json` everywhere — adapted to Stellar. See
[agentcash-parity.md](skills/algoria-wallet/references/agentcash-parity.md) for
what maps onto what and which of their choices were deliberately not copied.

## Layout

```
agent-skills/
  .claude-plugin/        plugin and marketplace manifests
  skills/<name>/
    SKILL.md             what the model reads
    scripts/             executables the skill runs
    references/          detail loaded only when needed
  lib/stellar/           keys, keystore, Horizon, trustlines
  lib/anchor/            the TR mock anchor: SEP-10, SEP-6, deposit records
  tests/                 vitest, run against lib/
```

Quick start:

```bash
pnpm install --ignore-workspace
node skills/algoria-wallet/scripts/wallet.mjs onboard --network testnet
node skills/algoria-topup/scripts/topup.mjs start --try 200
```

## Dependencies, and why there is almost none

Wallet creation, balance reads, funding and seed export run on Node 22+ with
nothing installed. Stellar's StrKey encoding and ed25519 derivation are
implemented in `lib/stellar/` on top of `node:crypto` rather than imported, and
`tests/strkey.test.mjs` cross-checks every encode, decode and derivation path
against `@stellar/stellar-sdk` so the hand-rolled version cannot drift.

The SDK is a runtime dependency for two things, both of which need real XDR:
`lib/stellar/trustline.mjs` signs and submits a `changeTrust` transaction, and
`lib/anchor/sep10.mjs` verifies and signs the anchor's SEP-10 challenge. Both
import it lazily, so every other command still works on a machine where
`pnpm install` was never run, and the ones that need it say so.

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

- A secret seed never leaves the user's machine, and no command prints one
  unless the user asks for it in that turn.
- A passphrase is never accepted as a command-line argument.
- A pubnet wallet is always encrypted; a testnet wallet is deliberately not,
  because a passphrase there protects nothing and blocks the agent.
- `testnet` is the default. Real money requires typing `--network pubnet`.
- The anchor is a sandbox and testnet-only, and its host, signing key and USDC
  issuer are pinned. If any of them moves, the top-up stops instead of signing.
- A top-up is never simulated for the user. Sending the money is their step.

See [keystore.md](skills/algoria-wallet/references/keystore.md) for the on-disk
format and threat model, and [CONVENTIONS.md](CONVENTIONS.md) for the rules every
skill in this package follows.
