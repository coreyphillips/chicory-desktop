# Desktop verification

This file records checks performed for the desktop adaptation on
November 3, 2026. Upstream browser and regtest reports remain historical
references. They do not qualify a desktop binary by themselves.

## Scope

The desktop app reuses the production Chicory UI snapshot, shared wallet client,
Beignet 0.36.1 engine and the Umbrel manager's payment safeguards. Desktop changes
add an isolated Electron window, stable custom origin, private manager transport,
responsive navigation, native commands and platform packaging.

## Automated checks

`npm run runtime:prepare` provisions the exact runtime before `npm run check`.
The suite covers platform behavior, desktop policy, OS key wrapping, encrypted
files and database pages, Tor supervision, manager routes, TypeScript and the
production renderer build.

Version 0.2 passed 529 automated tests locally: 86 platform tests, 47 desktop
tests and 396 manager/storage tests, with zero skips. The actual bundled engine
fixture verified private IPC bootstrap, encrypted config and database creation,
and early parent-disconnect cleanup against a local test endpoint.

- TypeScript and a production Vite build.
- UI/platform tests, including custom spring animation execution, reduced motion,
  interrupted animations, uncertain outcomes, request routing, public storage,
  desktop widths and keyboard behavior.
- Manager tests, including import identity, recovery access, storage, payment
  metadata, engine compatibility, TLS, local capability authentication, Host and
  Origin rejection, readiness and parent-disconnect shutdown.
- Desktop policy tests for application URL parsing, external URL restrictions,
  payment-link bounds, traversal rejection, capability forwarding, restrictive
  CSP, display bounds and the preload's event boundary.
- Native SQLite validation under the exact standalone Node runtime included in
  the package. The build repeats this against copied package resources.

## Native interaction checks

The `scripts/desktop/smoke.mjs` runner uses a disposable demo profile and native
Electron menus. It checks the normal and compact desktop workspace, that
Overview's balance, Send, Scan and Receive answer a click, that a drag or triple
click selects no text on Send or Receive while their fields still select,
physical amount entry, payment review, cancellation of an incomplete hold,
Receive, Settings without Stop wallet, the server prompt when switching to
regtest without one, the sidebar without a wallet drop-down, reduced motion,
renderer isolation and demo API denial. It never uses real wallet data or sends
a real payment.

The packaged macOS arm64 application also passed `scripts/desktop/live-smoke.mjs`
with production developer tools disabled. Its real manager reported Beignet
0.36.1 and zero wallets in a disposable profile. The test verified loopback-only
listening, HTTP 403 for unauthenticated requests, preferences surviving a complete
app restart, clean application exits and termination of each manager process.
The version 0.2 packaged run also verified the real OS-wrapped key, encrypted
vault continuity and bundled Tor reaching 100% through private manager IPC.
It exercised an onion bridge and confirmed that Tor exited with the app.
No real wallet was created and no funds were used.

Use `CHICORY_SMOKE_TOR=1 node scripts/desktop/live-smoke.mjs` for the live
network variant. Set `CHICORY_ELECTRON_EXECUTABLE` to the packaged executable
to test an installed build. The test uses a disposable profile and Tor Project
public onion service, and never creates or funds a wallet: it sets
`CHICORY_MANUAL_SETUP=1`, so the app does not make its first wallet unasked.

Detailed run results and screenshots are generated in `artifacts/smoke/`. That
folder is excluded from source control. Selected screenshots in this repository
show only the explicit sample wallet.

## Gallery

`npm run test:gallery` draws the mobile gallery's state inventory in a sealed
desktop renderer, captures each state and audits it for clipped figures,
unreachable confirmations, invisible glyphs and focusable hidden panes. CI runs
a deterministic subset. Release checks run `npm run test:gallery:full`. See
[gallery.md](gallery.md).

## App lock on Windows

The app lock raises Windows Hello through a small native helper,
`desktop/windows-hello/hello.cpp`, which `npm run runtime:prepare` builds and
Windows packages ship as `resources/runtime/windows-hello/chicory-hello.exe`.
It calls `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` with
the main window's handle, so the prompt is owned by the Chicory window instead
of opening without an owner. It checks availability before any prompt, refuses
anything but a top-level window handle and the main process's fixed text,
cancels its prompt if the window closes or after 110 seconds, and brings only a
credential dialog owned by that window to the front. A system without the
interop interface offers no app lock. Release builds sign the helper and check
its Authenticode signature with the installer's.

CI builds it on Windows Server 2025 and runs it there: the argument refusals,
and the unavailable answer for a real window on a runner without Windows
Hello. The owned prompt with PIN, face and fingerprint, cancel, and its
placement on the same monitor have not yet been checked on real Windows 11
hardware. That remains tracked in #16 and #17.

## Windows portability

