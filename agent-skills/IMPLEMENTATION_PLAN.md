# Plan: shipping Algoria to users

Two install channels, one source tree. Written for whoever picks this up next.

Today the only way to get Algoria is to clone this repo and add a local
marketplace. This plan adds the two things users actually expect:

| Channel | Command | For |
| --- | --- | --- |
| **A. npm** | `npx algoria wallet onboard` | humans, scripts, CI — no agent involved |
| **B. git marketplace** | `codex plugin marketplace add berkingurcan/algoria-x` | agents, no clone |

They are independent. Either can ship without the other.

---

## The key insight

Bundling the Stellar SDK into `lib/vendor/` already did the hard part. The
plugin directory has **no runtime dependencies at all** and weighs 444KB. So:

- `plugins/algoria/` can be published to npm **as-is**, plus a `bin` and a
  `package.json`. No build step, no second copy, no duplication.
- `npx algoria` installs ~450KB with **zero dependencies**. Fast, and it works
  offline after the first fetch.

One directory becomes both the plugin and the npm package. Hosts ignore
`package.json`; npm ignores the manifests. Nothing conflicts.

**The plugin must keep its own bundle.** Do not make the plugin shell out to
`npx` — that would trade a working offline install for a network round trip on
every call. npx is an *additional* channel for humans, never the agent's path.

---

## A. The npm package

### A1. Add `plugins/algoria/package.json`

Published name: **`algoria`** (checked — available on npm, as are `@algoria/cli`
and `@algoria/agent-skills`).

```json
{
  "name": "algoria",
  "version": "0.3.0",
  "description": "A Stellar wallet your agent can spend from.",
  "type": "module",
  "bin": { "algoria": "./bin/algoria.mjs" },
  "engines": { "node": ">=22" },
  "files": ["bin/", "lib/", "skills/", "assets/", "README.md"],
  "license": "MIT",
  "keywords": ["stellar", "x402", "wallet", "usdc", "agent"]
}
```

No `dependencies` block. That is the point — if one appears, `npx` gets slow and
the offline guarantee is gone.

Two notes:

- This file ships to plugin users too. That is fine; it is 1KB and inert.
- `files` deliberately omits the two manifests. They are meaningless on npm, and
  leaving them out keeps the package honest.

### A2. Refactor the two scripts to expose `main(argv)`

Right now each script reads `process.argv` at import time and runs immediately.
A dispatcher cannot reuse that without rewriting `process.argv`, which is fragile.

Change each script from:

```js
run(async () => {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  ...
});
```

to an exported entry point plus a guard that keeps the direct path working:

```js
export function main(argv) {
  return run(async () => {
    const { flags, positional } = parseArgs(argv);
    ...
  });
}

// still executable on its own, which is how the skills invoke it
if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
```

This keeps `node skills/algoria-wallet/scripts/wallet.mjs onboard` working
exactly as the `SKILL.md` files document it, so nothing about the plugin changes.

### A3. Add `plugins/algoria/bin/algoria.mjs`

A dispatcher, not a reimplementation:

```
algoria wallet <subcommand> [flags]   -> skills/algoria-wallet/scripts/wallet.mjs
algoria topup  <subcommand> [flags]   -> skills/algoria-topup/scripts/topup.mjs
algoria --version
algoria help
```

It imports the target's `main()` and passes the remaining argv. No child
process, so there is no second Node startup.

Bare `algoria` prints the two groups and one example each. `algoria wallet` with
no subcommand prints that skill's existing usage text.

### A4. Keep three versions in sync

The version now lives in three files:

- `plugins/algoria/.claude-plugin/plugin.json`
- `plugins/algoria/.codex-plugin/plugin.json`
- `plugins/algoria/package.json`

Add a test that fails when they disagree. This is the most likely thing to rot,
and a mismatched version means npm and the plugin catalogues disagree about what
a user has.

### A5. Publish

```bash
cd plugins/algoria
npm publish --access public --dry-run   # check the file list first
npm publish --access public
```

**Blocked on you:** publishing needs your npm account, and it is effectively
permanent — a name cannot be reused after unpublish. Confirm the name before
anyone runs this.

Verify from a clean machine:

```bash
npx algoria@latest wallet onboard --network testnet --json
```

---

## B. The git marketplace

This is the one-line install for agent users, and it needs no npm.

Both hosts accept a git source. Codex's own help:

```
codex plugin marketplace add owner/repo --ref main
codex plugin marketplace add https://github.com/owner/repo --sparse plugins/foo
```

**The blocker, which I tested:** the manifest must sit at the *source root*.
Pointing Codex at this repo fails today:

```
Error: invalid marketplace file `.../algoria-x`:
marketplace root does not contain a supported manifest
```

Ours is one level down, in `agent-skills/`. Two ways out:

**B1. Move the marketplace files to the repo root** — `.claude-plugin/marketplace.json`
and `.agents/plugins/marketplace.json` at `algoria-x/`, each pointing at
`./agent-skills/plugins/algoria`. Smallest change. Cost: two host-specific
folders land at the top of a repo that is mostly the SvelteKit app, and your
teammate sees them.

**B2. Split the plugin into its own repo** (`algoria-skills`). Gives a clean
public install line, an independent release cadence, and no clutter in the app
repo. Cost: a second repo to keep current, and this one loses the plugin.

**Recommendation: B1 now, B2 when the plugin outlives the hackathon.** B1 is
about twenty minutes and reversible; B2 is the right end state but not worth the
split mid-event.

Either way, verify by installing from git on a machine that has never seen the
repo — a local path test does not prove the git path works.

---

## Order of work

1. **A1–A3** — the CLI. Self-contained, breaks nothing, testable immediately
   with `npm link`.
2. **A4** — the version check, before anyone can get it wrong.
3. **B1** — the git marketplace. Independent of A.
4. **A5** — publish, once the name is settled.
5. Update `README.md` and `TEST_GUIDE.md` with both install paths.

Steps 1–3 are all reversible and need no accounts. Step 4 is the only one-way
door.

---

## Decisions needed

1. **npm package name** — `algoria` (gives `npx algoria …`), or a scope like
   `@algoria/cli`. All are free today.
2. **B1 or B2** — marketplace at the repo root, or a separate plugin repo.
3. **Who publishes** — the npm account, and whether an org scope should own it
   rather than a personal account.

---

## What this plan deliberately does not do

- **No `dependencies` in the published package.** The bundle exists so there are
  none. Adding one undoes it.
- **The plugin never calls `npx`.** It keeps its own bundle and stays offline.
- **No second copy of `lib/`.** One source tree, two packagings. A CLI that
  drifts from the skill is worse than no CLI.
- **No publish without a decision on the name.** It cannot be taken back.
