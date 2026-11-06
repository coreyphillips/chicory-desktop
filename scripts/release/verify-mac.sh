#!/usr/bin/env bash
# Confirms the packaged app is signed by the release team, notarized and
# stapled. release.yml and npm run release:mac both run this from the repo root.
set -euo pipefail

# The wallet key is wrapped by the macOS Keychain, which trusts this team. A
# build signed by any other team could not open an existing wallet.
team=344W3TSQCK

app="$(find release -maxdepth 2 -name Chicory.app -type d | head -1)"
if [ -z "$app" ]; then
  echo 'No packaged Chicory.app was found under release/.' >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app"
details="$(codesign -dv --verbose=2 "$app" 2>&1)"
grep -q 'Authority=Developer ID Application' <<<"$details"
grep -q "TeamIdentifier=$team" <<<"$details"
spctl --assess --type execute --verbose "$app"
# electron-builder notarizes and staples the app before packing it. The DMG
# itself carries no ticket, so validate the app inside it.
xcrun stapler validate "$app"
