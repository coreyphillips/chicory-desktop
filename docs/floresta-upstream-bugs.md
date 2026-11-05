# Floresta v0.9.1 returns the wrong spendable outpoint and misses pending funding on regtest

A watched output worth 50,000 sats was at index 2 in its transaction. Floresta returned index 1, the transaction's position in its block. Its Merkle proof correctly identified position 1. A wallet trusting both replies would verify the right transaction and construct an input spending the wrong output. We also reproduced issues with incoming unconfirmed funds, verbose lookups, fee estimates and the control listener. These results apply to the release commit below. The development branch already corrects the output index. A backport or a release containing that fix would let us rerun the funding test.

## Reproduce with disposable data

* The node was Floresta `v0.9.1`, commit `bc2db8d07e72651f9981ce589c5688f4d575dc7a`. macOS arm64, Rust 1.99.1, Cargo dev profile, locked dependencies and default features including JSON-RPC and compact filters. The binary's SHA-256 was `70ebeeafb19292890f113ba8ee645e2f26445ef46b0a59ca25cd03184e8f354f`. The Electrum service identified itself as `Floresta 0.5.1`, protocol `1.4`. [Floresta release][release]
* The independent proof peer was `utreexod` v0.6.0 with `--utreexoproofindex --cfilters --prune=0`. The macOS arm64 executable's SHA-256 was `b24a5520135c03d8e8740fa72389acb99e2b4f62a6615d238c7b949b15cdbdb2`. [Proof peer release][peer]

Build Floresta at the commit above with `cargo build --locked --bin florestad`. Obtain the proof peer from its release and verify the published archive digest. Run the pinned reproducer with Node 24.22.1.

```sh
git clone https://github.com/coreyphillips/chicory-desktop.git
cd chicory-desktop
git checkout --detach 5ea634f2098125c7fae532e85bad4dd74a76b342
npm --prefix server ci
npm run --silent qualify:floresta -- \
  --florestad /absolute/path/to/florestad \
  --utreexod /absolute/path/to/utreexod > floresta-report.json
```

Expect exit code 1 and a JSON report containing `pending.rows` and `confirmed.rows`. The runner creates fresh data directories, checks regtest genesis, registers one public destination at startup and syncs 101 blocks. The proof peer spends its first mature coinbase, paying the watched script in output 2. Outputs 0 and 1 pay the miner. The peer accepts the spend into its mempool, waits for the pending probe and mines it in position 1 of block 102. The confirmed probe waits for both nodes to agree on that block. Addresses, transactions and hashes are fresh on each run. [Fixture producer][lab] · [Electrum probes][probe]

The recorded run produced txid `8be90ccda5b5c2d1493af5e2c1fcdcbd9477e9f33b9d7d842cb20eadd5687be2` in block `364852f27c46336060293e4143f612dc96c2f650c067d60a5e4e3467562e8225`. In the requests below, **T** is the new run's funding txid, **H** is the Electrum scripthash of output 2 and **P** is the txid in the first input's prevout. All Electrum calls use protocol 1.4.

## Reproduced Electrum issues

