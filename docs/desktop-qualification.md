# Desktop regtest qualification

`scripts/qualification/desktop-regtest.mjs` drives the packaged app and its
bundled engine through funded flows on a disposable regtest chain. It is
release evidence for test coins only. It is not permission to move production
funds.

## Safety

Every app profile is a new `chicory-qualify-*` directory under the OS temporary
directory. The harness refuses a profile that is not empty, was not created by
the suite, or overlaps a production Chicory profile.

Funding and mining go through `RegtestGate`. It refuses both until Bitcoin RPC
reports `regtest`, the RPC and Electrum genesis hashes both equal the regtest
genesis, Electrum is loopback, and every wallet already in each manager is
regtest. Each later fund or mine call rechecks the chain. Funding accepts only
`bcrt1`, `m`, `n` or `2` addresses. `npm run test:qualification` covers these
refusals and runs in `npm run check`.

Reports redact any field named like a phrase, seed, token, password, cookie or
key. Recovery phrases pass between profiles in memory only.

## Running

Start the chain from [regtest.md](regtest.md), then:

```sh
npm run runtime:prepare
npm run package
CHICORY_ELECTRON_EXECUTABLE="release/mac-arm64/Chicory.app/Contents/MacOS/Chicory" npm run qualify:regtest
```

Without `CHICORY_ELECTRON_EXECUTABLE` the source checkout runs instead, which
does not qualify a package. `CHICORY_QUALIFY_STAGES` selects stages:
`preflight`, `payments`, `restart`, `crash`, `offline`, `drain`, `recovery`,
`transport`. Results go to `artifacts/qualification/report.json` with host,
package file hashes and lockfile dependency versions.

The separate regtest peer is a headless manager on port 3920 using the same
bundled runtime. A second desktop app cannot be the peer: managers allocate
wallet ports from a fixed base, so two instances on one host collide.

The `Regtest qualification` workflow runs `preflight,payments,restart,crash`
against the Linux x64 package on manual dispatch and uploads the report.

## Stages

| Stage | Checks |
| --- | --- |
| payments | Pending and confirmed on-chain receive channelized into the home channel, Lightning receive, Lightning send through the UI review and hold (a short press must not submit), on-chain send at two fee rates with the broadcast fee within review, one Activity row per payment |
| restart | Full app quit with every child process exited, reopen, same wallet and completed rows |
| crash | Freeze the peer so the payment cannot settle, then kill the whole process tree while the engine holds it as pending and the send has not returned. On reopen: one wallet with the same ID, exactly one settled outgoing row that agrees with the payee, the consumed review refused, the held receive request still saved and paid by the peer |
| offline | An offline request to a primary that does not settle must be refused rather than issued as an online request. Where the engine supports offline receive, the primary then enables settlement: offline request, full app quit, peer pays, reopen twice, one credit and one row |
| drain | Send-max quote. Where the manager advertises `drainAvailable`: drain review, a deposit after review, completed two-leg drain with each leg confirmed on chain, the later deposit retained |
| recovery | Recovery phrase import into a fresh profile, on-chain funds restored |
| transport | Records whether the bundled engine advertises Iroh |

## Recovery support

A recovery phrase restores on-chain funds. It does not restore Lightning
channel state. The recovery stage always records seed-only channel recovery as
unsupported, with the engine's recovery status, rather than treating the restore
as complete.

## Not yet qualified

These remain release work and are recorded as unsupported or absent, never as
passed:

- Iroh direct, relay, blocked UDP, relay failure and same-key onion fallback.
  The manager can enable Iroh on an engine that advertises it, but the engine
  does not report its active path, so the harness cannot record transport
  evidence.
- Direct funding. No payer in the harness holds a confirmed coin outside its
  channel, so no send uses a request's funding envelope. The payments stage
  records it as skipped.
- Suspend and resume. The main process does not observe power events, so a
  simulated event would test nothing. Check this manually per platform.
- Two-leg drain. The manager's `/api/config` does not advertise
  `drainAvailable`, so the stage records it as unsupported.
- Crash during encrypted persistence. The crash stage kills during payment
  submission only.
- Windows, Linux and Intel macOS native runs. The harness's process handling
  supports each, but only the Linux workflow exists. Record each manual run's
  report with its package hashes.
- Restore across OS accounts. A fresh profile under the same account uses the
  same OS key store, so it does not prove a different account can restore.
