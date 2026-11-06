# Floresta compatibility lab

The source checkout can run a verified Floresta candidate from Settings, register
public Beignet wallet and channel watches, and scan confirmed history. The
candidate is a separate process with a private data directory. The selected
Electrum server still serves the wallet and Lightning. Stock v0.9.1 misses
peer-originated unconfirmed activity and can retain history after a reorg.
[Issue 33](https://github.com/coreyphillips/chicory-desktop/issues/33) ·
[Floresta bug report for review](floresta-upstream-bugs.md)

[Bug filing register for Chicory, Beignet and Floresta](issue-33-bug-review.md)

Review the same native patches as Rust source in the
[Floresta fork draft PR](https://github.com/coreyphillips/Floresta/pull/1).
Its comparison branch points at the pinned v0.9.1 release.

## Run the candidate from Settings

1. Prepare the regular desktop runtime with `npm run runtime:prepare`.
2. Build the pinned Floresta archive with the reviewed patches. Install Cargo,
   CMake, a C++ compiler, libclang and Boost headers with CMake package metadata.
   The macOS arm64 test used Rust 1.99.1, CMake 4.2.3 and Boost 1.85.
   Run `npm run runtime:prepare:floresta -- --debug`. To reuse an existing
   archive, pass `--archive /absolute/path/to/floresta-source.tgz`. Add `--test`
   to run the daemon and four patched library test suites before installing the candidate.
   The recipe verifies the archive and pristine Cargo lock, applies the listed
   patches and records their hashes alongside the digest of the built binary.
3. Set `CHICORY_FLORESTA_CANDIDATE_SHA256` to the digest in the output
   directory name, then run `npm run dev`. Open **Settings > Network & servers >
   Experimental Floresta node**. Select the network and storage folder, check its available disk space
   and confirm the start. Use a disposable regtest profile for qualification.
   The source build rechecks the candidate against that digest before spawning
   it. The ordinary release omits this control and executable. For separate macOS,
   Linux x64 and Windows x64 developer previews, see the package and payment checks in the [desktop
   qualification guide](desktop-qualification.md).
4. Use **Stop** to stop syncing and preserve the local data. Opting in authorizes
   direct Bitcoin P2P connections and storage of public wallet and channel
   history. The current external Electrum server continues to see wallet queries.
   A running node, a synced tip and a complete confirmed scan are separate
   states. Each wallet still needs mempool and recovery coverage before handoff.

A preview can reopen the store it initialized. When the daemon digest changes,
the preview requires an explicit rebuild before it will reuse that location.
You can return to the matching build while its data is intact. To start fresh,
stop the node and use **Remove local node data** on a supported filesystem.
On Windows, Settings shows the exact generated directory. After you manually
remove it, confirm removal in Settings. A missing custom volume stays registered
until its data can be removed safely. Independent wallet and channel backups
belong to Beignet and must be kept separately.

On macOS arm64, the 19-patch preview refused a disposable regtest store
initialized by the 18-patch preview. After confirmed native cleanup, the newer
build started at genesis and the older build refused to reopen the new store.
The daemon checks a marker bound to the profile and exact executable while
holding the store lock. Offline cleanup rewrites that marker under the same
lock after removing the generated data. Restoring a database from a different
build requires a rebuild even if the profile preferences still match.
In-place migration and signed release updates still need qualification.

The supervisor identifies the owned loopback service by its inherited pipe
and genesis header. The managed service has no HTTP control listener. Its
Electrum TCP listener allows chain-health queries only. The private owner pipe
accepts bounded additive registrations. Wallet descriptors are derived locally
over explicit receive/change ranges. The scanner fetches blocks from Bitcoin
peers, checks them against local chain headers including transaction and witness
commitments, and stores matching confirmed transactions, outpoints and proofs
per owner. A changed range or a disconnected cursor triggers replay from
genesis. Cold replay currently reads historical blocks sequentially and can
require significant bandwidth. Missing blocks keep the scan incomplete.

## Reproduce the funded test

1. Build `florestad` from the release commit below using its lockfile and default
   features. The macOS arm64 run used Rust 1.99.1, CMake 4.2.3, Boost 1.85 and
   the Cargo dev profile. The `json-rpc` feature includes compact filters.

   ```sh
   git clone --branch v0.9.1 --depth 1 https://github.com/getfloresta/Floresta.git
   cd Floresta
   test "$(git rev-parse HEAD)" = bc2db8d07e72651f9981ce589c5688f4d575dc7a && \
     cargo build --locked --bin florestad
   ```

2. Obtain `utreexod` v0.6.0 for the build host. Verify the archive against the
   published digest before extracting it. The macOS arm64 run used
   `utreexod-darwin-arm64-20260623-01.tar.gz`, SHA-256
   `6f77f8a7819f97300f7c3f3c32fa3fafb96e777477085f35d24f4990d7befa45`.
   This process mines regtest blocks and serves Utreexo proofs.
   [Proof peer release](https://github.com/utreexo/utreexod/releases/tag/v0.6.0)

3. From the Chicory checkout, run the lab with the two local executables.

   ```sh
   npm --prefix server ci
   npm run --silent qualify:floresta -- \
     --florestad /absolute/path/to/Floresta/target/debug/florestad \
     --utreexod /absolute/path/to/utreexod > floresta-report.json
   ```

The lab creates fresh directories, binds to loopback and configures Floresta
with one public test script before syncing. It mines 101 blocks, spends a
mature coinbase on the proof peer and probes Floresta before and after
confirmation. The expected outpoint comes from the raw transaction. The block
hash and transaction position come from the independent proof peer. Each run
uses new data and shuts down both processes.

The command writes a JSON report, including both binary hashes, to stdout and
progress to stderr. Exit 1 means a check
failed or the lab could not run. Exit 2 means the executed checks passed but
release gates remain open. A fee response is recorded as an observation until
its behavior under changing fee pressure has been tested. Run the probe's unit
tests with `npm run test:qualification`.

To inspect an existing disposable regtest node, run
`node scripts/qualification/floresta-electrum.mjs --port PORT`. The probe
checks the genesis header before sending script queries. Supply `--fixture FILE`
to check a known script against independently captured history. The JSON file
contains `network` (`regtest`), `scriptPubKey` (hex), `parents` (raw transaction
hex) and `transactions` (the script's complete ordered history). Each confirmed
entry contains `hex`, `height`, `blockHash` and `position` in that block. Use
height `0` or `-1` for pending transactions. Use only public test data.

## Observed behavior

On November 5, 2026 the source build ran on macOS arm64 against a fresh regtest
chain. These results cover one watched 50,000 sat output. Mainnet sync time,
storage requirements and Lightning recovery need separate qualification.

| Check | Result on v0.9.1 |
| --- | --- |
| Startup | Regtest genesis, protocol 1.4 and the initial header matched. The server answered Beignet's single-item liveness batch. Beignet ignores the balance value in that particular reply. |
| Peer-originated funding | The proof peer accepted the spend in its mempool. Floresta missed it in the pending history, balance and UTXO queries. |
| Confirmed history | At block 102 the script's history, balance, initial subscription status, raw transaction and Merkle branch matched the fixture. |
| Spendable output | The proof peer mined the transaction at position 1 in the block. The wallet's output was at index 2 in the transaction. Floresta used the block position in its UTXO response. |
| Transaction lookup | The verbose lookup failed Beignet's decoded-transaction requirements. Lookups for the unwatched coinbase parent also failed. The response for an unknown transaction used an error Beignet does not recognize as missing. |
| Fees | All four Beignet targets returned 0.0001 BTC/kB. The pinned implementation returns a constant. |
| Control RPC | An unauthenticated `text/plain` POST with a foreign browser Origin returned the current chain state. The listener needs an authorization boundary before desktop distribution. |

In a separate run on the same host, Chicory's existing desktop regtest harness
used Bitcoin Core 31.0, electrs 0.10.10 and Beignet 0.38.0. It confirmed a
Lightning receive, a UI-reviewed Lightning send, an on-chain send at the
reviewed fee, wallet history after restart and the stale-channel hold on full
backup restore. This was a source-checkout run with disposable profiles and a
mock keychain. A separate direct-funding run traced a confirmed 22,000 sat
payer coin into the funding transaction for a signed 20,000 sat request. The
recipient reported the same transaction and the full amount after four blocks. [Reproduce the existing wallet tests](desktop-qualification.md)

## Managed regtest results

The macOS arm64 test on November 5, 2026 started with empty Floresta storage
and a proof peer on loopback. Pass the prepared candidate as
`--managed-florestad /absolute/path/to/candidate/florestad` alongside the
two binaries in the lab command above to exercise both builds.

| Fixture | Managed result |
| --- | --- |
| Funded script and unrelated wallet | After validating height 102, the two wallets found one matching transaction and zero respectively. |
| Quit, restart and watch expansion | The funded wallet recovered its receipt. Adding its public script to the second wallet recovered the old transaction there as well. |
| Descriptor recovery | The range through index 104 had zero matches. Extending the same public descriptor through 105 found the historical funding transaction. |
| Competing confirmed spends | At height 103 an outpoint watch found one transaction on the initial branch. After a longer branch reached height 104, the same watch found zero and the funded wallet retained two canonical transactions. |
| Parent and confirmed wallet recovery | The seven-patch candidate recovered the unwatched 105-byte height-1 coinbase that funded the watched spend. Two bounded owner sessions returned independent history. The miner's script had 103 entries at tip 102, 105 at tip 103 and 106 after the competing tip reached 104. All history and spendable outpoints matched independently decoded blocks. |
| Historical verification after restart | A foreground sync from genesis verified through height 102. On reopen, independent replay reached its persisted height-102 accumulator. Truncating the saved replay certificate to seven bytes forced safe replay through the same anchor. That anchor stayed verified through the competing tips. |
| Node data removal | An explicit Settings action removes recognized data on local macOS APFS or Linux ext4 while holding the same exclusive lock as the daemon. Native tests on both filesystems covered foreign owners, unknown files, symbolic links, hard links, interruption and restart. An unprivileged Linux arm64 run refused an overlay filesystem and a same-device bind mount. Linux requires kernel 5.8 or later with openat2, mount identity and readable kernel mountinfo. Windows requires manual removal after shutdown. |
| Cold channel funding after full-backup restore | An empty node verified all 126 blocks mined by the independent Bitcoin Core fixture. Both the live channel counterparty and the restored recipient found the old 386,634 sat channel output at height 117 and the new 406,634 sat output at height 123. The restored recipient also recovered the 22,000 sat payer input at height 121 through its parent transaction. Both owners reported exactly two history rows and one current funding UTXO. Beignet kept the stale channel held or closed. |
| Pending wallet reads on a controlled proof peer | The pinned Beignet client used an owner-bound TLS session to read the 29,000 sat pending receipt and its 25,000 sat replacement. It decoded and verified both transactions, received the script notification, recovered the same replacement on cold restart and checked its confirmation at height 105, position 1. |
| Existing external Lightning backend | Eighteen checks passed in the complete suite, including direct funding, crash during submission, offline receipt, send max, drain, restart, on-chain recovery and full-backup restore. Iroh path inspection was skipped and seed-only live channel recovery is unsupported. |

One 102-block run on an Apple M5 Pro with 64 GiB RAM took 32.1 seconds to
reach the tip and 2.0 seconds to catch up two wallet scans on loopback. The
debug binary was 59,207,640 bytes. These measurements describe that regtest
fixture. On the seven-patch candidate, a fresh 102-block sync took 32.6
seconds, and two wallet scans took 2.0 seconds. The test snapshot occupied
67,710,976 allocated bytes across 16 files with a combined logical size of
2,217,205,149 bytes. The difference includes sparse chain store files.
Sustained mainnet sync, peak disk use, peer diversity and recovery of a live
channel from cold data require their own runs.

The same twelve-patch history, fork and pending fixtures passed with both
debug and optimized binaries. On the same Mac, validating the first 102
regtest blocks took 33.4 seconds for the 62.0 MB debug daemon and 18.6
seconds for the 17.7 MB optimized daemon. Two initial owner scans took
1.03 seconds and 0.28 seconds respectively. In the generation that handled
the longer fork, the largest interval between native status messages was
13.96 seconds in the debug run and 2.00 seconds in the optimized run.
A separate test deliberately paused the owned child, verified that wallet
access was withdrawn, resumed the same child with fresh grants, then
confirmed prolonged silence closed the control pipe after about 105 seconds.

## Qualify a locally observed pending transaction

With the pinned candidate prepared, run the following against a disposable
proof peer on this machine. The test starts and stops its own processes and
compares exact outpoints, fees and txids against the peer. The digest identifies
the local platform binary built by the recipe above.

```sh
node scripts/qualification/floresta-pending-lab.mjs \
  --utreexod /absolute/path/to/utreexod \
  --digest "$CHICORY_FLORESTA_CANDIDATE_SHA256"
```

The managed proof request path accepts only an explicitly configured loopback
peer on regtest. Its view is limited to validated observations. Peer loss,
missing proof data or unresolved watch coverage prevents an authoritative
answer about missing transactions. The private qualification bridge requires a
wallet-owner grant and rejects connections without the issued TLS key.
To exercise multi-input funding across a cold reopen on a compatible local
proof peer, add `--extended-inputs` to the full funded lab with
`--managed-florestad`. At tip 105 the wallet observed a two-input spend of
confirmed outputs 1 and 0, a 51,000 sat receipt and a 2,500 sat fee. It
recovered the same inputs and change on reopening, then verified inclusion at
height 106. When verified chain status is more than 15 seconds old, the supervisor
withdraws all wallet read and broadcast grants. The child has a further
90 seconds to report fresh chain state and reverify its endpoint and storage;
otherwise the supervisor stops it. Recovery requires fresh owner grants. The
scope of these results is controlled regtest.

## Reproduce an authenticated wallet send

Use the same dedicated local proof peer and add `--wallet-send` to the
pending lab command above. This fixture activates SegWit on regtest before
funding a real pinned Beignet wallet. It checks a one-time approval for
the reviewed transaction ID and witness ID. Only the connected local proof
peer can request those bytes. The returned relay result is verified
independently against peer admission and the mined block.

The funded wallet found 150,000 sats, sent 42,000 sats with a 426 sat fee
for 142 virtual bytes, and verified confirmation at height 434. The fixture
rejected a modified witness, a foreign owner, a stale tip, an observed
pending conflict, reuse of the approval and a confirmed spent input. A second funded send through Beignet's Lightning
chain backend broadcast method confirmed at height 436. Both broadcasts were
on-chain payments. Neither test moved a Lightning channel onto this backend.
The wallet used its regtest fee settings. An insufficient-data result from
the service still requires a production fee policy.

## Reproduce cold channel recovery

Use the guarded Bitcoin Core and Electrs regtest setup from the [desktop
qualification guide](desktop-qualification.md). The first command starts a
disposable recipient in the real desktop and an independent channel
counterparty. It makes a direct-funded splice, exports an encrypted full
backup, settles one more payment, then stops the original recipient before
restoring the stale backup into a fresh manager. Only sanitized public watch
snapshots and raw regtest blocks enter the fixture directory. The backup and
wallet keys stay out of it.

```sh
fixture=$(node --input-type=module -e 'import fs from "node:fs"; import os from "node:os"; import path from "node:path"; console.log(fs.mkdtempSync(path.join(os.tmpdir(), "chicory-qualify-channel-")))')
CHICORY_QUALIFY_STAGES=direct-funding CHICORY_QUALIFY_FLORESTA_FIXTURE="$fixture" npm run qualify:regtest
node scripts/qualification/floresta-lightning-restore.mjs \
  --fixture "$fixture" --utreexod /absolute/path/to/utreexod \
  --digest "$CHICORY_FLORESTA_CANDIDATE_SHA256"
```

The second command builds the proof index from those exact blocks, starts
Floresta with empty chain and wallet caches and registers the two owners'
actual watch snapshots. It compares transaction bytes, block anchors,
funding history, Merkle proofs and balances with the independent Core chain.
This exercise covers confirmed on-chain recovery for a funded splice. Guardian quorum and peer-storage recovery have separate funded and cold-scan fixtures in the [desktop qualification guide](desktop-qualification.md).

## Catching up after a one-week block backlog

On macOS arm64, a disposable regtest node stopped at height 102 after recording a 100,000 sat funding output. The proof peer mined 1,008 more blocks while the node was offline. A transaction at height 606 spent the original output and returned 31,000 sats to the watched script. Another paid it 47,000 sats at height 1,109. At tip 1,110 the same saved registration found all three transactions, with 1,009, 505 and two confirmations respectively. The verifier compared their exact bytes and active block positions with the peer and found two current outputs totaling 78,000 sats.

On an Apple M5 Pro the optimized managed supervisor reached the verified tip and finished its saved watch scan in 34.46 seconds. During catch-up its two loopback P2P streams received 592,226 bytes and sent 106,605 bytes. Its node files used 67,203,072 allocated bytes before shutdown and 68,567,040 after catch-up. The counts cover the proof peer transport, including handshakes and historical wallet block retrieval. Filesystem allocation was measured with the node stopped. The fixture represents a week's expected block count on a local regtest chain with sparse wallet activity. Mainnet block sizes, peer bandwidth, calendar-time Lightning deadlines and hardware will affect other runs.

The `--desktop` run exercised Chicory's source Electron app on a fresh profile. It accepted the regtest opt-in, quit the application, then reopened the same profile in a new process after the peer mined the backlog. The saved opt-in restarted the node automatically and recovered the same three payments from a single watch registration. From launch, reaching the verified tip took 34.848 seconds and checking all three transactions took 34.870 seconds. The two loopback connections received 588,952 bytes and sent 106,605. Node files grew by 1,363,968 allocated bytes. Both Electron processes exited successfully. The harness uses Electron's mock keychain and supplies the isolated proof peer through the existing settings test factory.

```sh
node scripts/qualification/floresta-offline-lab.mjs \
  --utreexod /absolute/path/to/utreexod \
  --digest "$CHICORY_FLORESTA_CANDIDATE_SHA256" --desktop
```

## Mainnet quick start

Enabling the managed mainnet node defaults to checkpoint quick start. The start dialog describes the trust placed in the release's accumulator at Bitcoin block 939,969. Select **Require full verification before use** to wait for independent validation through that block. Historical verification runs in the background in both modes. A profile already running an earlier preview keeps its previous full-verification policy until its owner changes it. Selecting either mode leaves the existing external wallet in use until local wallet and Lightning checks qualify a handoff.

The checkpoint shortens initial validation once the node has downloaded a valid header chain containing that block. Current blocks after it still need to be downloaded and validated using proofs. A wallet with old channel funding may also need historical transactions to establish its watch coverage. The node can report progress on all three activities independently.

### Bounded public peer trial

A wallet-free macOS arm64 run on November 5, 2026 used an Apple M5 Pro with 64 GiB of RAM and an internal SSD, a fresh APFS disk image capped at 2.25 GiB, direct public Bitcoin peers through a byte-counting local relay, and the optimized `4b20cc88` candidate. The first startup reported its genesis status in 0.35 seconds. With release discovery and the trial relay it reached three TCP peers but received no headers in four minutes.

A separate cold startup used advertised peer services from Bitcoin handshakes and the public proof seed in newer Floresta. From launch it reported status in 0.34 seconds, connected to its first peer in 10.39 seconds and reported its first headers in 36.34 seconds. At 4 minutes 36 seconds it had installed the pinned checkpoint at 939,969. By the next sample its headers reached 974,692. The foreground validation index stayed at the checkpoint until shutdown after 14 minutes 22 seconds. The relay received 157,643,652 bytes and sent 535,838 bytes. The stopped node occupied 192,798,720 allocated bytes. The wallet was never opened. This run establishes a time to the checkpoint under those peer conditions. A time to the validated tip or a wallet handoff is still outstanding.

The same network trial sent a confirmed-block proof request for height 939,970 to the five endpoints returned by the newer upstream proof seed. Two peers completed a Bitcoin v2 handshake and advertised the Utreexo proof service. Both delivered a 2,384,708-byte proof payload naming a recent block at height 974,692. Neither delivered any proof for 939,970 on a separate 40-second request. The comparison identifies an availability limit for the sampled peers and heights. It does not establish network-wide archival coverage or prove why either peer withheld its response. The control matched the requested block hashes. It did not independently validate the recent accumulator.

The public trials above used fresh data. The preview inherits a v0.9.1 shutdown bug that can save an empty list of recently connected proof peers in `anchors.json`. The independent `peers.json` address book and fresh discovery can still supply candidates at restart. [Anchor persistence and its upstream fix](floresta-upstream-bugs.md#connected-proof-peer-anchors-can-be-lost-at-shutdown)

### Public bridges serving the checkpoint successor

On November 5, 2026, two public utreexod bridges returned the complete block proof for mainnet height 939,970. A public crawler listed `91.98.226.36:8335` (utreexod 0.6.0). Utreexod's unfiltered seed `manualseed.calvinkim.info` resolved to `1.231.31.3:8333` (utreexod 0.5.1). Both answered over Bitcoin v2 transport. The explicit port matters when reproducing the check. [Crawler entry for port 8335](https://btcnodes.io/api/v1/nodes/91.98.226.36-8335/) · [Utreexod mainnet seed list](https://github.com/utreexo/utreexod/blob/fe71f3d9282ef0812f7f6087f0c0df9ce0fda508/chaincfg/params.go#L335-L339)

Both bridges returned byte-identical payloads at four sampled heights, 939,970, 939,971, 957,350 and their reported tip of 974,730. For 939,970, the full `uproof` payload was 1,772,328 bytes with SHA-256 `c20f0e4d7fc06a879d6c072198207120d394b8ed7282f4b20def49abb4875506`. It named block `00000000000000000000bc336ef6e678778f5138e50ef118fd70b7d292e069f1` and contained 8,253 targets, 49,568 sibling hashes and 8,253 spent leaves. To repeat a spot check, request all three fields with `getuproof` for that block hash and hash the decoded message payload, excluding the transport framing. Continuous coverage through the tip requires sequential validation.

A cold run used Chicory commit `70366ec`, the 21-patch macOS arm64 release binary identified below, and a fresh wallet-free profile. The desktop supervisor verified the executable and managed store. The test supplied `--connect 91.98.226.36:8335` and restricted the daemon to a metered relay that permitted only that endpoint. With the release checkpoint, script verification and background replay enabled, the supervisor first reported the checkpoint at 130.62 seconds and a validated successor at 136.44 seconds. Its last running status showed **940,008 validated**, header tip 974,730 and independent historical replay at 2,075. The run exited cleanly at 161.24 seconds after receiving 266,443,277 bytes and sending 597,383 bytes.

A separate verifier linked and rehashed the mainnet headers from genesis through 939,971. Starting with the release checkpoint's 18 roots and 3,066,490,760 leaves, it reconstructed the spent outputs from each block and its proof, checked the transaction and witness commitments and applied both accumulator transitions. Every root and the leaf count matched Chicory's stored result at both heights. The leaf counts were 3,066,497,949 at 939,970 and 3,066,503,555 at 939,971. Flipping one bit in a sibling hash made the independent verifier reject each altered proof.

On restart, the relay blocked the first bridge. The test supplied the second archive and ordinary block peers in the saved peer files. Chicory reopened the same store at validated height 940,013, five blocks beyond the last running status sampled before shutdown. It reached 940,025 and exited cleanly after 22.78 seconds. Its wallet-ready flag stayed false throughout both runs.

A third run opened both archives, then the relay cut all connections to `91.98.226.36:8335` at 940,030 and blocked reconnection. The same managed process advanced another **56 blocks to 940,086**. The remaining archive delivered 87,811,885 more bytes. The stopped store contained a linked header and a saved accumulator at each of the 117 successive heights after the checkpoint. The last validated block hash matched an independent lookup. Historical replay had reached 2,615. These targeted runs used supplied peers. The following fresh-profile trial addresses automatic discovery; continuous foreground validation to the recorded tip and wallet readiness remain separate checks. [Block 940,086](https://blockstream.info/block/00000000000000000000ce67384d7261850ddf565b5895525318b9a08d8d56d4)

### Automatic archive discovery

The candidate queries `manualseed.calvinkim.info` without a service prefix and publishes each seed's answers as they arrive. Archive service bits on these candidates are selection hints; the peer handshake replaces them before requests are routed. Historical sync can retry DNS when the ordinary address buckets are full but no archive is connected. The existing hourly retry interval remains, so a populated old profile can wait about an hour for fresh discovery. [Discovery patch and offline regressions](../build/floresta/automatic-archive-discovery.patch)

A fresh wallet-free profile using the 22-patch release binary, SHA256 `b8804b68ff1a1827155d3450193c36275442006864a30d85d69c414cdf1f8832`, supplied no peers or anchors and kept DNS, script checks and historical replay enabled. Its only network injection was a metered SOCKS relay that allowed public peers and the native DNS-over-HTTPS destination. It automatically connected to `1.231.31.3:8333`, installed the checkpoint at 293.47 seconds and validated its successor at 328.38 seconds. It reached **943,884 validated**, with headers at 974,747, before a prolonged foreground stall. The trial stopped cleanly after 4,154.19 seconds with historical replay at 189,607, 14,198,986,850 bytes received and 199,168,000 allocated node bytes. Wallet readiness stayed false.

An independent audit matched the saved height-943,013 state to utreexod v0.6.0's published snapshot: the block hash, all 18 roots and 3,082,565,786 leaves agreed. The checkpoint stayed at 939,969. Both public archives promptly served the next stalled block, 943,885. Native decoding, all 3,738 transaction script checks and the accumulator update passed offline against the captured prior state, matching the independent Go implementation's 20 resulting roots. Altered signatures and proof siblings were rejected. The evidence supports a networking investigation rather than a missing proof or invalid block. [Published snapshot](https://github.com/utreexo/utreexod/blob/fe71f3d9282ef0812f7f6087f0c0df9ce0fda508/chaincfg/params.go#L397-L430)

The 24-patch candidate corrects two independently reproduced networking defects: a body retry can choose the same timed-out peer, and the pinned encrypted transport can spin on a closed stream. Its macOS arm64 release binary has SHA256 `188e2f3b8a39f2592f0585c0179b5fd108ffbe8c9fde98304e4654c3723c99a2`. It passed all 142 native tests, 38 targeted desktop tests and 14 qualification tests. The controlled shared-host fixture with stale seed flags and empty anchors also validated all 392 regtest blocks, with every body and proof request sent to the intended service. [Networking reproductions](floresta-upstream-bugs.md#a-body-timeout-can-select-the-same-unresponsive-full-peer)

Its fresh mainnet trial discovered the archive during header synchronization and advanced through 943,009, but historical replay stayed at genesis. The independent backfill worker had copied that archive's `Connected` address state despite starting with no peer connections. The 25th patch resets only those inherited connection states in both backfill constructors; ordinary cloning, bans, failed-peer cooldowns and endpoint metadata remain intact. The optimized macOS arm64 candidate has SHA256 `1376b7a3aa281cc2b2cf6b520613fc1180f218a4a7df5fc31fa365f745a87585` and passed all 143 native tests, 38 targeted desktop tests and 14 qualification tests. A new empty-profile run is qualifying continuous foreground validation through 974,730 with historical replay enabled. [Backfill discovery reproduction](floresta-upstream-bugs.md#a-backfill-node-can-inherit-another-nodes-connected-state)

### Can Chicory use a Floresta maintainer's bridge?

Yes. Chicory can fetch public block proofs from a compatible bridge and verify them locally against the pinned accumulator. The bridge needs proofs covering the next block Chicory must validate. The two peers that answered the earlier control advertised service value 6152 (Utreexo, v2 transport and witness). Neither advertised historical proof service. Castor retains proofs for blocks it processes after its bootstrap height. [Utreexo service bits](https://github.com/utreexo/biptreexo/blob/917bdf3d344e69bfe387af5c0d761c93a91bbd95/bip-0183.md#service-bits), [Castor proof storage](https://github.com/getfloresta/castor/blob/20a5eed172c53d13e6f8999d1b5a377fc462052a/README.md#sequential-steady-state)

Floresta contributor Luís Schwab identifies his mainnet bridge at `195.26.240.213:8433`. Port 8333 on that IP belongs to Bitcoin Core. The DNS-seed trial above used only port 8333. A separate operator reported syncing past the same checkpoint in May using `45.77.242.77:8333`. [Bridge operator's port confirmation](https://github.com/getfloresta/Floresta/issues/971#issuecomment-4284241912), [operator's May sync](https://indianboy.sh/blog/floresta-mainnet-journey)

On November 5, 2026, a separate wallet-free check tried both published endpoints for block 939,970. The maintainer's port accepted TCP, but neither Bitcoin transport completed a version handshake. The May endpoint timed out while connecting. The check finished in 6.04 seconds with 174 application bytes sent and zero received. Both attempts ended before a proof request could be sent. Historical coverage at either endpoint remains unknown. The preview continues peer discovery and local verification without giving either endpoint special trust.

A separate regtest exercised this arrangement with a reachable archive. One service supplied ordinary blocks. A second advertised only archival proofs and v2 transport. Both drew from the same independently mined chain. The first routing attempt reached header 392 but validated zero blocks because it repeatedly tried to use the ordinary peers for proofs. After correcting selection, the node validated all 392 blocks. For a spend at height 102, it fetched the block from the ordinary service and a six-hash proof with one spent output from the archive. Neither service received a request for the other service's data. Every connection in this test was confined to loopback.

The macOS arm64 release build of the 21-patch series has SHA256 `b91e16f69f9721a7dc6b3d834b32825c1c1eb7a967bfd0b485d8921bfb9dc952`. The build from the pinned release archive passed 132 native tests. The fork and both peer-selection reproductions are available for review. [Floresta fork](https://github.com/coreyphillips/Floresta/pull/1), [archive proof routing and bridge ports](floresta-upstream-bugs.md#an-archive-only-peer-can-be-skipped-for-a-historical-block-proof)

## Before a wallet can switch

The release keeps the selected Electrum backend until all of the following
wallet-serving gates have evidence.

| Gate | Evidence still needed |
| --- | --- |
| Peer transactions and fees | A way to identify compatible public proof peers, receive funding and conflicts through disconnects, qualify delivery on those peers, and provide usable fee estimates or an explicit unavailable result. The private regtest bridge can prove only the transactions it observes. |
| Automatic handoff and fallback consent | A durable engine admission check that covers payments, peer-initiated channel changes, splices, closes and recovery. Switch only at a safe lifecycle point, verify refresh and subscriptions, and honor external-server permission across failure and restart. |
| Channel recovery | Qualify a live local wallet handoff through recovery. The funded recovery wallets used external Electrs. Independent Core checks and cold native replay covered guardian and peer-storage restore, stale backups, unilateral close, the outgoing HTLC timeout, incoming HTLC preimage recovery, final CSV sweeps and the two-input breach remedy. [Incoming preimage recovery](floresta-beignet.md#funded-incoming-htlc-preimage-recovery) |
| Distribution | Per-platform signed artifacts, installation checks, upgrade and rollback rules, and storage behavior on every supported filesystem. The macOS developer preview uses an ad hoc signature. |
| Mainnet operation | Qualify historical checkpoint replay on mainnet and measure sustained sync, bandwidth, disk growth and recovery there. The supplied-peer trial survived an archive outage, and automatic cold discovery validated 3,915 blocks beyond the checkpoint. The corrected networking candidate is qualifying continuous sync to a recorded tip. Pruned-peer fallback and time to serve a fresh wallet still need qualification. |

[Floresta source contract](floresta-upstream.md) · [Beignet calls and Lightning dependencies](floresta-beignet.md)