| Request and timing | Observed on the pinned release | Expected behavior and wallet impact |
| --- | --- | --- |
| After confirmation, call `blockchain.scripthash.listunspent(H)`. Decode transaction T and compare output indices. | Returned `tx_pos: 1` for T. Output 1 paid the miner 1,000 sats. Output 2 paid the watched script 50,000 sats. At the same time, `get_history`, `get_balance`, raw transaction retrieval and the Merkle check agreed with the independent block. | Return `tx_pos: 2` for the watched output. The client needs the exact outpoint for coin selection and spend monitoring. The handler has the outpoint available as `prevout` but reads the transaction's block position. [UTXO handler][utxos] · [Protocol][list-spec] |
| Submit T **only on the proof peer**. Verify T with the peer's `getrawmempool` and wait 10 seconds with peer trickle interval 100 ms. Before mining, call `get_history(H)`, `get_mempool(H)`, `get_balance(H)` and `listunspent(H)` in the `blockchain.scripthash` namespace and `blockchain.transaction.get(T,false)`. | Pending history had zero entries. The mempool query missed T, `listunspent` had no output for T, the unconfirmed balance check failed and raw lookup returned `-32000`. The same watch found T after confirmation. Separately, source inspection shows `get_mempool` always returns `[]` and `get_balance` hardcodes unconfirmed to zero. | When T has entered the node's local mempool, expose T at height 0, outpoint `T:2` and an unconfirmed credit of 50,000 sats. Expose limited mempool coverage explicitly if the node cannot observe incoming spends. Incoming channel funding can otherwise disappear from a wallet's view until confirmation. The lab verified the peer's mempool, not the delivery of an individual P2P announcement. [Mempool handlers][utxos] · [Fixture timing][lab] |
| After confirmation, send `blockchain.transaction.get(T,false)` and a one-element batch containing `blockchain.transaction.get(T,true)`. | Raw mode matched the mined transaction. Verbose mode failed the decoded `txid` and `hex` check. The release handler reads only the txid argument and returns cached hex for both calls. | Honor `verbose=true` with a decoded object including inputs, outputs and confirmation data, or signal unsupported verbosity. Beignet uses decoded inputs and outputs to resolve funding and spends. [Transaction handler][tx] · [Verbose result contract][verbose-spec] |
| Query `blockchain.estimatefee` with block targets 2, 6, 24 and 144. | All four calls returned `0.0001` BTC/kB. Equal estimates alone can be valid. The release source returns that literal for every request, independent of chain conditions. | Return a supported estimate for the target, or `-1` when insufficient data is available. A wallet may otherwise present and apply a static rate as current fee information. [Fee handler][fees] · [Fee result contract][fee-spec] |
| Query `blockchain.scripthash.get_balance` for the unregistered hash `77ca78f9a84b48041ad71f7cc6ff6c33460c25f0cb99f558f9813ed9e63727dd`. | The report records `numericBalance: false`. The release serializes a missing cached balance as `confirmed: null` with `unconfirmed: 0`. Beignet's startup liveness check accepts this reply. | For a known, fully scanned script, return amounts in satoshis. For an unknown or unscanned script, supply an explicit error or separate coverage signal enabling a client to distinguish it from a funded or genuinely empty wallet. [Balance handler][balance] |

## Confirmed funding survives in the selective index after a conflicting reorg

A second run of unmodified v0.9.1 used the same build settings and proof peer. Start from the fixture at block 102 and use the coinbase from height 2 as the common input for all three spends below. Each spends with sequence `0xfffffffd`, pays the watched script at output 2 and returns change to the miner.

1. Submit a spend paying 33,000 sats with a 1,000 sat fee, then replace it with a spend paying 31,000 sats with a 4,000 sat fee. The peer's mempool contained the replacement alone and rejected a repeat submission of the original. Floresta omitted both pending transactions from the corresponding history snapshots.
2. Mine one block. Wait until Floresta follows that validated tip at height 103 and can return the confirmed replacement in history and a Merkle proof. In this run its txid was `8fd3a743aed7bfbe79ff45a5163310d687720e236030899444734072b8f73b04` and the block hash was `38eb76167e82ba6590a70f3afbca19bc7a5bff9f8729fe48e174d2a6cff77ffb`.
3. Call `invalidateblock` on that hash **on the mining peer**. Submit a conflicting spend of the same input paying 23,000 sats with an 8,000 sat fee. Mine two blocks. Verify that the replacement height-103 block contains this spend and that Floresta follows the peer's validated tip at height 104.
4. Query history, balance and UTXOs for H, followed by `blockchain.transaction.get_merkle(detached_txid,103)`. Floresta returned three confirmed history entries where two were active. The balance disagreed with the active outputs. It returned a proof for the detached transaction even though its own height-103 header now belonged to block `755c8580cc3099a9a6bd54889de3bd5e329e54cbec12835c43dcfce93df9c8b4`. The active transaction's Merkle proof passed independently.

