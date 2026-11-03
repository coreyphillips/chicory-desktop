# Umbrel package preparation

This directory is release source, not an installable app store. The repository
is private and no Chicory container image has been published yet. Umbrel cannot
fetch a private community store or an image without access to it.

Keep the package templates out of the store root until a real container image
has been built, published and verified. `docker-compose.yml.in` deliberately
cannot be installed. Never replace its image with a guessed tag or digest.

For local development, build the image with:

```sh
docker compose -f docker/compose.yml up --build
```

After publishing a release image, verify it exists:

```sh
docker buildx imagetools inspect ghcr.io/coreyphillips/chicory-umbrel:0.1.0
```

Render a release candidate into an empty output directory, using that image's
multi-architecture index digest:

```sh
node store/prepare.mjs --version 0.1.0 --image ghcr.io/coreyphillips/chicory-umbrel:0.1.0 --digest sha256:YOUR_VERIFIED_INDEX_DIGEST --out /tmp/chicory-store-release
```

The output has `umbrel-app-store.yml` at its root and `chicory-wallet/` beneath
it. Add the final app icon and screenshots before publishing that directory as
an accessible community-store repository. The generated package does not
verify registry access; do that with `imagetools inspect` before installation.

The manager and Tor use dedicated container names. Lightning ports 20101 to
20130 avoid the existing Beignet app's 19101 to 19130 range. The browser entry
uses Umbrel's app proxy and the existing manager access restrictions.
