# Signing proof verification

Date: 2026-10-05 · Repository: `algoria-x` · Branch: `colloseum-intro`

## Confirmed

- Built an ad-hoc signed native macOS app using Apple Swift 6.1 on arm64.
- All 18 offline tests passed: exact self-transfer construction, Viem/Ox signing-digest agreement, DER round-trip, high-S normalization, and rejection of mainnet, extra fields, fee overflow/zero, expiry, invalid nonce, changed request, wrong key, malformed signature, and extra hashing.
- Native offline self-test passed through Security.framework → JavaScriptCore → Tempo envelope verification. This check uses a software fixture key and does not itself prove biometrics.
- Readiness check reported Touch ID available without creating a key.
- The user explicitly authorized the live test and interacted with the native review/signing flow. Live mode created a Secure Enclave key with biometric key-use access controls; no software fallback exists on that path.
- A successful Tempo receipt and the expected one-micro-unit PathUSD self-transfer event were checked.
- Read-only recovery from the saved record independently found the same confirmed receipt and transfer event without signing or broadcasting again. Local app signature verification also passed.

| Evidence | Value |
| --- | --- |
| Network | Tempo Moderato, chain 42431 |
| Disposable public account | `0x020aa46f26daa72edf2294fb9288817dcab91ee2` |
| Transaction | `0x1b10427d55a113e13df8d159de11551a866514a06e63fb6daafb20fa3fcb4d9f` |
| Block | `38257396` |
| Gas used | `281318` |
| Transfer | 0.000001 test PathUSD, account to itself |

[View the confirmed testnet transaction](https://explore.testnet.tempo.xyz/tx/0x1b10427d55a113e13df8d159de11551a866514a06e63fb6daafb20fa3fcb4d9f).

The disposable private key was not exported or persisted. This transaction used testnet faucet tokens, not real funds. No AI provider was called or charged.

## Existing-project baseline limitations

No existing plugin/platform source was modified.

- Existing plugin tests could not start: installed dependencies lack `@rollup/rollup-darwin-arm64`.
- Existing plugin type check reports missing `ajv-formats` in `build/services-sdk-entry.mjs`.
- `deno` is not installed in the inspected shell, so platform checks were not run.

These are baseline environment/dependency problems, not passing regression results. No lockfiles or dependency installations in those projects were changed to conceal them.

## Not yet verified / not claimed

- Manual cancellation during Touch ID, lockout, enrollment changes, and unsupported-hardware UX. The implementation fails closed, but those physical scenarios still need testing.
- Installation and automatic companion launch from each host's installed plugin. This run was initiated from the Codex task's local execution environment.
- MPP payment challenge/settlement, purchased image result, persistent wallet, delegated signer, production IPC, notarization, or recovery/rotation of real-funds keys.
- ERC-8196 wallet-contract conformance and ERC-8126 integration. See the explicit decision in the README.

**Result:** native biometric signing and Tempo testnet acceptance are proven. This is the phase-1 signing milestone, not completion of every architecture, packaging, and policy feasibility gate.