Expected history includes only the original 50,000 sat funding and the winning 23,000 sat spend, for 73,000 sats total. A request for the detached transaction's proof at height 103 should fail. Channel monitoring must be able to distinguish replacement funding and displaced confirmations. [Release proof handler][tx] · [Extended reproducer][extended]

## Transaction relay and proof capability

In the second run, Floresta identified its peer as `/btcwire:0.5.0/utreexod:0.6.0/` with `NETWORK|BLOOM|WITNESS|COMPACT_FILTERS|NETWORK_LIMITED|P2P_V2|0x3000`. On that same connection the proof peer reported `subver: /Floresta:0.9.1/`, `services: 00006152` and `relaytxes: false`. These observations are reproducible with `getpeerinfo` on both nodes.

* The release's version handshake disables transaction relay, its peer handler drops transaction announcements, and received transactions satisfy outstanding by-txid requests. Its mempool admission function performs context-free checks and assumes input inclusion proofs have already been validated. The development branch also sets relay to false. [Release handshake][relay] · [Inventory handling][inv] · [Received transactions][recv] · [Mempool admission][accept] · [Development handshake][dev-relay]
* The selected peer **can** supply a dedicated `utreexotx` message containing a transaction, Utreexo proof and input leaf data. Its witness-capable `getdata` path supports requests for specific proof positions. A receiver must reconstruct input leaf hashes for the active chain, verify the proof against its local accumulator and handle unconfirmed parents, conflicts and changes of tip before publishing a coherent wallet view. This capability was identified in peer source. The lab observed the release handshake and mempool behavior, on the connection. The managed candidate now tests proof-carrying transaction exchange on an explicitly configured loopback regtest peer. Public peer coverage remains a release dependency. [Peer message][peer-tx] · [Proof request][peer-get] · [Peer validation][peer-verify] · [Floresta roadmap][roadmap]

## Control listener

On the owned loopback control listener, the lab sent the following read-only request without credentials. `RPC_PORT` denotes the port belonging to the temporary Floresta instance.

```sh
curl -i "http://127.0.0.1:${RPC_PORT}/" \
  -H 'Origin: https://example.invalid' -H 'Content-Type: text/plain' \
  --data '{"jsonrpc":"1.0","method":"getblockchaininfo","params":[],"id":2}'
```

**Observed.** HTTP 200 and the independently verified current best block. The handler accepts request bytes without a credential, and the same router dispatches control methods including `stop`. Only `getblockchaininfo` was exercised in this check. The Origin header was supplied by an HTTP client. Browser policy and the ability of browser JavaScript to read the response were outside the test. [HTTP handler][rpc] · [Router][router]

**Requested behavior.** Provide a supported authenticated control transport suitable for a desktop application on a shared machine. Reject unauthorized requests before method execution. Bind control to loopback or an OS-protected private endpoint and cover unauthorized local clients and browser-origin requests in tests. This is a deployment security requirement even when a browser cannot read a response.

## Observed selective-history and client compatibility limits

* **Known parent missing from the selective cache.** With T confirmed, query `blockchain.transaction.get(P,false)` and `(P,true)`. P is the coinbase in block 1 from the independent peer. The miner's script is deliberately outside the watch set. Both requests returned `-32000`, although Floresta could return T. A wallet resolving T's input needs the verified parent bytes or an explicit indication that additional history must be fetched. This is a historical retrieval requirement for selective nodes. The run used recent blocks, not a pruned, years-old channel. [Cache lookup][tx]
* **Ambiguous missing-transaction error.** Send `blockchain.transaction.get` in a batch for the all-zero txid with `verbose=true`. The error failed Beignet's missing-transaction classification. The arbitrary wording of a server error is a fragile client dependency. A stable distinction between an unknown txid, unavailable history and malformed parameters would let clients recover appropriately. `blockchain.transaction.broadcast("00")` independently returned an RPC error (`-32000`), which is a valid rejection of malformed input and is not a separate defect. [Probe][probe] · [Pinned client call map][beignet]

