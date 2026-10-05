# Tempo image payments

Only `image.generate` currently supports MPP on Tempo Moderato (42431), using
six-decimal **test PathUSD**. Use the absolute `PAY` helper resolved in the parent
skill. Do not run Stellar top-up for this route.

Build the development native companion on a Touch ID Mac and set
`ALGORIA_TEMPO_SIGNER_APP` to its absolute `.app` path. It creates a disposable
Secure Enclave key for this purchase. `--fund-testnet` explicitly requests test
faucet tokens. Persistent wallet setup and packaged installation come later.

Use only the user's approved budget and creative request:

```bash
node "$PAY" budget --name tempo-demo --total 0.10 --per-call 0.02 --protocol mpp --json
node "$PAY" quote image.generate --input /absolute/path/input.json --budget tempo-demo --protocol mpp --json
node "$PAY" run SAVED_JOB_ID --approve --fund-testnet --json
node "$PAY" status SAVED_JOB_ID --wait --json
```

The native review shows the actual prompt, token, recipient, price and fees, then
requires Touch ID for signing. `--approve` alone cannot bypass biometric approval.
Display the returned image using the normal delivery rules.

After an interruption, keep the same job. `status` only reads; `run` can resend
its saved hash credential and resume a paid provider submission. It cannot
rebroadcast or sign a second payment after the transaction hash is saved.
An uncertain broadcast needs reconciliation; never create a new quote to hide it.
Recovery tokens and credentials must stay in local state.

Tempo budgets use seven-decimal internal accounting for compatibility with the
existing ledger, while on-chain amounts and receipts explicitly use six decimals.
Separate protocol budgets prevent cross-chain reservations. Existing untagged
budgets/jobs retain their Stellar meaning.
