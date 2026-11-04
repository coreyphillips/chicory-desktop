# Tor build recipes

`tor-browser-build-16.0.tar.gz` is the unmodified source archive from the Tor Project's upstream build repository at commit `eb1e8801b0ed0a73dbae383ca9328e0d9a25ca89` (`tbb-16.0-build1`).

The archive is kept here because Tor's GitLab archive endpoint returns HTTP 406 for hosted CI runners. Its original URL and SHA256 are pinned in `build/tor-manifest.json`. Runtime preparation verifies this copy and includes it beside Tor and its linked dependency sources. No compiled Tor binary is stored in this directory.

The archive retains its upstream license files. Do not modify its contents or replace it without reviewing the corresponding Tor Expert Bundle release and updating the pinned manifest.
