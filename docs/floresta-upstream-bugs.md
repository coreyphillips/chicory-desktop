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
* The selected peer **can** supply a dedicated `utreexotx` message containing a transaction, Utreexo proof and input leaf data. Its witness-capable `getdata` path supports requests for specific proof positions. A receiver must reconstruct input leaf hashes for the active chain, verify the proof against its local accumulator and handle unconfirmed parents, conflicts and changes of tip before publishing a coherent wallet view. This capability was identified in peer source. The lab observed the release handshake and mempool behavior, on the connection. Proof-carrying transaction exchange remains an implementation dependency. [Peer message][peer-tx] · [Proof request][peer-get] · [Peer validation][peer-verify] · [Floresta roadmap][roadmap]

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
