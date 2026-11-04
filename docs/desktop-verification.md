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
Electron menus. It checks the normal and compact desktop workspace, physical
amount entry, payment review, cancellation of an incomplete hold, Receive,
Settings, reduced motion, renderer isolation and demo API denial. It never uses
real wallet data or sends a real payment.

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
public onion service, and never creates or funds a wallet.

Detailed run results and screenshots are generated in `artifacts/smoke/`. That
folder is excluded from source control. Selected screenshots in this repository
show only the explicit sample wallet.

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
Linux and Intel macOS remain separate release work. macOS local builds use ad hoc signing without Developer ID or
notarization. No public binary release or automatic updater is configured.

New funded Lightning/on-chain payments, full disaster recovery, physical camera
hardware, OS protocol installation and Windows/Linux permissions remain release
qualification work. The existing browser regtest results are useful inherited
evidence, not a substitute for these checks.

Version 0.2 adds OS-protected storage keys, authenticated encrypted wallet files,
SQLCipher-compatible wallet/guardian databases and encrypted engine backups.
Fresh profiles are supported without legacy migration code. Native app lock,
biometric approval, encrypted renderer drafts and portable full channel backups
remain tracked work. Bundled Tor starts on demand and refuses direct onion
fallback. Clearnet connections retain their normal routing.

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
