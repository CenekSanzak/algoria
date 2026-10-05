# Tempo native signing proof

An isolated macOS development companion for the [implementation plan](../../docs/TEMPO_IMPLEMENTATION_PLAN.md). Its original proof mode is preserved; the source plugin can now launch it for structured MPP image purchases. The companion is built separately from the shipped plugin.

## What it proves

A local AppKit window creates a disposable Secure Enclave P-256 key. A second native review shows a constrained Tempo test transaction. Touch ID protects the key's actual signing operation. The runner verifies the signature, sends the transaction once, and checks both the successful receipt and expected token transfer event.

In version-1 proof mode, the allowed transaction is fixed: **Moderato testnet (42431), one micro-unit of test PathUSD transferred to the signing account itself**. Gas is capped at 1,000,000 and max fee per gas at 30,000,000,000 protocol units. The request expires within five minutes. Version-2 MPP image purchases are described below and use the same fee and expiry caps.

No existing wallet is opened. No private key is exported or saved. The ephemeral key is discarded when the process exits; remaining faucet tokens are deliberately abandoned. Never send real funds to the disposable account.

## Build and run

Requires macOS 15+, Xcode command-line tooling, Node 22+, and enrolled Touch ID for the live check. Use the same commands from either host's local terminal. The plugin launches a locally built companion through `ALGORIA_TEMPO_SIGNER_APP`; a packaged companion installer is not implemented yet.

```sh
cd /Users/berkingurcan/Documents/algoria-x/native/tempo-signing-proof
npm ci --ignore-scripts
npm test
npm run build
".build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof" --self-test
npm run proof -- --status
```

`--self-test` uses an ephemeral **software test key**, never broadcasts, and explicitly does not prove Touch ID. It tests Apple's DER signature encoding, direct-digest signing, JavaScriptCore, and the bundled SDK together. `--status` only reports readiness and creates no key.

With a person present to review and authenticate:

```sh
npm run proof -- --live --fund-testnet
```

1. Confirm creation of a disposable test key in the native window.
2. The runner obtains faucet tokens from the fixed Moderato RPC.
3. Review the fixed self-transfer and approve with Touch ID, or cancel.
4. The runner writes a public recovery record before its only broadcast attempt, then reports settlement.

If the response is lost, inspect the same transaction without signing or broadcasting again:

```sh
npm run proof -- --recover /absolute/path/to/artifacts/receipt.json
```

Recovery records are ignored by Git. They contain public transaction identity and request metadata, not private keys or reusable wallet credentials. A failed service/display flow must never be repaired by silently starting another proof/payment.

## Signing boundary

- The native app loads its own bundled SDK resource. It accepts only version, fixed chain ID, nonce, bounded fee, and expiry via its inherited input pipe.
- The native process derives destination from its own public key and constructs calldata, transaction, review summary, and digest. No caller-supplied destination, amount, arbitrary digest, code, or friendly label is accepted.
- Security.framework creates the enclave key with `privateKeyUsage` and `biometryCurrentSet` access control. There is no password or software-key fallback in live mode.
- `ecdsaSignatureDigestX962SHA256` signs the already computed 32-byte Tempo digest directly. The envelope uses `prehash: false`; do not add another SHA-256 operation.
- The SDK parses Apple's DER signature and normalizes high-S before validating and serializing the Tempo P-256 envelope. The runner independently checks the returned transaction against its original request.
- Expiry is checked before key use and again after authentication. Only one request is processed per native process. The chain nonce provides transaction replay protection.
- The app is ad-hoc signed for local development. Anonymous parent/child pipes are not a production authenticated IPC service. Local build integrity, Developer ID signing/notarization, persistent keys, lifecycle management, and recovery require later work.

## Files

- `Sources/main.swift`: native windows, Secure Enclave key access, signing, bounded input, offline self-test.
- `src/transaction.mjs`: strict request validation and SDK-based transaction construction/verification.
- `src/runtime.mjs`: UTF-8 compatibility for JavaScriptCore.
- `scripts/build.mjs`: bundled runtime, native compilation, local ad-hoc signing.
- `scripts/proof.mjs`: explicit live test, faucet, one-shot broadcast, receipt verification, read-only recovery.
- `tests/transaction.test.mjs`: offline transaction/signature and rejection tests.

## ERC-8196 decision for the next phase

Proceed with the native Tempo P-256 signer for direct payments. This proof establishes neither contract-wallet verification nor ERC-8196 conformance. The standard requires its on-chain wallet interface and an ERC-8126 verification check before agent actions. A native Tempo signature or a local budget alone is insufficient.

Keep ERC-8196-inspired permissions as the accurately labeled baseline until the verification dependency, contract-level P-256 verification, token-spending enforcement, and MPP execution path have working integration tests. Do not use mock risk scores to claim compliance. No policy contract was deployed by this proof.

## References

- [Verification evidence and remaining checks](./VERIFICATION.md)
- [Tempo account source](https://github.com/wevm/viem/blob/main/src/tempo/Account.ts) — use installed pinned sources for reproducible implementation, not unpinned main.
- [Apple Secure Enclave key protection](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)
- [ERC-8196 requirements](https://eips.ethereum.org/EIPS/eip-8196)

Pinned versions are recorded in `package.json` and `package-lock.json`. Both chain wire format and cryptography use the SDK; neither is reimplemented in Swift.

## MPP purchase extension

The companion now also accepts a structured version-2 MPP image purchase. It
constructs the challenge-bound `transferWithMemo`, reviews the actual prompt,
recipient and price, then requires Touch ID to sign. See
[payment implementation and setup](../../docs/TEMPO_MPP_IMPLEMENTATION.md).

After building, `node scripts/check-purchase-runtime.mjs` verifies this path in
the real JavaScriptCore runtime with an explicit offline software test key.
`--self-test-request` is exclusively that offline test mode; it never broadcasts
or returns a signed transaction. Live mode still requires Secure Enclave key
access and has no software fallback.
