# Native wallet UI refresh

Implemented in `algoria-x`. Algoria brand alignment on `feat-ui-improve`,
6 October 2026. No branch changes were made for this refresh.

## Design

- Dedicated native macOS window instead of a text-heavy system alert.
- The existing Algoria “A” logo, using the exact favicon geometry and colors.
- Slate/silver palette from `landing/src/app.css`, replacing the unrelated teal
  accent; matching light/dark surfaces, borders and monochrome approval buttons.
- Prompt for headings/body and Geist Mono for prices, addresses and metadata,
  matching the landing design. Unmodified licensed fonts are bundled locally
  and registered only for this app process; no font network requests or
  system-wide font installation. SF/system fonts remain a defensive fallback.
- A compact 640-point-wide layout with a clear purpose/amount hierarchy,
  quieter detail tabs, and a distinct fixed security-and-action panel.
- Price and purpose stay visible above the details; approval controls stay below.
- Purchase sections: Review, Wallet, Permission and Activity.
- Budget sections: Overview, Scope and Limits & safety.
- Full, selectable addresses and service URLs; readable local-time expiry.
- Request and full recipient appear together in the first review card.
- Long requests have their own scrolling panel. Window height adapts to the screen.
- Selection is indicated by an underline as well as color, with native button
  actions/accessibility and a visible keyboard focus ring. Increased-contrast
  settings strengthen card borders. No decorative animation is required.

## Approval flow

1. The bundled validator produces the exact review summary, as before.
2. The user sees the purpose, test-token amount, request and destination.
3. Cancel, Escape or window close returns no signed request. Return does not approve.
4. Approve with Touch ID proceeds to the existing Secure Enclave signing path.
5. Expiry is checked by both the UI and signer. An expired review cannot be approved.

Both whole-second and fractional-second ISO timestamps are supported. An
unparseable expiry disables approval instead of silently skipping the countdown.
The budget action says **Set limit with Touch ID**; it is not a payment action.

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
- All 35 native tests pass: the existing 32 transaction/permission tests plus
  bundled font/license integrity, brand color parity and offline asset packaging.
- Real JavaScriptCore purchase and permission checks pass with offline test keys.
- Native UI checks cover actual tab button actions, bundled font loading/logo,
  non-overlapping approval controls at 640 × 730 and 560 × 620, preview isolation,
  approval/cancellation, window close, fractional/invalid expiry rejection and
  keyboard defaults. They use fixtures only and never create a key or sign.
- All seven detail pages were rendered in light/dark appearances; purchase,
  permission, wallet and safety layouts were visually reviewed.
- Live computer-use inspection was unavailable due to a tool timeout. Touch ID,
  real keyboard routing, VoiceOver and smaller-display usability still need a
  human acceptance pass. No live payment was made for this redesign.

The companion remains a development build, not a notarized production wallet.

## Implementation boundaries

`Sources/WalletDesign.swift` owns the native brand tokens, process-local font
registration, vector logo, badges and button painting. `WalletReview.swift`
owns layout, safe preview behavior and expiry presentation. The build includes
the fonts, original SIL licenses and existing SVG logo before local signing.
Font provenance and hashes are recorded in `Resources/Fonts/README.md`.

Transaction construction, Secure Enclave/Touch ID signing, MPP verification,
spending limits, revocation and the backend are unchanged. This redesign does
not claim a persistent wallet, new transaction history or ERC-8196 compliance.
The rebuilt local companion is ready for the existing plugin launch path; these
changes have not been published to npm or committed/pushed.
