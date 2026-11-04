# Releases and updates

No signed release has been published yet. Until the owner completes the setup
below and a release passes the qualification list, every package is a
development build: its file name contains `development`, the About panel says
"development build" and the app has no update channel.

## Build types

| | Development and CI test builds | Release builds |
| --- | --- | --- |
| Config | `build/electron-builder.yml` | `build/electron-builder.release.yml` |
| Workflow | `package.yml`, manual only | `release.yml`, on a `v*` tag |
| macOS | Ad hoc signed, not notarized | Developer ID, hardened runtime, notarized and stapled |
| Windows | Unsigned | Authenticode via Azure Trusted Signing |
| Output | 14 day CI artifact | Draft GitHub release |
| Updates | Disabled | Signed manifest, manual install |

## Owner setup

Create a protected GitHub environment named `release` that requires an owner's
approval and only allows `v*` tags. Store these in it, never in the repository:

- `MAC_DEVELOPER_ID_P12`, `MAC_DEVELOPER_ID_PASSWORD`: base64 Developer ID
  Application certificate and its password.
- `APPLE_NOTARY_API_KEY`, `APPLE_NOTARY_API_KEY_ID`, `APPLE_NOTARY_API_ISSUER`:
  an App Store Connect API key limited to notarization.
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: a service
  principal with only the Trusted Signing Certificate Profile Signer role.
- Variables `WIN_PUBLISHER_NAME`, `WIN_SIGNING_ENDPOINT`, `WIN_SIGNING_ACCOUNT`,
  `WIN_CERTIFICATE_PROFILE`.
- `CHICORY_UPDATE_SIGNING_KEY`: an Ed25519 private key in PKCS#8 PEM, and the
  variable `CHICORY_UPDATE_KEY_ID`. Optionally `RELEASE_MINIMUM_VERSION`, the
  oldest version still supported.

Generate the update key offline and commit only its public half:

```sh
openssl genpkey -algorithm ed25519 -out update-signing.pem
openssl pkey -in update-signing.pem -pubout
```

Add `{ "id": "<CHICORY_UPDATE_KEY_ID>", "publicKey": "<PEM>" }` to
`build/update-keys.json`. The release preflight refuses to run while that list
is empty. To rotate, ship a release that pins both keys before signing with the
new one.

Keep the same Developer ID team for every macOS release. The wallet key is
wrapped by the macOS Keychain, and a build signed by another identity cannot
open it. Existing data is preserved, but the wallet stays closed.

## Publishing

1. Set `version` in `package.json`, commit, and push tag `v<version>`.
2. `release.yml` checks the tag and pinned key, runs `npm run check`, then
   builds, signs and verifies each platform on its own host. Signature checks
   use `codesign`, `spctl`, `stapler` and `Get-AuthenticodeSignature`.
3. The publish job writes `update-manifest.json` with the source revision,
   bundled Electron, Node, engine, SQLite driver and Tor versions, the storage
   formats, and each artifact's size and SHA256. It signs the exact manifest
   bytes, writes `SHA256SUMS`, and creates a draft release.
4. Install the draft's artifacts and run the qualification list below. Publish
   the draft only once it passes. Installed apps see the newest published,
   non-prerelease release.

## How the app updates

Release builds offer **Check for Updates** in the app menu (macOS) or Help
menu. The app:

1. Downloads `update-manifest.json` and its signature, and verifies them
   against the pinned key. It refuses a release from another channel, one that
   is not newer than the running version, or one without an installer for this
   OS and architecture.
2. Checks free space, then streams the installer into `updates/` in the
   profile. The file gets its final name only after its size and SHA256 match
   the manifest. A cancelled, failed or disk-full download is deleted. Startup
   also clears that folder.
3. Waits until no storage key is being opened or re-wrapped. It asks the
   manager to pause wallet actions, and gives up if a payment is still running
   after 15 seconds. It then checks the installer again and stops the manager
   and Tor with the normal graceful shutdown.
4. Opens the DMG or NSIS installer and quits. On Linux it shows the AppImage
   for the owner to swap in. The installer never touches the profile, so the
   encrypted wallet and its OS-protected key stay where they are.

The update is never applied silently. If anything fails, the running version
keeps working and nothing is installed.

## Manual verification and recovery

Every release includes `SHA256SUMS`, `update-manifest.json` and
`update-manifest.json.sig`. To check a download by hand:

```sh
sha256sum --check --ignore-missing SHA256SUMS
node -e '
const fs = require("fs"), c = require("crypto");
const sig = JSON.parse(fs.readFileSync("update-manifest.json.sig"));
const key = JSON.parse(fs.readFileSync("update-keys.json")).keys.find(k => k.id === sig.keyId);
console.log(c.verify(null, fs.readFileSync("update-manifest.json"), key.publicKey, Buffer.from(sig.signature, "base64")));'
```

Use `build/update-keys.json` from the tagged source as `update-keys.json`.
Then check that `SHA256SUMS` matches the manifest's `artifacts`. On macOS,
`spctl --assess --type execute -v /Applications/Chicory.app` should report a
notarized Developer ID. On Windows, the installer's Digital Signatures tab
should show the configured publisher.

To recover from a failed install, download the latest published release,
verify it as above and install it over the current app. The profile folder
(`Chicory Desktop` in the OS application data directory) is never removed by
an installer or uninstaller. Do not install a build older than the profile's
storage formats. The manifest lists them.

## Linux

Only the AppImage from GitHub Releases is supported. It has no OS signature
and does not update itself. Verify it with `SHA256SUMS` and the signed
manifest, then replace the old file. Distribution repositories, Snap and
Flatpak builds are not provided.

## Qualification

Each release must pass these on every platform before it is published:

- Fresh install into an empty profile.
- Upgrade from the previous published release with a funded wallet, keeping
  the same storage key and wallet balances.
- Cancel an update download, then confirm the app still runs and `updates/` is
  empty.
- Fill the disk during a download, then confirm cleanup and a successful retry
  after freeing space.
- Request an update during a payment and confirm it waits or refuses.
- Recover by reinstalling the latest published release over a broken install.

`desktop/update.test.cjs`, `desktop/release.test.cjs` and
`server/update-hold.test.js` automate the verification, staging, cancellation,
disk-full, recovery and payment-hold logic. The installer checks above still
need real signed packages.