The first Windows CI pass caught an inherited directory-fsync assumption. The
metadata writer now flushes the replacement file on Windows and retains directory
flushes on POSIX. Failure-injection tests verify that flush errors still propagate.
Secret backup metadata and restored files use private POSIX permissions even when
an archive originated on Windows, whose file permissions use ACLs.

## Release limits

macOS Apple Silicon is the local build host. Version 0.2 installers built
successfully for [Windows x64, Linux x64 and macOS Apple Silicon](https://github.com/coreyphillips/chicory-desktop/actions/runs/41756275148)
and [macOS Intel](https://github.com/coreyphillips/chicory-desktop/actions/runs/41755649209).
These artifacts use identical production source; intervening fixes affect test
fixtures only. Native interaction and installation qualification on Windows,
Linux and Intel macOS remain separate release work. macOS development builds use ad hoc signing without Developer ID or
notarization.

[v0.3.0](https://github.com/coreyphillips/chicory-desktop/releases/tag/v0.3.0) is the first signed release, published on 2026-11-06 from commit
`42e7629` for macOS Apple Silicon only. The app inside its DMG and ZIP passed
`codesign`, Gatekeeper and stapler validation, and its signed update manifest
was verified against the pinned key after publishing. No qualification run is
recorded for this package, so funded flows remain unqualified.

Version 0.3.6 adds several ranked primary nodes (coreyphillips/beignet#1924)
and moves to Beignet 0.38.1. On 2026-11-07 the source checkout (not a package)
ran the regtest qualification stages `preflight`, `payments` and `primaries` on
macOS Apple Silicon against the bundled Beignet 0.38.1 and wallet-core
`9027384`: 7 checks passed, direct funding skipped as always, and the guards
reported the `primaries` and `channelSend` capabilities. The `primaries` stage
added a second funded, liquidity-providing node through the wallet client; the
engine ranked it second and the local manager's record followed with both
nodes set up. A fill target of 1,000 sats made the second node the receive
target and the manager mirrored it. A receive of 45,001 sats, above the 25,001
sats the home channel could take, was quoted at the second node (the engine's
steering), while a 1,000 sat receive named no node, as before. The second node
opened the wallet's channel zero-conf and paid 30,000 sats over it; after the
target was cleared and the node removed, the list held one node and the total
rose from 389,096 to 419,096 sats, so the channel with the removed node still
counts. The same run had passed on 0.38.0 earlier that day. The interface is
re-vendored from Chicory `d8c0f26`, which draws Settings > Primary nodes as a
list: one row a node with its host, its connection and a bar of how full it is,
dragged up or down by a grip, opened for its address and a two-press remove,
with the fill target field appearing once there are two nodes; the 96 gallery
states render at both widths. What 0.38.1 changes for the desktop: a payment
no single channel carries is estimated as the split the payment would make
instead of being refused as no route (coreyphillips/beignet#1969). The full
run and the packaged build remain release work.

Version 0.3.6 was published on 2026-11-08 (UTC) as the latest release, tag
`v0.3.6` on `a4db2e7`, built, signed and notarized on the owner's Mac for Apple
Silicon, with the signed update manifest: `Chicory-0.3.6-mac-arm64.dmg`
(263,026,065 bytes, SHA-256 `c4c355033275db30544ef2c5ea8a110db7f4f559b4a29b8121c20e94c577b916`),
`Chicory-0.3.6-mac-arm64.zip` (256,669,518 bytes, SHA-256
`41928bb92271d1c5baaa87aa130c73c993bf76f3ef76a2b6db23c8b294f19140`),
`SHA256SUMS`, `update-manifest.json` and `update-manifest.json.sig`. Checked
logged out, as an installed app sees it: GitHub reports 0.3.6 as the latest
release, all five files are public, a 0.3.5 install accepts the signed
manifest, and the downloaded zip matches its published checksum. The packaged
app was not qualified before publishing: the fresh install, the upgrade over
a funded 0.3.5 and the update-path checks in [releases.md](releases.md) remain
to be run and recorded here.

The bundled engine then moves from Beignet 0.38.1 to 0.39.0
(coreyphillips/beignet#1980). On 2026-11-12 the source checkout (not a
package) passed `npm run check` (typecheck, 159 web, 134 desktop with 4
skipped, 12 qualification and 533 server tests, build), rendered the 96 gallery
states at both widths, and ran the regtest qualification stages `preflight`,
`payments` and `primaries` on macOS Apple Silicon against the bundled Beignet
0.39.0 and wallet-core `9027384`: 7 checks passed, direct funding skipped as
always. Both host patches apply to the published 0.39.0 package at their
reviewed anchors, and the two modules the encrypted-storage patch rewrites
(`sqlite-binding.js` and `restore.js`) are byte-identical to 0.38.1's. The
engine's `listPayments` and its offline-receive channel rule are unchanged, so
the completed-debit projection and the offline capacity figure carry over, and
every capability probe answers as it did on 0.38.1. The runtime lockfile takes
the engine's one dependency change, bitcoinjs-lib 6.1.4 to 6.1.10. What 0.39.0
changes for the desktop: a WebSocket peer is dialed through the SOCKS proxy
the way a TCP peer is (coreyphillips/beignet#1995), so a wallet that sends
everything through Tor no longer dials one directly. The engine can also wait
at a Porch relay and run Iroh relay-only; the desktop turns neither on. The
packaged build was not run for this change.

The release workflow, signed update manifest and manual update path are
described in [releases.md](releases.md). The workflow stays unused until the
owner's signing identities are configured on GitHub.

New funded Lightning/on-chain payments, full disaster recovery, physical camera
hardware, OS protocol installation and Windows/Linux permissions remain release
qualification work. [desktop-native-qualification.md](desktop-native-qualification.md)
is the per-installation checklist for the camera, payment links, clipboard and
accessibility, and lists what automated tests already prove. The existing browser regtest results are useful inherited
evidence, not a substitute for these checks. The packaged regtest suite and its
current gaps are described in [desktop-qualification.md](desktop-qualification.md).

Version 0.2 adds OS-protected storage keys, authenticated encrypted wallet files,
SQLCipher-compatible wallet/guardian databases and encrypted engine backups.
Fresh profiles are supported without legacy migration code. Biometric approval
on real hardware remains tracked work.

A new wallet on another network can reuse the open wallet's recovery phrase.
The page sends only a reference to that wallet. The wallet service reads the
phrase from its encrypted storage, checks that the reference still matches the
wallet and its network, and refuses the same seed twice on one network. It
records the related wallets as one family (`familyId`). A missing, mismatched
or unreadable source stops creation instead of making a new phrase in its
place. Make a separate wallet with a new phrase starts a family of its own.
Each related wallet keeps its own channel databases, activity and balances.

Private interface state is kept by the wallet service in its encrypted storage
(`wallets/secure-store/`), never in browser storage: offline request drafts,
each wallet's cached view, auto-pay policy and network profiles. The app lock
gates it with the rest of `/api`, and an erase removes it. Only display
preferences and the selected wallet stay in browser storage, and private
entries left there by an earlier build are deleted, not imported. A returning
wallet opens on its cached view while the engine starts. That view is shown
disconnected, keeps its original time so the staleness rules still refuse
payments against it, and is merged under each live read so known history is
never dropped. Bundled Tor starts on demand and refuses direct onion
fallback. Clearnet connections retain their normal routing.

Settings > Funds and exits > Erase all wallets from this computer erases every
wallet in the active Chicory profile. After a second confirmation, and the app
lock's fresh authentication when the lock is on, the main process stops the
wallet service and refuses to delete anything unless every engine exited
cleanly. It then removes `storage-key.json` first, followed by `wallets/`
(every network's seeds, databases, journals, activity metadata and service
settings), `tor/` (Tor's cached state) and `updates/`. It also clears the
window's stored state: saved selections, pending-backup flags, offline drafts
and preferences. The app lock setting (`app-lock.json`) and the redacted
`diagnostics.json` are kept. Symbolic links are removed as links and never
followed, and nothing outside the profile is touched. An `erase-pending.json`
marker is written before deletion and removed only after everything succeeds,
so a failed or interrupted erase is retried, or finished at the next launch,
before any key opens. Erase does not send or rescue funds.

Settings > Wallet > Full backup to a file saves every wallet in the profile,
with its channel databases, to one file under a passphrase. It needs the app
lock's fresh authentication when the lock is on. The restore sheet's "Restore a
full backup file instead" brings it back into a fresh profile, on another
computer or OS account. The format (`CHICORYFULL1`) seals an authenticated
payload under a random key made for that archive. scrypt, with bounded
parameters, wraps that key, so no profile key is ever in the file. Each
database is copied between keys with `VACUUM INTO`, never as plaintext. On
restore, every open channel is held (`restoreRecencyUnproven`) until its peer
shows the state is current, because a backup can be older than the channel.
The main process picks the file with the owner, and the archive never passes
through the page. A recovery phrase alone still restores only on-chain funds.

Encryption regression checks include wrong and missing keys, tampered files and
pages, live WAL contents, crash recovery, cross-process file access, encrypted
backups, real Beignet and guardian schemas, and refusal of plaintext database
files. Tor checks cover bootstrap, SOCKS hostname routing, loopback listeners,
process failure, restart and shutdown.

## Dependency audit

The installed local manager dependency tree reported zero npm audit findings
after compatible Express and proxy dependency updates. The bundled Beignet
runtime also reported zero audit findings. The build-only
Electron Builder tree reports moderate minimatch denial-of-service advisories.
That toolchain processes repository build patterns and is excluded from the
packaged application. Do not force a major downgrade to silence this report.
