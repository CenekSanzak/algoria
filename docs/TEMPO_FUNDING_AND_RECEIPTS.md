# Tempo funding and transaction receipts

Source implementation, 2026-10-10. No backend deployment is required. Release
the updated plugin and rebuild the local native companion together; readiness
requires its `fundingVersion: 1`. No npm release is performed by this change.

## User flow

1. The user approves the task and its bounded spending permission as before.
2. When the native companion creates the purchase's temporary Secure Enclave
   wallet, the plugin reads test PathUSD `balanceOf` on chain 42431.
3. If it cannot cover the service price plus maximum gas fee, request the
   testnet faucet once. Wait for faucet receipts, then check the token balance.
   Sufficient wallets skip the faucet. No extra faucet question is needed.
4. If still short, ask the user in the native wallet for only the missing test
   PathUSD. Display the full active address, token contract and chain. The user
   keeps the window open while adding tokens and chooses **Check balance**.
   No repeated automatic faucet calls and no signature before a verified balance.
5. Once funded, review the exact purchase and approve with Touch ID. Checking a
   balance is not signing or spending permission. Original scope/expiry checks
   still apply. Save the payment hash before the existing one-shot broadcast.
6. Return `transactionUrl` and `payment.explorerUrl`, generated locally from the
   saved transaction hash. The skill presents a clickable explorer receipt with
   the result. Recovery, list, provider failures and paid status retain it.
   An uncertain transaction link is not proof of payment confirmation.

Faucet funding is available only on Tempo Moderato testnet. `--fund-testnet`
remains compatible; `--no-fund-testnet` uses manual-only funding. Readiness,
quotes, budget approval and paid recovery do not request faucet tokens.

## Safety and limitations

- The wallet is still disposable, not an independently created persistent
  account. Its key is discarded at process exit. Never ask for real funds,
  private keys or deposits to a previous/closed wallet. Leftover test tokens are
  abandoned. The manual prompt warns about this and has a bounded expiry.
- Funding cancellation/expiry occurs before signing and releases the unpaid
  reservation. Return `retry-wallet-funding` with the SAME task ID. A retry
  creates a new disposable wallet; the old address is not reusable.
- Failed balance reads stop safely, rather than treating an unknown balance as
  zero. A lost faucet response triggers a balance recheck, not another faucet
  write. Native funding UI independently validates the exact purchase, active
  permission and own key-derived address before displaying a top-up request.
- Fees are separate from the service budget. Preflight requires the conservative
  maximum signed fee, not an estimate of the final fee.
- Touch ID being inaccessible in a restricted agent process is not evidence
  that it is disabled. Readiness now directs a permission-approved check outside
  that sandbox when appropriate. No password/software signing fallback exists.
- No persistent wallet, unattended signing or ERC-8196 compliance is claimed.

## Technical references

The explorer origin comes from pinned `viem@2.57.3`'s `tempoModerato` chain:
`https://explore.testnet.tempo.xyz/tx/<hash>`. Hashes must be exact 32-byte hex.
Tests compare the origin with that SDK definition, avoiding the mainnet explorer.

Funding uses `tempo_fundAddress` on the chain-checked, fixed Moderato RPC.
See the [official Tempo faucet example](https://github.com/tempoxyz/tempo#as-a-user).
The maximum fee in six-decimal token units is
`ceil(gasLimit * maxFeePerGas / 10^12)`, per
[TIP-1010 unit conversion](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1010.md).

Offline regressions cover explorer validation, sufficient/empty balances,
faucet failure/lost reply/reverted transfer, manual funding, cancellation,
expiry, wrong chain/token, native scope/address validation, unchanged budgets,
same-task recovery and duplicate-payment protection. Native software fixtures
and UI self-tests do not prove live Touch ID or a live faucet purchase.

Verified locally: 297 plugin tests and 44 native tests pass, TypeScript checking
passes, and native JavaScriptCore image/phone/funding fixtures and UI safety
checks pass. Light/dark funding previews were rendered and visually inspected.
The dependency-free plugin package passed its isolated runtime smoke check.
No live faucet request, purchase, provider call or npm release was run.
