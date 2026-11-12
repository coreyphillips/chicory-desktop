# Desktop native integration qualification

This is the checklist for issue #7: camera QR scanning, `bitcoin:` and
`lightning:` links, the clipboard, and accessibility on each supported desktop
OS. It separates what automated tests already prove from what a person must
check on a real installation. Record one copy per installer you test.

## Run record

Fill in one block per installation.

```
Platform and version:      (for example macOS 26.1 arm64, Windows 11 24H2, Ubuntu 24.04)
Installer file:            Chicory-<version>-<os>-<arch>.<ext>
Installer SHA-256:         (shasum -a 256 <file>, or Get-FileHash on Windows)
Development or signed:     (development builds are ad hoc signed or unsigned)
Tester and date:
Screen reader and version:
```

For each row below, mark it `pass`, `fail` (with what happened) or
`unsupported` (with why), and add notes.

## Already proven by automated tests

These run in `npm run check` on every change. They do not need a manual pass,
but a manual run that contradicts them is a bug.

| Behavior | Where it is tested |
| --- | --- |
| Only `bitcoin:` and `lightning:` links are accepted. A link over 16 KiB, or with spaces or control characters, is refused | `desktop/policy.test.cjs` |
| A second instance hands over only its first payment link, never a flag | `desktop/policy.test.cjs` |
| A link is dropped, never queued, while the window is loading, the app lock is closed or the profile is being erased | `desktop/policy.test.cjs` |
| One click delivered twice in a moment fills Send once | `desktop/policy.test.cjs` |
| Menus, shortcuts and links are dropped while no wallet is ready, a wallet is being switched, a payment is under way or an overlay is open | `web/platform/links.test.ts` |
| A link only fills Send. It never gets camera provenance, so Auto-pay cannot act on it | `web/platform/links.test.ts` |
| A link that arrives mid-payment does not replace the payment on screen | `web/platform/links.test.ts` |
| A refused or missing clipboard says to paste into the field, and copying falls back to the page | `web/platform/clipboard.test.ts` |
| A copied recovery phrase leaves the clipboard after 60 seconds or on quit, sleep or a locked screen, and what the owner copied since stays | `desktop/secret-clipboard.test.cjs` |
| The camera and clipboard permission prompts are Chicory's own, so they neither relock nor conceal the app | `desktop/app-lock.test.cjs` |
| Auto-pay is off by default and applies only to scanned Lightning invoices that name an amount | `web/chicory/src/scenes/send/autoPay.ts` rules, with the shared Send tests |

## Manual checks per installation

### Camera QR scanning

| Check | Result | Notes |
| --- | --- | --- |
| First scan asks for camera permission. Allow, and a printed invoice fills Send | | |
| Deny permission: a clear message, typing and paste still work, nothing stays covered | | |
| Revoke permission in system settings while Chicory is open, then scan again | | |
| No camera attached: the scan control explains and offers paste | | |
| Two cameras: the expected one is used, or it can be chosen | | |
| Close the scan, or minimize or hide the window during a scan: the camera light turns off | | |
| Reopen the scan after that: it starts again | | |
| No frame is saved or sent anywhere. Check with a network monitor, or just confirm no file appears | | |

### Payment links

| Check | Result | Notes |
| --- | --- | --- |
| The installer registers `bitcoin:` and `lightning:`. A link clicked in a browser opens Chicory | | |
| A link with a wallet open fills Send and waits for review and the hold | | |
| A link with Chicory closed or locked opens Chicory and is dropped. It is not filled into whichever wallet opens later | | |
| A link during a payment review does not replace the review | | |
| A link while switching wallets or networks is dropped | | |
| A malformed or very long link is ignored | | |
| Clicking the same link twice quickly fills Send once. Clicking it again later fills it again | | |
| A camera-scanned invoice can auto-pay when Auto-pay is on. The same invoice from a link always waits for the hold | | |

### Clipboard

| Check | Result | Notes |
| --- | --- | --- |
| Paste reads the clipboard after permission is allowed | | |
| Deny clipboard permission: the message says to paste into the field, and Ctrl/Cmd+V into the field works | | |
| Copy buttons (address, invoice, diagnostics) copy, including after a denied read | | |
| Copy phrase: the words paste for 60 seconds, then the clipboard is empty, also after quitting or locking the screen | | |
| Copy phrase with a clipboard manager or Universal Clipboard on: note what, if anything, kept the words | | |
| Cancelling the permission prompt leaves no cover over the window and no hold armed | | |

### Accessibility

Use VoiceOver on macOS, Narrator on Windows and Orca on Linux.

| Check | Result | Notes |
| --- | --- | --- |
| Every control has a spoken label, including icon-only buttons | | |
| Hidden balances are not read out | | |
| Hidden balances stay hidden after quitting and reopening, from the first frame | | |
| Settings panels and sheets keep focus inside while open, and return it on close | | |
| Recovery words are read only after a deliberate reveal, and are not left in focus after Hide | | |
| The hold to send works with Space or Enter held, and a short press does not send | | |
| The screen reader announces payment results and errors | | |
| The screen reader says when a Settings row is open, a network or switch is on, a filter is active, and a control is busy or unavailable | | |
| Text scaling (system font size or zoom at 130 percent) keeps every control reachable | | |
| Reduce Motion: navigation and results still read clearly without animation | | |

## Known unsupported cases

Record them here as they are found, with the platform and installer.

- Linux has no app lock (see #17), so lock-related link checks are `unsupported` there.
- The development build is ad hoc signed on macOS and unsigned on Windows. OS protocol registration and permission prompts can differ on a signed release (#20).
