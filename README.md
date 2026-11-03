# Chicory Desktop

Chicory's Lightning-first wallet for macOS, Windows and Linux. The desktop app
keeps Chicory's warm palette, bloom glyphs, quiet balance updates and spring
animations, with a workspace designed for a keyboard, pointer and wider window.
The Beignet wallet runs on this computer.

![Chicory Desktop with a sample wallet](docs/screenshots/desktop-home.png)

## A desktop workspace

- A persistent navigation rail, wallet selector and Activity column. The rail
  becomes compact in narrower windows, while payment forms keep readable widths.
- Native window controls and menus, remembered window placement, standard text
  editing and keyboard navigation. Use Command on macOS or Control elsewhere:
  `1` Overview, `2` Send, `3` Receive, `4` Activity, and `,` Settings.
- Chicory's original balance, amount entry, payment review, QR, receipt and
  recovery flows, including pointer or keyboard hold confirmation.
- The existing motion engine, interrupted springs and reduced-motion behavior.
  QR fallback decoding loads only when the scanner needs it.
- `bitcoin:` and `lightning:` links can fill an open wallet's Send form. Links
  never review or pay automatically and are dropped when no wallet is ready.
- An explicit sample-wallet mode with isolated preferences and no wallet service.
  Demo balances are always labelled and never replace a failed live connection.

## Run from source

Use Node 24.22.1 and npm. The Electron install downloads its matching runtime.

```sh
npm ci
npm --prefix server ci
npm run runtime:prepare
npm run build
npm start
```

`runtime:prepare` downloads an official Node release, checks its pinned SHA256,
installs the pinned Beignet 0.36.1 engine from a lockfile, applies the reviewed
fresh-address patch and checks the native SQLite module. Packaged apps include
these components and do not need Node or npm installed separately.

On first launch, create or restore a wallet and choose its network, Electrum
server and reachable primary node. There is no bundled Tor daemon. To use onion
peers, provide a running local SOCKS service through `TOR_PROXY_IP` and
`TOR_PROXY_PORT` when launching the app. Clearnet peers connect directly.

To explore the interface without creating a wallet or installing the wallet
runtime:

```sh
npm ci
npm run demo
```

The sample wallet supports Send, Receive, Activity and Settings. Its transactions
and funds are simulated. For renderer development, `npm run web:dev` also serves
the browser preview at `http://127.0.0.1:5173/?demo`.

## Local wallet ownership

The Electron renderer is sandboxed with context isolation and no Node access.
A stable private application origin keeps desktop preferences across launches.
The main process connects to the local manager over an ephemeral loopback port
using a fresh capability. The manager rejects unauthenticated requests, foreign
origins and unexpected Host headers. The renderer never receives that capability
or daemon credentials.

Wallet seeds, channel state and signing remain on this computer. Storage uses
owner-only directories and restricted seed-file permissions. This first desktop
version does **not** reproduce the phone's SQLCipher encryption or biometric
lock. Use an encrypted OS disk and protect your computer account. Do not run the
same Lightning wallet concurrently on another device.

On macOS, closing the window leaves Chicory running in the Dock. Quit Chicory
stops its wallet daemons and closes the app. On Windows and Linux, closing the
window quits. Receiving while the app is quit is limited to explicitly prepared,
supported offline requests. This app does not claim an independent watchtower.

Normal data is stored in `Chicory Desktop` under the OS application-data folder.
Demo data uses `Chicory Desktop Demo`. Developers can set `CHICORY_PROFILE_DIR`
to an isolated directory for testing. Existing phone and Umbrel wallets are not
opened or migrated automatically.

## Build desktop packages

Build on the target operating system and architecture:

```sh
npm ci
npm --prefix server ci
npm run runtime:prepare
npm run package
npm run dist
```

`package` creates an unpacked application in `release/`; `dist` builds the host's
DMG/ZIP, NSIS installer or AppImage. Packaging checks that the bundled Node,
engine and native SQLite match the target. On macOS without a Developer ID,
add `-c.mac.identity=-` to an `electron-builder` command for an ad hoc local build.

The [package workflow](.github/workflows/package.yml) builds macOS Apple Silicon,
macOS Intel, Windows x64 and Linux x64 artifacts on their respective hosts. It
does not publish GitHub releases. Developer ID signing, notarization, Windows
signing and automatic updates are not configured for this initial repository.

## Verification

```sh
npm run check
npm run test:smoke
```

Checks cover TypeScript, shared UI behavior, motion, manager routes, payment
safeguards, local authentication, lifecycle and desktop policy. The Electron
smoke test uses a disposable sample profile, exercises native menus and window
sizes, and writes screenshots and a report to `artifacts/smoke/`.

See [desktop verification](docs/desktop-verification.md) for the exact checks
performed and remaining platform qualification. The inherited
[regtest report](docs/regtest.md) documents the upstream browser and manager
baseline, not new funded testing of this desktop package.

## Source and license

The desktop adaptation reuses Chicory's production UI and the Chicory Umbrel
layout and manager. Source revisions and dependency pins are in
[sources.json](sources.json). The upstream design contract is preserved in
[REDESIGN.md](web/chicory/REDESIGN.md).

- `desktop/`: native window, restricted preload, protocol transport and policy.
- `web/`: Chicory scenes, desktop layout and browser platform adapters.
- `server/`: local wallet manager, engine supervision and tests.
- `build/` and `scripts/desktop/`: reproducible runtime and platform packaging.
- `docker/`, `store/`, and the older browser verification files: inherited
  deployment references, outside the desktop packaging path.

MIT. See [LICENSE](LICENSE). Beignet and the original Chicory sources retain
their upstream licenses and copyright notices.