## Source findings to test separately

* The release's scripthash subscription map stores one client per hash. Test overlapping subscriptions, then disconnect one client and reconnect it while the other still watches a funded script. [Subscription handler][utxos]
* `loaddescriptor` takes the last expanded descriptor branch for its initial range. `rescanblockchain` acknowledges starting a task, and the worker continues past an unavailable block matching the filters. A selective wallet needs durable, range- and block-hash-specific completion or an explicit incomplete result. Test multipath descriptors, interrupted scans, unavailable old blocks, and reorgs before using pending scans to make recovery decisions. [Descriptor handling][register] · [Rescan worker][scan]
* **Backfill checkpoint durability.** Backfill runs separately from current-tip synchronization. In v0.9.1 an empty `.sync_node_state` file stops backfill. A short nonempty file is sliced using `len() - 8` without a prior length check. Completion empties the file before the loop marking blocks valid in the outer chain. A truncated checkpoint or a crash between those writes could therefore misstate progress or interrupt startup. These are source-level recovery risks, pending fault-injection tests. A public success or failure signal tied to the verified assumed state would allow downstream consumers to enforce a handoff policy. Funding reorgs, replacements, old channel restoration, HTLC claims and breach remedies still require independent funded tests. [Backfill worker][backfill]

* **Backfill validation policy.** The partial chain is given a starting accumulator and an ending height. At completion we found a check for block-validation errors but no comparison of the reconstructed leaves and roots with the originally assumed accumulator. In the release, `get_partial_chain` constructs its verifier with `assume_valid: false`, which the partial verifier passes directly as `verify_script`. The consensus implementation calls the script verifier only when that argument is true. This merits tests with a deliberately wrong assumed stump and a historical invalid signature on an otherwise valid test chain. The live regtest did not exercise either case. An integration reporting independent historical verification needs an explicit result for both checks. [Partial-chain initialization][partial-create] · [Validation flags][partial-scripts] · [Consensus checks][consensus-scripts] · [Backfill completion][backfill]

## Historical accumulator persistence

Both cases use Floresta v0.9.1 at `bc2db8d07e72651f9981ce589c5688f4d575dc7a` and the flat chain store. The following method-level cases isolate upstream behavior from the additional downstream replay harness. The executable regression is named `replay_preserves_persisted_stump_at_the_selected_block`. Its two assertions can be run against stock by copying just that test into the existing `chain_state.rs` test module. Run `cargo test --locked -p floresta-chain --features bitcoinkernel,flat-chainstore replay_preserves_persisted_stump`. [Downstream test and fixes][backfill-patch]

1. **Promoting an already verified block loses its persisted accumulator.** Open a fresh regtest chain store, accept and connect the first non-genesis block from the release's `crates/floresta-chain/testdata/blocks.txt`, and save its nonempty in-memory stump. Call `mark_block_as_valid(block_hash)`, then read `get_roots_for_block(1)`. Expected the saved stump. The header update resets both the accumulator file offset and length. The subsequent read returns `None`. In a funded downstream run we exercised the same upstream store by completing a background replay through block 102, stopping the daemon, truncating only the downstream replay marker and reopening the same store. Independent replay reconstructed 105 leaves and four roots at the identical active block hash. The persisted foreground state contained zero leaves and zero roots. This can prevent a restarted node from verifying subsequent proofs. The downstream fix preserves already-verified headers and checks the active hash under the write lock before promotion. The development snapshot still rewrites the header and initializes both storage fields to zero. [Release promotion][mark-valid] · [Release header rewrite][flat-rewrite] · [Release startup][load-stump] · [Development promotion][dev-mark] · [Development store][dev-flat]
2. **Assuming a non-genesis checkpoint stores its accumulator at genesis.** On a second fresh store accept the same block's header, then call `mark_chain_as_assumed(nonempty_stump, block_hash)`. The first test case supplies the actual stump for this block. Expected the validation index and persisted stump to reference height 1, and the genesis stump to remain empty. In v0.9.1 the ancestry loop stops at genesis and passes that final header to `update_view`, then sets the in-memory validation index to height 1. Inspect the two accumulator records, flush, and reopen before connecting another block. Startup looks up the accumulator at height 1, where the assumed stump was never saved. The downstream fix passes the original assumed header into `update_view`. The development snapshot already uses the original assumed header. This case supports a release backport. [Release assumption][assume-state] · [Release startup][load-stump] · [Development fix][dev-mark]

