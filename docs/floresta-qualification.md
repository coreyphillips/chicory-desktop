# Floresta compatibility lab

Chicory is evaluating Floresta as an optional local Bitcoin backend. The first
funded regtest run found that Floresta v0.9.1 could validate a block and prove a
transaction's inclusion while reporting the wrong output for the wallet to
spend. This blocks enabling it in Settings. Beignet continues to handle wallet
keys, Lightning channels, signing, payments and recovery through the existing
Electrum configuration. [Issue 33](https://github.com/coreyphillips/chicory-desktop/issues/33)

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

## Before a wallet can switch

The next implementation needs correct outpoints, usable unconfirmed and verbose
transaction data, historical parents and protected control access. Beignet
also needs to export the complete public watch set and acknowledge safe
lifecycle transitions. The desktop must distinguish a missing watch or failed
scan from a genuinely empty history and enforce the user's endpoint permissions
across wallet queries and fee requests. Full historical validation, completed
wallet and channel scans, and a successful refresh are prerequisites for the
initial handoff policy. Fresh-data recovery, peer outages, reorgs, platform
packaging and resource measurements remain open. [Floresta source contract](floresta-upstream.md) · [Beignet calls and Lightning dependencies](floresta-beignet.md)
