# Contributing

Use plain punctuation in repository text, commit messages and branch names.
Do not add em dash characters or attribution trailers.

Keep Chicory's design and payment safety rules in `web/chicory/REDESIGN.md`.
Put native window and transport code in `desktop/`, renderer adapters in
`web/platform/`, and wallet supervision in `server/`. Record upstream revisions
when importing UI or backend changes.

Before committing, run `npm run check`. For desktop interaction changes, build
and run `npm run test:smoke`. For packaging changes, provision the runtime and
build on the target operating system and architecture. Do not assume a native
SQLite binary built on one system can be used on another.

Use disposable profiles, regtest or the explicit demo for validation. Never put
real recovery phrases, production wallet data or local environment files in
fixtures, screenshots, logs or version control. Do not execute real payments as
part of normal checks. Preserve review, staleness, uncertainty and hold guards.

Keep the preload API narrow. Never expose a generic IPC invocation, filesystem,
process execution, daemon token or manager capability to the renderer. New
native permissions must be limited to the main application frame and an explicit
user action.

Unsigned artifacts and upstream test results must be labelled accurately.
Do not describe a package as signed, notarized or funded-flow qualified until
that exact package has passed those checks.
