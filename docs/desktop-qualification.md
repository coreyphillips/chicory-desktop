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
`transport`. Results go to `artifacts/qualification/report.json` with host
details, lockfile dependency versions, and a digest of the whole application
plus each part that carries code under test (`app.asar`, `dist`, `server` and
every `runtime/*` component, including the engine, Node and Tor).

`CHICORY_ELECTRON_ARGS` passes extra switches to the app. On a Mac that already
holds a `Chicory Safe Storage` keychain item from another build, macOS asks
whether the new build may read it, and that prompt stalls an unattended run.
Pass `CHICORY_ELECTRON_ARGS=--use-mock-keychain` so test profiles never touch
the login keychain. Such a run does not exercise the OS key store itself. On
Linux the app refuses plaintext key storage, so run it with an unlocked keyring
and `--password-store=gnome-libsecret`, as the workflow does.

The separate regtest peer is a headless manager on port 3920 using the same
bundled runtime, with its own wallet port range. Managers skip wallet ports
another program already holds, and a wallet whose port another engine answers
stops with `PORT_IN_USE`, but a headless peer keeps the run to one app window.

The `Regtest qualification` workflow runs `preflight,payments,restart,crash`
against the Linux x64 package on manual dispatch and uploads the report.

## Stages

| Stage | Checks |
| --- | --- |
| payments | Pending and confirmed on-chain receive channelized into the home channel, Lightning receive (over a just-in-time channel from the primary, mined until it settles, when the wallet has no inbound capacity), Lightning send through the UI review and hold (a short press must not submit, the deliberate hold must commit), on-chain send at two fee rates with the broadcast fee within review, one Activity row per payment |
| restart | Full app quit with every child process exited, reopen, same wallet and completed rows |
| crash | Freeze the peer so the payment cannot settle, then kill the whole process tree while the engine holds it as pending and the send has not returned. On reopen: one wallet with the same ID, exactly one settled outgoing row that agrees with the payee, the same invoice resubmitted through the manager refused or coming to nothing with the payee credited exactly once, the held receive request still saved and paid by the peer. Skipped on Windows, which has no SIGSTOP to freeze the peer |
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
- Suspend and resume. The main process now records suspend and resume in
  diagnostics and relocks the app lock on suspend, but the harness cannot put
  the host to sleep, and a simulated event would not test the engine or Tor.
  Check this manually per platform.
- Two-leg drain. The manager's `/api/config` does not advertise
  `drainAvailable`, so the stage records it as unsupported.
- Crash during encrypted persistence. The crash stage kills during payment
  submission only.
- Windows, Linux and Intel macOS native runs. The harness's process handling
  supports each, but only the Linux workflow exists, and the crash stage is
  skipped on Windows. Record each manual run's report with its package digests.
- Restore across OS accounts. A fresh profile under the same account uses the
  same OS key store, so it does not prove a different account can restore.
