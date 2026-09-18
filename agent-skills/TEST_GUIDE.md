# Testing this by hand

How to check the Algoria plugin works, before a demo or after a change.

Everything here is testnet. No real money is involved at any point.

**Before you start:** every command below uses a throwaway wallet directory, so
your own wallet at `~/.algoria` is never touched:

```bash
export ALGORIA_HOME=$(mktemp -d)
```

Open a new terminal to get your real wallet back.

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

From the repo root (`algoria-x/`):

```bash
codex plugin marketplace add ./agent-skills
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

## 6. Install it in Claude (2 minutes)

Inside Claude Code:

```
/plugin marketplace add ./agent-skills
/plugin install algoria@algoria-skills
```

Then just talk to it, instead of running commands:

- "Create a Stellar wallet and fund it on testnet"
- "What is my USDC balance?"
- "Top up my wallet with 200 test lira"

It should pick the right skill on its own and report an address and a balance.
If it does something else, the problem is the `description` line in that
skill's `SKILL.md` — that text is all the model sees when deciding.

---

## 7. Clean up

```bash
codex plugin remove algoria@algoria-skills
codex plugin marketplace remove algoria-skills
```

Test wallets live in the temp folder from the top of this page, so there is
nothing else to delete. Close the terminal and it is gone.

---

## Quick reference

| Symptom | Cause |
| --- | --- |
| Install is tens of MB | Something non-shippable is in `plugins/algoria/` |
| Error naming the Stellar SDK | Bundle missing or stale — `pnpm bundle:sdk` |
| `"trustline": false` | The trustline step failed; retry `wallet.mjs trustline` |
| `pending_user_transfer_start` forever | Nobody clicked Simulate on the `payUrl` |
| `pnpm check` names a file or line | A real type error |
| `Cannot find module` running a script | Run from the plugin root, or set `CLAUDE_PLUGIN_ROOT` |
| `No module named 'yaml'` | Wrong `python3`; needs PyYAML |

After changing a skill, reinstall before testing — the installed copy is a
snapshot, not a live link to the checkout:

```bash
codex plugin remove algoria@algoria-skills && codex plugin add algoria@algoria-skills
```
