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
`preflight`, `payments`, `direct-funding`, `restart`, `crash`, `persistence`, `offline`, `max`,
`drain`, `recovery`, `transport`, `backup`. Results go to
`artifacts/qualification/report.json` with host details, lockfile dependency
versions, and a digest of the whole application plus each part that carries
code under test (`app.asar`, `dist`, `server` and every `runtime/*` component,
including the engine, Node and Tor).

Select `guardian-recovery` or `peer-storage-recovery` on its own to fund a
fresh channel, stop its original writer and restore from hosted replicas in
another encrypted manager. Each stage uses its own temporary wallets. The
second manager uses `REGTEST_PEER_PORT + 100` for its port base.
To replay the public watch data on an empty managed node, supply an empty
temporary `CHICORY_QUALIFY_FLORESTA_FIXTURE` to the selected recovery stage,
then run the cold verifier on that fixture.
[Funded recovery outcomes](floresta-beignet.md#funded-remote-lightning-recovery)

Select `forceclose-sweep` on its own to exercise an unpaid Lightning HTLC,
automatic force close, wallet process restart and final sweeps. It also accepts
a public fixture directory for a separate cold managed-node replay.
[Funded close and sweep results](floresta-beignet.md#funded-htlc-timeout-and-final-sweeps)

Select `incoming-preimage` on its own to exercise settlement while the sender
is offline, the sender's current unilateral close and the restarted receiver's
preimage spend. Both live wallets use the selected external regtest Electrs
server. Core checks the witness and payout. Set
`CHICORY_QUALIFY_FLORESTA_FIXTURE` to an empty suite-owned temporary directory
to replay the public blocks and receiver watches from genesis.
[Incoming HTLC recovery](floresta-beignet.md#funded-incoming-htlc-preimage-recovery)

Select `breach-justice` on its own to test a confirmed revoked commitment
while the honest wallet is offline. The old transaction comes from a new
in-memory regtest counterparty, and only the guarded local Core node receives
it. This stage also accepts `CHICORY_QUALIFY_FLORESTA_FIXTURE` for a cold
replay of the penalty witnesses and honest wallet payout.
[Funded breach and justice results](floresta-beignet.md#funded-breach-and-justice)

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

The Floresta developer preview includes the daemon. In the PR's **Floresta
candidate** workflow, download the artifact for your computer from a successful
run. The four artifacts are `Floresta-preview-macOS-arm64` for Apple silicon,
`Floresta-preview-macOS-x64` for Intel Macs, `Floresta-preview-Linux-x64` and
`Floresta-preview-Windows-x64`. Workflow artifacts expire after three days.

On macOS, open the GitHub artifact ZIP and extract the inner
`Chicory-Floresta-Preview-macOS-<arch>-adhoc.zip` with Archive Utility.
Keep the resulting `Chicory Floresta Preview.app` intact. It is ad hoc signed
for review. On Linux or Windows, extract the inner `.tar.gz` or `.zip` and
keep the entire directory together. Launch `chicory-floresta-preview` on Linux
or `Chicory Floresta Preview.exe` on Windows. Each preview has its own app
identity and profile and starts with manual wallet setup. After opening a
disposable wallet, use **Settings > Network & servers > Experimental Floresta
node** to start the monitor.
On Ubuntu hosts that restrict unprivileged user namespaces, an administrator
can grant the extracted executable the `userns` permission with a path-specific
AppArmor profile. [Ubuntu's desktop sandbox guidance](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions)

To build on the target host, prepare the [wallet runtime and Floresta candidate](floresta-qualification.md#run-the-candidate-from-settings)
and run `npm run package:floresta-preview -- --sha256 <prepared-binary-sha256>`.
The command prints the unpacked application path under `release/floresta-preview`.
On macOS it produces an ad hoc signed app. Each package embeds its source
and daemon hashes in `app.asar`. All four workflow jobs launch
the packaged application with an empty profile, start the bundled daemon at
regtest genesis through Settings IPC, stop it, and check the app exits cleanly.
The Mac jobs run this check on a fresh extraction of the archive after verifying
the bundle symlink, both ad hoc signatures and the packaged architecture.

To exercise the packaged monitor during payments, point
`CHICORY_ELECTRON_EXECUTABLE` at that application executable and select
`CHICORY_QUALIFY_STAGES=floresta-preview,payments`. The optional stage clicks
Start in Settings and accepts the regtest confirmation, keeps the monitor
running through the selected payments, then stops it and checks that the
generated data stays available.

On November 5, 2026, the macOS arm64 19-patch preview passed all nine checks
in `floresta-preview,payments,direct-funding,restart` with fresh regtest
storage and disposable wallets. The external wallet sent and received
Lightning payments while the monitor ran. Its signed 20,000 sat direct
funding payment spent a confirmed 22,000 sat coin and reached four
confirmations. Restart restored six history entries. The same app, freshly
extracted from the distribution ZIP, passed the empty-profile Settings smoke.

| Final Apple silicon review package | SHA-256 |
| --- | --- |
| Built Floresta candidate | `152b157a750352af0d2ac9bc5506122923bb5dc3e9e3b20cb3536f0891ebf19b` |
| Ad hoc signed daemon in the app | `c707d16b8a8e7baed0fd79d8ed43d5c213f7f7d55da8d17001c3cecb47139be8` |
| Application tree | `2a266cd4bc23ce44952b3a7c9ef89486719b380e8a8a273e7255c7be5ce8785d` |
| `app.asar` file | `21629a9c3ca0bd443b5427944fb9bf8c483050da3f1aca84ab746b7093a59358` |
| `Chicory-Floresta-Preview-macOS-arm64-adhoc.zip` | `6bbc34ca86e9c5498b27c05301952d80f7af97c7e43fbb8a3039704f5ddf0ef8` |
| Funded qualification report | `190e427ef7947ce448fe754d902183d84fdeb91f1479343f56a1abe4e6842016` |
| Sanitized package receipt | `7fcb75c929ca1c5ac4607ecc61117cd246367c0539524b14cd438efe2d060557` |

A separate two-owner run used the optimized candidate for both wallets'
authenticated private connections. Both paid through a new 300,000 sat channel
and canceled a held HTLC. Its sanitized receipt SHA-256 was
`66c299eacd5c76748341ae45cc0215e174c011dc6eeefffd6d8b334fddcb8994`.
[Private channel qualification](floresta-beignet.md#private-managed-lightning-channel-and-invoices-on-regtest)

## Stages

| Stage | Checks |
| --- | --- |
| payments | Pending and confirmed on-chain receive channelized into the home channel, Lightning receive (over a just-in-time channel from the primary, mined until it settles, when the wallet has no inbound capacity), Lightning send through the UI review and hold (a short press must not submit, the deliberate hold must commit), on-chain send at two fee rates with the broadcast fee within review, one Activity row per payment |
| direct-funding | Also runs with payments. A separate Lightning-first payer holds one confirmed 22,000 sat coin below the channelize floor. It reviews and pays a signed 20,000 sat funding offer. Bitcoin Core must see that outpoint spent in the mempool, and the desktop recipient must report the same confirmed funding transaction and amount in its channel. |
| restart | Full app quit with every child process exited, reopen, same wallet and completed rows |
| crash | Freeze the peer so the payment cannot settle, then kill the whole process tree while the engine holds it as pending and the send has not returned. On reopen: one wallet with the same ID, exactly one settled outgoing row that agrees with the payee, the same invoice resubmitted through the manager refused or coming to nothing with the payee credited exactly once, the held receive request still saved and paid by the peer. Skipped on Windows, which has no SIGSTOP to freeze the peer |
| persistence | Five small payments are sent to the wallet while the whole app is killed, so the engine's encrypted database and the manager's vault files are being written when it dies. On reopen the wallet opens intact, every payment settles one way or the other, and each payment the payer saw complete is credited exactly once |
| offline | An offline request to a primary that does not settle must be refused rather than issued as an online request. Where the engine supports offline receive, the primary enables settlement. It also opens a channel to the wallet with nothing on the wallet's side, because the engine carries an offline receive only on such a channel unless concurrent receive is negotiated. The capacity the wallet reports for an offline receive is quoted in full and refused one sat over. Then: an offline request, saved with its offline flag, a full app quit, the peer pays, two reopenings, one credit and one row |
| max | A new wallet in the same app, funded only by a Lightning receive, so the primary opens its one channel just in time and waives its reserve. Send max over Lightning to an invoice with no amount keeps nothing back, the payee is credited and the wallet reaches zero |
| drain | A new wallet in the same app with that one home channel and a coin below the channelize floor, confirmed in the wallet's own engine. A send-max quote, then, where the manager advertises `drainAvailable`: drain review, a deposit after review, completed two-leg drain (cooperative close and sweep, each confirmed on chain), the destination credited exactly the drained amount, the later deposit retained |
| recovery | Recovery phrase import into a fresh profile, on-chain funds restored |
| transport | Records whether the bundled engine advertises Iroh |
| backup | Full backup exported from the funded wallet, then made stale by a later payment. With the original app closed, it is restored into a fresh profile with its own keys. A wrong passphrase and a changed byte are refused and leave nothing. The restored wallet keeps its identity and history, every open channel is held (`restoreRecencyUnproven`), and a payment over it does not complete. Runs last, because the peer may close the channel when it meets the stale copy |

## Recovery support

A recovery phrase restores on-chain funds. It does not restore Lightning
channel state. The recovery stage always records seed-only channel recovery as
unsupported, with the engine's recovery status, rather than treating the restore
as complete. A full backup file does carry channel state. The backup stage
qualifies its restore, with every open channel held until it is proven current.

## Not yet qualified

These remain release work and are recorded as unsupported or absent, never as
passed:

- Iroh direct, relay, blocked UDP, relay failure and same-key onion fallback.
  The manager can enable Iroh on an engine that advertises it, but the engine
  does not report its active path, so the harness cannot record transport
  evidence.
- Suspend and resume. The main process now records suspend and resume in
  diagnostics and relocks the app lock on suspend, but the harness cannot put
  the host to sleep, and a simulated event would not test the engine or Tor.
  Check this manually per platform.
- A crash at a chosen point inside one encrypted write. The persistence stage
  kills the app while payments are being written, which is not the same as
  stopping it between two specific writes.
- Funded Windows, Linux and Intel macOS package runs. The manual
  `Regtest qualification` workflow exercises the Linux package. The crash
  stage requires a POSIX host. Record manual funded reports alongside the
  tested package digests.
- Restore across OS accounts. A fresh profile under the same account uses the
  same OS key store, so it does not prove a different account can restore.
