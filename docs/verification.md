# Development verification

Verified on November 3, 2026.

## Browser layout and motion

- Wide desktop workspace with navigation, wallet selection and persistent
  Activity. Compact layouts checked at 820 and 390 pixels wide.
- Open payment detail switched to another payment, then resized to compact
  layout and returned with Escape.
- Balance, glyph and pane transitions use the native animation calculations.
  Custom animations no longer fall through to unsupported web warnings.
- Tests compare native timing, spring rest, interrupted velocity, delayed and
  sequenced callbacks, cancellation, reduced motion and exit retention.
- Physical digits and backspace change only the focused amount controls.
  Request and recovery text fields keep their normal editing behavior.
- Short Enter and pointer presses leave the payment review unsubmitted. A
  deliberate full keyboard or pointer hold submits once. Blur, hidden tabs,
  pointer cancellation and stale timers cancel unfinished holds.
- Inactive panes and departing DOM are inert. Scene focus uses browser DOM
  focus without taking the caret out of a live text field.

## Funded regtest

The isolated Bitcoin and Electrum genesis and manager network were checked
before creating test wallets. Existing Docker stacks and production wallets
were not used. The real shared browser client exercised:

- Wallet creation and selection.
- On-chain receipt pending, confirmation and spendability.
- Two unused requests with distinct Bitcoin addresses, both watched after a
  wallet restart, with exact output attribution.
- Lightning review, send, receipt and Activity settlement.
- Duplicate-review, insufficient-funds and expired-review refusal.
- An on-chain 10,000-sat payout with a verified 362-sat mempool fee equal to
  its reviewed fee, followed by confirmation.
- A fresh client after restart restoring original payment IDs, recipient
  amounts and known fees.

The actual desktop UI sent a 1,000-sat Lightning payment with a displayed
2-sat fee, then created a unified 1,000-sat request and animated its paid
receipt. See [the funded report](regtest.md) for setup, evidence and screenshots.

Funded testing exposed missing host request/activity routes, reused receive
addresses and outgoing debit semantics. The project now supplies durable host
metadata, guarded fresh-address allocation and an explicit amount projection.
Unknown payment outcomes retain their dispatch identity and block a new
submission on that channel until reconciled. Tests cover historic receipt
misattribution, uncertain retries and transaction evidence reuse.

## Before an Umbrel release

- Clean container installation on supported Umbrel architectures and gateway
  versions.
- Complete disaster recovery, backup and update policy for current channel
  state.
- Physical camera, clipboard permissions and assistive technology checks on
  supported browser and operating-system combinations.

The local funded verification uses regtest coins. It does not establish a
production deployment or a completed disaster-recovery workflow.
