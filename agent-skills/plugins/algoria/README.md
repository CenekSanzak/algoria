# algoria

A Stellar wallet your agent can spend from — on your machine, not a server.

Creates a wallet, funds it on testnet, adds the USDC trustline so it can hold
USDC, and tops it up with mock Turkish lira through a sandbox anchor. The secret
seed never leaves your computer.

No install, no API key, no account:

```bash
npx algoria wallet onboard --network testnet
```

That one command creates the wallet, funds it from Friendbot, and adds the
trustline. Run it again and it reports what was already done.

## Commands

```bash
npx algoria wallet onboard --network testnet   # create + fund + trustline
npx algoria wallet balance --json              # USDC and XLM
npx algoria wallet accounts                    # every wallet on this machine
npx algoria topup start --try 200              # open a deposit, get bank details
npx algoria topup status --wait                # follow it until the USDC lands
```

`npx algoria` lists everything. `npx algoria wallet` lists just that group.

Every command takes `--json`, so it composes into scripts.

## Using it as an agent skill instead

This package is also a Claude and Codex plugin. Installed that way, your agent
gains the wallet as a skill and decides when to use it, rather than you typing
commands:

```bash
# Claude
/plugin marketplace add berkingurcan/algoria-x
/plugin install algoria@algoria-skills

# Codex
codex plugin marketplace add berkingurcan/algoria-x
codex plugin add algoria@algoria-skills
```

Then just ask: *"create a Stellar wallet and fund it on testnet"*.

## Things worth knowing

- **`testnet` is the default, and testnet balances are not money.** Real funds
  need `--network pubnet`, typed deliberately.
- **A funded Stellar account still cannot hold USDC** until it has a trustline.
  `onboard` handles that. `usdc: null` means the trustline is missing, which is
  not the same as a zero balance.
- **Testnet seeds are stored unencrypted**, in `~/.algoria/wallet.json`. A
  passphrase there protects nothing and blocks automation. **Pubnet seeds are
  always encrypted** (AES-256-GCM, scrypt), and the passphrase is never accepted
  as a command-line argument.
- **A lost passphrase is a lost wallet.** There is no recovery path — nothing is
  held anywhere that could restore one.
- **`--try 200` is 200 mock lira, not 200 USDC** (roughly 4 USDC). The top-up
  anchor is a sandbox: no real bank, no real lira, no mainnet.
- Nothing here sends money on your behalf. Paying a deposit is always your step.

## Requirements

Node 22 or newer. No dependencies — the Stellar SDK is bundled, so this runs
offline once fetched.

MIT licensed. Part of [Algoria](https://algoria-agent-economy.berkingurcan.chatgpt.site/).
