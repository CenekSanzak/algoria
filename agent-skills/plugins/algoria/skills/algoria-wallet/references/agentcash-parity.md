# AgentCash parity

This skill's command surface is modelled on AgentCash's wallet flow. This file
records what maps onto what, what Stellar needs that Base and Solana do not, and
which of their choices were deliberately not copied.

## Command mapping

| AgentCash | Here | Note |
| --- | --- | --- |
| `npx agentcash@latest onboard` | `wallet.mjs onboard` | ours also adds the trustline |
| `npx agentcash@latest balance` | `wallet.mjs balance` | one network at a time |
| `npx agentcash@latest accounts` | `wallet.mjs accounts` | every network at once |
| `npx agentcash@latest fund` | `wallet.mjs fund` | Friendbot on testnet |
| `npx agentcash@latest redeem <code>` | — | no invite system |
| `bridge` | — | one chain; nothing to bridge |
| — | `wallet.mjs trustline` | **Stellar only** |

## Concept mapping

| AgentCash | Algoria |
| --- | --- |
| `~/.agentcash/wallet.json`, auto-created | `~/.algoria/wallet.json`, auto-created |
| base / solana / tempo | testnet / pubnet |
| USDC as ERC-20 or SPL token | USDC as a classic Stellar asset + its SAC |
| **SIWX** — free, wallet-signed identity | **SEP-10** — the same idea, already in Algoria |
| x402 `exact` scheme | x402 on Stellar |
| deposit link | Friendbot (testnet), transfer or anchor (pubnet) |

SIWX → SEP-10 is the useful one. AgentCash splits endpoints into *paid* and
*identity-gated-but-free*; Algoria already has the second half built, so the
same two-tier model is available without inventing anything.

## What Stellar needs that they do not

**The trustline.** On Base or Solana, a funded wallet can receive USDC
immediately. On Stellar it cannot: the account must first opt in with a
`changeTrust` operation. A wallet that skips this looks funded, reports a healthy
XLM balance, and silently cannot be paid.

This is why `onboard` exists as one command rather than `create` + `fund`. The
"wallet is ready" state on Stellar has three preconditions, not two, and the one
people forget is invisible until a payment fails.

**Two accounts, not one.** AgentCash derives addresses for every chain from a
single key. Here, testnet and pubnet hold different seeds, so play money and real
money never share a key.

## Copied deliberately

- **Auto-creation on first use.** No separate `create` step. An agent that needs
  an address gets one instead of a prompt. Creation is always announced.
- **One entry point with subcommands**, so the whole surface is one table.
- **`--json` on everything**, so a result feeds the next step.
- **No passphrase on the throwaway network.** Their entire UX rests on the agent
  never being blocked on a human; on testnet there is nothing to protect.

## Not copied

**Their default `$5` autonomous spend cap.** AgentCash's `fetch` pays up to $5
without asking. That is a product decision about autonomy, and Algoria's is the
opposite: separate, explicit payment approval ([docs/PRODUCT.md](../../../../../../docs/PRODUCT.md)).
When a payment skill is added here, the cap belongs on the client *and* the
server, and consent stays explicit.

**"Payment failed → retry the request."** Algoria re-derives every receipt from
the ledger and keeps an unresolved payment visibly uncertain rather than assuming
it settled ([docs/SECURITY.md](../../../../../../docs/SECURITY.md)). That rigour is
worth keeping even though it is more work.

**No passphrase on the real network.** They store a spendable mainnet key with
file permissions as the only control. Pubnet here is always encrypted.
