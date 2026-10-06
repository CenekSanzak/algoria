# Native wallet UI refresh

Implemented in `algoria-x`, on `colloseum-intro`.

## Design

- Dedicated native macOS window instead of a text-heavy system alert.
- Algoria branding, restrained teal accents, rounded cards and light/dark themes.
- Price and purpose stay visible above the details; approval controls stay below.
- Purchase sections: Review, Wallet, Permission and Activity.
- Budget sections: Overview, Scope and Limits & safety.
- Full, selectable addresses and service URLs; readable local-time expiry.
- Long requests have their own scrolling panel. Window height adapts to the screen.

## Approval flow

1. The bundled validator produces the exact review summary, as before.
2. The user sees the purpose, test-token amount, request and destination.
3. Cancel, Escape or window close returns no signed request. Return does not approve.
4. Approve with Touch ID proceeds to the existing Secure Enclave signing path.
5. Expiry is checked by both the UI and signer. An expired review cannot be approved.

Budget approval uses the same visual language and clearly says **no payment now**.
It is still a local spending permission, not autonomous signing or full ERC-8196
compliance. The UI shows lifetime caps, not invented remaining balances. Activity
describes only the current request, not a fabricated transaction history.

## Safe preview

From `native/tempo-signing-proof`, after building:

```sh
".build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof" --preview purchase
".build/Algoria Signing Proof.app/Contents/MacOS/AlgoriaSigningProof" --preview budget
npm run test:ui
```

Preview data is synthetic and labeled. These modes bypass key creation, signing,
funding, wallet state and network access. Closing a preview cannot approve anything.

## Verification

- Native app builds and is ad-hoc signed for development.
- Existing 32 native transaction/permission tests pass.
- Real JavaScriptCore purchase and permission checks pass with offline test keys.
- Native UI checks cover navigation, preview isolation, approval/cancellation,
  window close, expiry rejection and keyboard defaults.
- Light/dark rendered previews were visually reviewed.
- Live computer-use inspection was unavailable due to a tool timeout. Touch ID,
  real keyboard routing, VoiceOver and smaller-display usability still need a
  human acceptance pass. No live payment was made for this redesign.

The companion remains a development build, not a notarized production wallet.