## Reading the validation index while a chain reorganizes

The v0.9.1 flat chain store exposes a short interval when the old validated block is already marked `InFork` but the best-chain record still points to it. A concurrent `get_validation_index()` returns `BadValidationIndex`. A caller monitoring the chain needs to distinguish an ongoing fork transition from a permanent storage failure. [Release reorg sequence][chain-reorg] · [Release validation index][chain-index]

Use the two branches in `crates/floresta-chain/testdata/test_reorg.json` with a fresh regtest flat store. Connect the first ten blocks. Retain the competing branch's first five headers, which also reach height 10. Verify the old chain reports height 10 and validation height 10. Run `mark_chain_as_inactive` on the old tip down to the common ancestor at height 5, exactly as the reorg worker does. Before `change_active_chain` runs, the old best height still reads 10 and a concurrent validation-index query returns the error above. Finish the switch and the new header tip reads 10 with validated height 5. The regression exercises this schedule deterministically. [Downstream test][chain-read-fix]

The downstream heartbeat previously stopped polling after any index error, and its background scanner could stop the daemon. The downstream fix reads the header tip, validated header, indexed hashes and IBD flag under one read lock, withholds inconsistent observations, and retries. An earlier funded run lost its watch connection during a reorg. Its report did not capture the native exit reason, so the deterministic test establishes the reader hazard separately. The development snapshot also updates the individual header records before publishing the new best chain and still returns `BadValidationIndex` for an `InFork` validated header. [Development reorg][dev-reorg] · [Development index][dev-index]

Run the regression on the Floresta review branch:

```sh
cargo test --locked -p floresta-chain --features flat-chainstore --lib active_chain_status_retries_a_reorg_between_disk_and_tip_updates
```

## Chain-store flushes can delay chain observations

On macOS arm64 with the v0.9.1 debug build, a local regtest peer supplied blocks
to a caught-up managed node. The native chain-status timer normally fired every
two seconds. During individual post-sync block updates at heights 102 and 103,
observed intervals reached 6.9 and 7.8 seconds. Independent process stack
samples during these intervals showed `do_flush` computing the XXH3 checksum
over the header, index and fork-header memory maps while other workers waited
for the chain read lock. The generated store used sparse preallocated files.

