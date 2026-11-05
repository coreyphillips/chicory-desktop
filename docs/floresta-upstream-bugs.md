# Floresta v0.9.1 returns the wrong spendable outpoint and misses pending funding on regtest

A watched output worth 50,000 sats was at index 2 in its transaction. Floresta returned index 1, the transaction's position in its block. Its Merkle proof correctly identified position 1. A wallet trusting both replies would verify the right transaction and construct an input spending the wrong output. We also reproduced issues with incoming unconfirmed funds, verbose lookups, fee estimates and the control listener. These results apply to the release commit below.

## Reproduce with disposable data

* **Node:** Floresta `v0.9.1`, commit `bc2db8d07e72651f9981ce589c5688f4d575dc7a`. macOS arm64, Rust 1.99.1, Cargo dev profile, locked dependencies and default features including JSON-RPC and compact filters. The binary's SHA-256 was `70ebeeafb19292890f113ba8ee645e2f26445ef46b0a59ca25cd03184e8f354f`. The Electrum service identified itself as `Floresta 0.5.1`, protocol `1.4`. [Floresta release][release]
* **Independent proof peer:** `utreexod` v0.6.0 with its Utreexo proof index, compact filters and pruning disabled for blocks (`--prune=0`). The macOS arm64 executable's SHA-256 was `b24a5520135c03d8e8740fa72389acb99e2b4f62a6615d238c7b949b15cdbdb2`. [Proof peer release][peer]

Build Floresta at the commit above with `cargo build --locked --bin florestad`. Obtain the proof peer from its release and verify the published archive digest. With Node 24.22.1, run the pinned reproducer:

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
| Submit T **only on the proof peer**. Verify T with the peer's `getrawmempool` and wait 10 seconds with peer trickle interval 100 ms. Before mining, query `scripthash.get_history`, `get_mempool`, `get_balance`, `listunspent` under the `blockchain` namespace and `blockchain.transaction.get(T,false)`. | Pending history had zero entries. The mempool query missed T, `listunspent` had no output for T, the unconfirmed balance check failed and raw lookup returned `-32000`. The same watch found T after confirmation. Separately, source inspection shows `get_mempool` always returns `[]` and `get_balance` hardcodes unconfirmed to zero. | When T has entered the node's local mempool, expose T at height 0, outpoint `T:2` and an unconfirmed credit of 50,000 sats. Expose limited mempool coverage explicitly if the node cannot observe incoming spends. Incoming channel funding can otherwise disappear from a wallet's view until confirmation. The lab verified the peer's mempool, not the delivery of an individual P2P announcement. [Mempool handlers][utxos] · [Fixture timing][lab] |
| After confirmation, send `blockchain.transaction.get(T,false)` and a one-element batch containing `blockchain.transaction.get(T,true)`. | Raw mode matched the mined transaction. Verbose mode failed the decoded `txid` and `hex` check. The release handler reads only the txid argument and returns cached hex for both calls. | Honor `verbose=true` with a decoded object including inputs, outputs and confirmation data, or signal unsupported verbosity. Beignet uses decoded inputs and outputs to resolve funding and spends. [Transaction handler][tx] · [Verbose result contract][verbose-spec] |
| Query `blockchain.estimatefee` with block targets 2, 6, 24 and 144. | All four calls returned `0.0001` BTC/kB. Equal estimates alone can be valid. The release source returns that literal for every request, independent of chain conditions. | Return a supported estimate for the target, or `-1` when insufficient data is available. A wallet may otherwise present and apply a static rate as current fee information. [Fee handler][fees] · [Fee result contract][fee-spec] |
| Query `blockchain.scripthash.get_balance` for the unregistered hash `77ca78f9a84b48041ad71f7cc6ff6c33460c25f0cb99f558f9813ed9e63727dd`. | The report records `numericBalance: false`. The release serializes a missing cached balance as `confirmed: null` with `unconfirmed: 0`. Beignet's startup liveness check accepts this reply. | For a known, fully scanned script, return amounts in satoshis. For an unknown or unscanned script, supply an explicit error or separate coverage signal enabling a client to distinguish it from a funded or genuinely empty wallet. [Balance handler][balance] |

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
* Backfill runs separately from current-tip synchronization. A public success or failure signal tied to the verified assumed state would allow downstream consumers to enforce a handoff policy. Funding reorgs, replacements, old channel restoration, HTLC claims and breach remedies still require independent funded tests. [Backfill worker][backfill]

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
