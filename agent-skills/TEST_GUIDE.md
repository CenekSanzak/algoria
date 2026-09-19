# Testing this by hand

Everything here is testnet. No real money is involved at any point.

**Run this first, in any terminal.** It points the wallet at a throwaway folder so
your real one at `~/.algoria` is never touched. Open a new terminal to get it back:

```bash
export ALGORIA_HOME=$(mktemp -d)
```

Then pick a section:

- **[Test it as a user](#test-it-as-a-user-5-minutes)** — you have no repo, you just
  want to see it work. Start here.
- **[Test it as a maintainer](#test-it-as-a-maintainer)** — you changed the code and
  need to know you did not break it.

---

# Test it as a user (5 minutes)

Two ways in, and neither needs this repo checked out. Do either or both.

## As a CLI, with `npx`

```bash
cd $(mktemp -d)
npx algoria wallet onboard --network testnet
```

That is the whole test. You should get an address, a funded balance, and
`Ready to receive and spend USDC on testnet.` Then:

```bash
npx algoria                                 # what else can it do
npx algoria wallet balance --network testnet
npx algoria topup start --try 200           # 200 mock lira, about 4 USDC
```

**These are terminal commands, not plugin names.** Asking Claude to "install
`npx algoria …`" confuses it — it tries to read the line as `name@marketplace`.
Either run it yourself (`! npx algoria …` inside Claude Code), or install the
plugin below and ask in plain words.

To test unreleased changes, point `npx` at the package directory instead:
`npx <repo>/agent-skills/plugins/algoria wallet onboard --network testnet`.

## As an agent skill, from GitHub

This is the one a real user does, and it needs no clone — Codex fetches the repo
itself.

```bash
cd $(mktemp -d)
codex plugin marketplace add CenekSanzak/algoria
codex plugin add algoria@algoria-skills
```

No `codex` on your PATH? The ChatGPT desktop app ships one:
`alias codex=/Applications/ChatGPT.app/Contents/Resources/codex`

Now open Codex and just ask, in words:

- *"Create a Stellar wallet and fund it on testnet"*
- *"What is my USDC balance?"*
- *"Top up my wallet with 200 test lira"*

The agent should pick the skill itself. That is the actual product — you typing
nothing but a sentence.

To see the same thing in Claude Code:

```
/plugin marketplace add CenekSanzak/algoria
/plugin install algoria@algoria-skills
```

**Done with it?**

```bash
codex plugin remove algoria@algoria-skills
codex plugin marketplace remove algoria-skills
```

---

# Test it as a maintainer

The rest of this page is for when you have changed the code. It checks things a
user never sees.

---

## 1. Does the code still work? (2 minutes)

Run these from the `agent-skills/` folder:

```bash
pnpm install --ignore-workspace
pnpm test      # expect: 55 passed
pnpm check     # expect: no errors listed
```

`pnpm check` prints two lines naming itself and then stops. That is the pass —
any line mentioning a file or a line number is a real type error.

You will see one warning about `.svelte-kit/tsconfig.json`. Ignore it — it is
the main app's config, and nothing here uses it.

---

## 2. Do the manifests still look right? (1 minute)

Codex ships its own validators, and they are stricter than Claude's. Run them
from `agent-skills/`:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/algoria
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/algoria/skills/algoria-wallet
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/algoria/skills/algoria-topup
```

Expect `Plugin validation passed` and `Skill is valid!`.

If you get `No module named 'yaml'`, your `python3` is missing PyYAML. Use one
that has it, or `pip3 install pyyaml`.

---

## 3. Install it in Codex (2 minutes)

From the repo root (`algoria-x/`). The `.` matters — the marketplace lives at
the repo root, not in `agent-skills/`:

```bash
codex plugin marketplace add .
codex plugin add algoria@algoria-skills
codex plugin list | grep algoria     # expect: installed, enabled
```

No `codex` command? The ChatGPT desktop app ships one:

```bash
alias codex=/Applications/ChatGPT.app/Contents/Resources/codex
```

**Check the install is small.** This is the easiest thing to break:

```bash
du -sh ~/.codex/plugins/cache/algoria-skills/algoria/*/
```

Expect about **444K**. If you see tens of megabytes, something that should not
ship got into `plugins/algoria/` — most likely `node_modules` or the test
harness. Nothing belongs in that folder unless users need it.

---

## 4. The important test: run it from the installed copy

This is the test that catches real problems. The installed copy has no
`node_modules`, so if anything was forgotten or left unbundled, it fails here
and only here.

```bash
cd ~/.codex/plugins/cache/algoria-skills/algoria/*/
node skills/algoria-wallet/scripts/wallet.mjs onboard --network testnet --json
```

**Pass looks like this:**

```json
{
  "created": true,
  "trustline": true,
  "ready": true,
  "steps": ["funded: funded by Friendbot", "USDC trustline added (...)"]
}
```

`"ready": true` and `"trustline": true` are the two that matter. The trustline
step proves the bundled Stellar SDK works, because signing that transaction is
the only thing that needs it.

**Fail looks like this:** any message mentioning the Stellar SDK, or
`"trustline": false`. That means the bundle is missing or stale — run
`pnpm bundle:sdk` in `agent-skills/`, commit the result, and reinstall.

You will see a `Buffer() is deprecated` warning. That is normal noise from
inside the Stellar SDK, not a problem.

Then check reading works too:

```bash
node skills/algoria-wallet/scripts/wallet.mjs balance --network testnet --json
node skills/algoria-wallet/scripts/wallet.mjs accounts
```

---

## 5. Test a top-up (5 minutes)

Still in the installed folder. This is the other half of the demo, and it is
the other thing that needs the bundled SDK (to log in to the anchor).

**Step one — open a deposit.** No money moves yet:

```bash
node skills/algoria-topup/scripts/topup.mjs start --try 200 --json
```

You get back an IBAN, a reference, a `payUrl`, and
`"status": "pending_user_transfer_start"`. **That status is correct, not a
failure.** It means nobody has paid yet.

`--try 200` is 200 mock lira, roughly 4 USDC. Not 200 USDC.

**Step two — pay it yourself.** Open the `payUrl` in a browser and click
**"Simulate incoming TRY transfer"**. This stands in for a bank transfer. You
have to do this by hand — the skill deliberately has no command for it, because
sending money is always the user's decision.

**Step three — watch it land:**

```bash
node skills/algoria-topup/scripts/topup.mjs status --wait --json
```

Expect `"status": "completed"` and a `usdc` balance above zero. `completed` is
the only success. `pending_anchor` and `pending_stellar` mean it is still in
flight, so keep waiting.

If you skip step two, `--wait` will sit there and then time out. That is
expected.

```bash
node skills/algoria-topup/scripts/topup.mjs history --json
```

---

## 6. Does the agent still choose the right skill? (2 minutes)

Install it in Claude from your local checkout and ask in words, rather than
running commands:

```
/plugin marketplace add .
/plugin install algoria@algoria-skills
```

- "Create a Stellar wallet and fund it on testnet"
- "What is my USDC balance?"
- "Top up my wallet with 200 test lira"

Each should trigger the right skill without you naming it. If one picks the wrong
skill or none at all, the cause is the `description` in that `SKILL.md` — that
line is the only thing the model sees when deciding, so this is the check that
editing a description cannot skip.

---

## 7. Test the `npx` command (3 minutes)

The user section above shows the npx flow itself. This step checks the thing a
user cannot: that the tarball contains the right files and drags nothing behind
it.

```bash
cd agent-skills/plugins/algoria
npm pack --pack-destination /tmp

mkdir -p /tmp/npxcheck && cd /tmp/npxcheck && npm init -y
npm install /tmp/algoria-*.tgz
```

**Expect `added 1 package`.** If it says more, a dependency crept into
`package.json` and `npx` just got slower for everyone. There should be nothing
behind this package.

```bash
export ALGORIA_HOME=$(mktemp -d)
npx algoria --version
npx algoria wallet onboard --network testnet --json
```

Same `"ready": true` as step 4. Then check the messages name the right command:

```bash
npx algoria topup status
```

Should say **`algoria topup start`**, not `topup.mjs start`. If it names the
`.mjs` file, the channel signal is broken — `bin/algoria.mjs` sets
`ALGORIA_INVOKED_AS` and `commandName()` in `lib/cli.mjs` reads it.

Run the same command the agent's way and it should say `topup.mjs` instead. Both
are correct; each names the command that user can actually retype.

---

## 8. Clean up

```bash
codex plugin remove algoria@algoria-skills
codex plugin marketplace remove algoria-skills
```

```bash
rm -rf /tmp/npxcheck /tmp/algoria-*.tgz
```

Test wallets live in the temp folder from the top of this page, so there is
nothing else to delete. Close the terminal and it is gone.

---

## Quick reference

| Symptom | Cause |
| --- | --- |
| `error: fetch failed` | Testnet hiccup, not your code. Run it again. |
| Install is tens of MB | Something non-shippable is in `plugins/algoria/` |
| Error naming the Stellar SDK | Bundle missing or stale — `pnpm bundle:sdk` |
| `"trustline": false` | The trustline step failed; retry `wallet.mjs trustline` |
| `pending_user_transfer_start` forever | Nobody clicked Simulate on the `payUrl` |
| `pnpm check` names a file or line | A real type error |
| `Cannot find module` running a script | Run from the plugin root, or set `CLAUDE_PLUGIN_ROOT` |
| `No module named 'yaml'` | Wrong `python3`; needs PyYAML |
| `npm install` adds more than 1 package | A dependency crept into `package.json` |
| `npx` messages name `topup.mjs` | `ALGORIA_INVOKED_AS` is not reaching `commandName()` |
| Versions disagree across manifests | `pnpm test` catches this; fix all three |

After changing a skill, reinstall before testing — the installed copy is a
snapshot, not a live link to the checkout:

```bash
codex plugin remove algoria@algoria-skills && codex plugin add algoria@algoria-skills
```
# Regression checks for discovery, payments and recovery (0.4.0)

From `agent-skills/`, run `pnpm test`, `pnpm check`, `pnpm bundle:sdk`, and
`pnpm bundle:services`. No CI workflow is required for this local verification.
The tests redirect ALGORIA_HOME to temporary directories and mock all payment
and anchor traffic. They do not send a real payment or invoke a paid provider.

The regression suite covers installed script paths containing spaces, Unicode,
and `#`; both direct skill scripts and CLI dispatch; remote top-up recovery and
stale-status reconciliation; discovery schemas; quote identity persistence;
header/body and offer validation; per-call and concurrent total budget limits;
one signature per dispatched job; timeout recovery; unsigned paid-job resume;
and withholding tokens/authorizations from normal output.

Use `algoria discover list` for a live read-only smoke test. A live `pay run`
needs an explicitly authorized budget and consumes backend generation capacity.
Use the saved job ID for every retry. For package verification, `npm pack` the
plugin and extract it into a temporary directory with no `node_modules`, then
run every command group's help and load both bundled SDKs.