For a maintainer reproduction, run the funded fork fixture, timestamp native
status output before the desktop processes it and take a process stack sample
during a gap. Compare a debug build and an optimized build on the same volume.
The lost connection in the earlier debug run was reproduced and timed: the
supervisor reached its 15-second deadline 86 ms before the next valid height
104 status. In a later comparison using the same funded fork fixture, the
largest interval during the fork was 13.96 seconds in debug and 2.00 seconds
in an optimized build. The filing question is whether a
durable post-sync block commit can keep chain readers responsive while retaining
the on-disk integrity checks. [Release checksum computation](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/flat_chain_store.rs#L789-L806)

## Mainnet and signet share 215 fixed peer records

The v0.9.1 mainnet file contains 222 distinct address and port pairs. The signet file contains 220. Exactly 215 records appear in both, including the same port (38333), service bits, last-connected time and state. The same records are present on development commit `be2574fc`. The seven mainnet-only entries advertise Utreexo service on port 8333 or 8433. These counts describe the bundled lists. Current peer availability requires separate measurement. [Pinned mainnet list](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/seeds/mainnet_seeds.json) · [Pinned signet list](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/seeds/signet_seeds.json) · [Development seed files](https://github.com/getfloresta/Floresta/tree/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-wire/seeds)

The downstream patch removes the exact duplicates from mainnet and includes the Utreexo DNS seed from upstream PR 1094. Its native test uses Floresta's own address parser and compares both the address and port. It fails on the release data and passes with the corrected list. A separate in-memory transport test rejected a signet-magic header on a mainnet connection. Neither test dials a public peer. [Upstream DNS seed change](https://github.com/getfloresta/Floresta/pull/1094) · [Development chain parameters](https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-chain/src/pruned_utreexo/chainparams.rs)

Upstream issue 971 covered the reachability and advertised services of the seven Utreexo seed entries. Its closing comment records that a bridge was running again. PR 1287 added a signet DNS seed. The 215 identical static records persisted after both changes. [Issue 971](https://github.com/getfloresta/Floresta/issues/971) · [Signet seed PR 1287](https://github.com/getfloresta/Floresta/pull/1287)

## Proof-only peers and raw block providers have different capabilities

Floresta v0.9.1 requires both witness and limited block service before it keeps a gossiped or restored address. It repeats this check after the peer reports its actual services. Castor advertises witness, P2PV2 and Utreexo, serves indexed BIP183 block proofs, and replies `notfound` to raw block requests. A proof-seed lookup temporarily assigns the limited block flag, so the DNS and gossip paths can behave differently for the same peer. [Release address manager](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/address_man.rs) · [Castor's serving contract](https://github.com/getfloresta/castor/blob/20a5eed172c53d13e6f8999d1b5a377fc462052a/src/node.rs#L1562-L1634)

The foreground block downloader already asks block-serving peers for bodies and Utreexo peers for proofs. The node interface used by the historical scanner sends both requests without a service requirement in the release and on development commit `be2574fc`. The downstream regression gives the node a separate channel for each role. It verifies dispatch to the correct channel with both roles available, and refusal to send a request when only the opposite role is present. Address tests cover discovery, persisted data and changed service flags. A proof provider must also retain the requested height. [Release block downloader](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/blocks.rs) · [Development node interface](https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-wire/src/p2p_wire/node/user_req.rs) · [Development address manager](https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-wire/src/p2p_wire/address_man.rs)

Open upstream issue 1419 covers the handshake removal and `peers.json` reload. In the candidate, gossiped addresses begin as untried candidates. A successful version handshake supplies the connected peer's service flags, and the node verifies every block proof it uses. [Proof peer reload issue 1419](https://github.com/getfloresta/Floresta/issues/1419)

## Connected proof peer anchors can be lost at shutdown

Floresta v0.9.1 tries to save the connected Utreexo peers in `anchors.json` for the next startup. The shutdown path passes connection IDs such as `0` and `1` into the address book, which keys records by a separate, randomly assigned address ID. When those IDs differ, the lookup misses and the node writes an empty list even with an active proof peer. The broader `peers.json` dump uses its own address-book enumeration. A restart can still find peers there, through configured addresses or through discovery. [Release shutdown path](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/peer_man.rs#L708-L730) · [Release file writers](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/address_man.rs#L722-L751)

An offline native experiment gave one ready `WITNESS | UTREEXO` peer connection ID `1` and address ID `0x1234`. The real shutdown path wrote `[]` to `anchors.json`. A new address manager restored that peer's address, proof service and port from `peers.json`. This isolates the loss to the preferred reconnect list in this case. The bounded public trial started with fresh data, so public warm-reconnect timing remains unmeasured.

Upstream reproduced this in issue 1277 and merged PR 1329 on October 13, 2026, after the April 27 v0.9.1 release. It writes eligible connected address records directly and tests a save and reload. The 18-patch preview keeps the release's anchor writer. [Upstream issue 1277](https://github.com/getfloresta/Floresta/issues/1277) · [Fix at commit 271e588](https://github.com/getfloresta/Floresta/commit/271e5883cfa96f19bc7f66fa0f05546750f23db7) · [Release v0.9.1](https://github.com/getfloresta/Floresta/releases/tag/v0.9.1)

## SOCKS5 peer addresses in the pinned release

A local duplex test captured the SOCKS5 greeting and CONNECT frame from v0.9.1.
The IPv4 request passed. An IPv6 target and a domain both sent address type
`01` (IPv4) ahead of their longer payloads. Closing the proxy before the
greeting caused a panic. The release's peer-address adapter also passed raw
BIP155 Tor and I2P bytes to the proxy as a domain. [Release handshake](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/socks.rs) · [Release peer adapter](https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/transport.rs)

The downstream fixture checks exact CONNECT bytes for IPv4, IPv6 and domain
names, including synthetic Tor v3 and I2P names reconstructed from BIP155
records. It covers valid and invalid domain lengths, a closed proxy and a
refused request. All connections use in-memory test streams. Upstream already
fixed the address type, greeting error and Tor v3 conversion on its
development branch. [Upstream fix](https://github.com/getfloresta/Floresta/commit/a0bdfebcf4e9708f72eda3d93b7390ea72602267) · [BIP155 address encodings](https://github.com/bitcoin/bips/blob/master/bip-0155.mediawiki) · [Tor v3 checksum](https://spec.torproject.org/rend-spec/encoding-onion-addresses.html)

## Related upstream work

* The backfill script policy already has an open report. The v0.9.1 partial chain also matches only the `BlockchainError::BlockValidation` variant when handling a failed block check. The script verifier can return `BlockchainError::TransactionError`, which that condition drops. This is supplementary evidence for the existing report. [Upstream issue 1335](https://github.com/getfloresta/Floresta/issues/1335) · [Partial replay error propagation][partial-errors] · [Script failure type][script-errors]
* The mempool tracking issue covers inbound relay and proof validation. Confirmed transaction eviction has its own open issue. The funded replacement, conflict and reorg observations above provide downstream acceptance cases for those threads. [Mempool tracking issue 1303](https://github.com/getfloresta/Floresta/issues/1303) · [Eviction issue 1307](https://github.com/getfloresta/Floresta/issues/1307)
* The upstream raw-block response issue and proposed fix cover verification of peer-provided blocks before returning them to clients. That work affects historical block retrieval. The stale selective-wallet history and detached Merkle proof above are separate observations. [Upstream issue 1354](https://github.com/getfloresta/Floresta/issues/1354) · [Candidate fix 1360](https://github.com/getfloresta/Floresta/pull/1360)

## Development branch comparison

Source inspection of `be2574fc5e39a442ed3737de6b7deb825907c677` found the following differences from the tested release. The funded results above come from v0.9.1 only.

* **Outpoint fix present.** `listunspent` returns `prevout.vout`. The release report supplies a regression fixture and supports a backport request. [Development UTXO fix][dev-utxo]
* **Mempool, balance and fee responses.** `get_mempool` still returns an empty array, unconfirmed balance is zero, and the fee estimate is fixed. A missing balance remains optional in the watch cache. [Development Electrum handlers][dev-methods] · [Balance cache][dev-balance]
* **Verbose mode, parent retrieval and cache misses.** `transaction.get` still retrieves from the watch cache using only the txid argument and maps an absent entry to `InvalidParams`. [Development transaction handler][dev-tx]
* **Control RPC.** The POST handler still deserializes raw request bytes and the router accepts loopback requests without an application credential check. [Development request handler][dev-rpc] · [Development router][dev-router]
* **Additional scan and subscription tests.** Descriptor registration now derives to the wallet's current horizon, so test the multipath case again on this revision. The rescan worker still skips unsuccessful matched-block requests, and the Electrum subscription map still has one client per hash. [Development registration][dev-register] · [Development rescan][dev-scan] · [Subscription map][dev-subs]

[partial-create]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L1426-L1455
[partial-scripts]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/partial_chain.rs#L172-L202
[consensus-scripts]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/consensus.rs#L175-L236
[extended]: https://github.com/coreyphillips/chicory-desktop/blob/issue-33-floresta/scripts/qualification/floresta-lab.mjs
[relay]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/peer.rs#L800-L814
[inv]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/peer.rs#L446-L476
[recv]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/peer_man.rs#L396-L411
[accept]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-mempool/src/mempool.rs#L270-L331
[dev-relay]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-wire/src/p2p_wire/peer.rs#L892-L902
[peer-tx]: https://github.com/utreexo/utreexod/blob/fe71f3d9282ef0812f7f6087f0c0df9ce0fda508/wire/msgutreexotx.go#L13-L32
[peer-get]: https://github.com/utreexo/utreexod/blob/fe71f3d9282ef0812f7f6087f0c0df9ce0fda508/server.go#L803-L833
[peer-verify]: https://github.com/utreexo/utreexod/blob/fe71f3d9282ef0812f7f6087f0c0df9ce0fda508/blockchain/utreexoviewpoint.go#L915-L961
[roadmap]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/doc/roadmap-2026.md#L50-L55
[release]: https://github.com/getfloresta/Floresta/releases/tag/v0.9.1
[peer]: https://github.com/utreexo/utreexod/releases/tag/v0.6.0
[lab]: https://github.com/coreyphillips/chicory-desktop/blob/5ea634f2098125c7fae532e85bad4dd74a76b342/scripts/qualification/floresta-lab.mjs
[probe]: https://github.com/coreyphillips/chicory-desktop/blob/5ea634f2098125c7fae532e85bad4dd74a76b342/scripts/qualification/floresta-electrum.mjs
[beignet]: https://github.com/coreyphillips/chicory-desktop/blob/5ea634f2098125c7fae532e85bad4dd74a76b342/docs/floresta-beignet.md
[fees]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L293
[balance]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L311-L319
[utxos]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L311-L377
[tx]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L453-L507
[rpc]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L509-L540
[router]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L747-L789
[register]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L106-L193
[scan]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L584-L616
[backfill]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/running_ctx.rs#L193-L286
[list-spec]: https://electrum-protocol.readthedocs.io/en/latest/protocol-methods.html#blockchain-scripthash-listunspent
[verbose-spec]: https://electrum-protocol.readthedocs.io/en/latest/protocol-methods.html#blockchain-transaction-get
[fee-spec]: https://electrum-protocol.readthedocs.io/en/latest/protocol-methods.html#blockchain-estimatefee
[dev-utxo]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-electrum/src/electrum_protocol.rs#L363-L380
[dev-methods]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-electrum/src/electrum_protocol.rs#L319-L362
[dev-balance]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-watch-only/src/lib.rs#L703-L706
[dev-tx]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-electrum/src/electrum_protocol.rs#L504-L512
[dev-rpc]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-node/src/json_rpc/server.rs#L321-L326
[dev-router]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-node/src/json_rpc/server.rs#L384-L416
[dev-register]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-watch-only/src/lib.rs#L741-L762
[dev-scan]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-node/src/json_rpc/wallet.rs#L90-L147
[dev-subs]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-electrum/src/electrum_protocol.rs#L216

[partial-errors]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/partial_chain.rs#L137-L157
[script-errors]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/consensus.rs#L225-L278

[backfill-patch]: https://github.com/coreyphillips/chicory-desktop/blob/issue-33-floresta/build/floresta/backfill-validation.patch
[mark-valid]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L1222-L1228
[flat-rewrite]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/flat_chain_store.rs#L976-L994
[load-stump]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L754-L763
[assume-state]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L1230-L1253
[dev-mark]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L1372-L1411
[dev-flat]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-chain/src/pruned_utreexo/flat_chain_store.rs#L1073-L1091
[chain-reorg]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L440-L462
[chain-index]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L1192-L1202
[dev-reorg]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L458-L473
[dev-index]: https://github.com/getfloresta/Floresta/blob/be2574fc5e39a442ed3737de6b7deb825907c677/crates/floresta-chain/src/pruned_utreexo/chain_state.rs#L1333-L1343
[chain-read-fix]: ../build/floresta/managed-reorg-reads.patch
