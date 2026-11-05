# Floresta compatibility lab

The source checkout can run a verified Floresta candidate from Settings, register
public Beignet wallet and channel watches, and scan confirmed history. The
candidate is a separate process with a private data directory. The selected
Electrum server still serves the wallet and Lightning. Stock v0.9.1 misses
peer-originated unconfirmed activity and can retain history after a reorg.
[Issue 33](https://github.com/coreyphillips/chicory-desktop/issues/33) ·
[Floresta bug report for review](floresta-upstream-bugs.md)

## Run the candidate from Settings

1. Prepare the regular desktop runtime with `npm run runtime:prepare`.
2. Build the pinned Floresta archive with the reviewed patches. Install Cargo,
   CMake, a C++ compiler, libclang and Boost headers with CMake package metadata.
   The macOS arm64 test used Rust 1.99.1, CMake 4.2.3 and Boost 1.85.
   Run `npm run runtime:prepare:floresta -- --debug`. To reuse an existing
   archive, pass `--archive /absolute/path/to/floresta-source.tgz`.
   The recipe verifies the archive and pristine Cargo lock, applies the listed
   patches and records their hashes alongside the digest of the built binary.
3. Set `CHICORY_FLORESTA_CANDIDATE_SHA256` to the digest in the output
   directory name, then run `npm run dev`. Open **Settings > Network & servers >
   Experimental Floresta node**. Select the network and storage folder and
   confirm the start. Use a disposable regtest profile for qualification.
   The source build rechecks the candidate against that digest before spawning
   it. Packaged releases omit this control and executable.
4. Use **Stop** to stop syncing and preserve the local data. Opting in authorizes
   direct Bitcoin P2P connections and storage of public wallet and channel
   history. The current external Electrum server continues to see wallet queries.
   A running node, a synced tip and a complete confirmed scan are separate
   states. Each wallet still needs mempool and recovery coverage before handoff.

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
mock keychain. The harness skipped direct funding. [Reproduce the existing wallet tests](desktop-qualification.md)

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
| Existing external Lightning backend | All desktop regtest stages ran. Seventeen checks passed, including crash during submission, offline receive, send max, drain, restart, on-chain recovery and full-backup restore. Direct funding and transport-path inspection were skipped. Seed-only Lightning recovery is unsupported. |

One 102-block run on an Apple M5 Pro with 64 GiB RAM took 32.1 seconds to
reach the tip and 2.0 seconds to catch up two wallet scans on loopback. The
debug binary was 59,207,640 bytes. These measurements describe that regtest
fixture. Sustained mainnet sync, peak disk use, peer diversity and historical
recovery require their own runs.

## Before a wallet can switch

The candidate's confirmed index passes the funded checks above. The remaining
wallet-serving gates include proof-validated pending transactions and replacement
notifications, historical parent availability, completed backfill, a safe live
Lightning transition, and cold channel/guardian recovery. Production signing,
platform qualification and sustained mainnet measurements also remain open.
[Floresta source contract](floresta-upstream.md) · [Beignet calls and Lightning dependencies](floresta-beignet.md)
