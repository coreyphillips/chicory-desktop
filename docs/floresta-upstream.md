# Floresta runtime contract

Floresta v0.9.1 has several blockers for serving a Beignet wallet. In particular, a healthy daemon can return empty history for an unregistered channel script and the wrong output index for a confirmed coin. Keep this build confined to qualification with disposable profiles.

## Pin and scope

| Item | Qualification baseline |
| --- | --- |
| Source | [v0.9.1 release](https://github.com/getfloresta/Floresta/releases/tag/v0.9.1), commit `bc2db8d07e72651f9981ce589c5688f4d575dc7a`. The release supplies source archives. It has no attached daemon binaries. |
| Build | Build the checked-out commit with `cargo build --locked --release -p florestad`. The default `json-rpc` feature enables compact filters. Electrum reports its crate version, 0.5.1. [Daemon manifest][build] and [Electrum manifest][electrum-crate]. |
| Distribution | Chicory release targets are macOS arm64 and x64, Linux x64 and Windows x64. All four need verified runtime artifacts, license notices, packaging checks and upgrade qualification before distribution. [Chicory release matrix](../.github/workflows/release.yml) and [upstream licenses][license]. |
| Networks | The intersection with Chicory is mainnet (`bitcoin`), testnet3 (`testnet`) and regtest. Start with controlled regtest. Signet and testnet4 are outside Chicory's supported set. No network is release-qualified for local wallets. [Chicory network list](../server/config.js) and [daemon network directory mapping][networks]. |
| Storage | The flat chain store uses format version 1. Separate stores hold compact filters and the watch-only wallet. Treat each network directory as private, including its transaction cache and descriptors. Upgrade tests must cover all stores before a newer binary opens an existing directory. [Chain format][store] and [store initialization][init]. |

## Electrum behavior at this pin

| Area | Observed in source | Gate for wallet use |
| --- | --- | --- |
| Protocol and headers | `server.version` returns 1.4 regardless of the offered versions. `server.features` advertises 1.4 to 1.5, the chain's genesis, and a static listener port. Header requests and header notifications exist. | Verify genesis independently, check headers against the controlled chain and reconnect through a reorg. [Handlers][methods] |
| Discovery and UTXOs | Unknown scripts return `[]` for history and unspent outputs. `listunspent.tx_pos` uses the transaction's index in the block, even though the cache holds the output's actual `vout`. | Fix the outpoint. Use a fixture whose block position differs from its output index, then spend it. Require evidence that a watch scan completed before interpreting an empty history. [Electrum UTXOs][utxos] and [cache indexing][cache] |
| Subscriptions | Standard `scripthash.subscribe` records a subscriber without installing a script watch. The second client for the same hash replaces the first. The TCP accept loop spawns client work without an application connection limit. | Support concurrent wallet and monitoring clients, reconnect and resubscribe, and bound connections. [Subscription handler][utxos] and [notification and accept loops][notify] |
| Fees and mempool | Estimate and relay fees are constants of 0.0001 and 0.00001 BTC/kB. Histogram and per-script mempool always return `[]`. Unconfirmed balance is zero and unconfirmed history entries carry a constant fee of 2000 sats. | Use measured fees or explicit unavailability. Test peer-originated unconfirmed funding, spending, replacement and conflict across history, balances and notifications. [Methods][methods] and [history formatter][fees] |
| Transactions | Broadcast uses the node interface, then caches the submitted transaction and notifies matching clients. Raw transaction and Merkle lookups depend on the watch cache. Cache misses return an error. `id_from_pos` has no handler. | Check peer relay and confirmation independently. Retrieve old funding, spender and parent transactions on fresh data and verify proofs against the active chain. [Transaction handlers][txs] |

## Registration, backfill and control

* **Watch coverage.** `loaddescriptor` parses public descriptors, expands a multipath descriptor and takes only the last resulting branch for its initial derivation of indices 0 to 99. It caches those scripts before checking filter availability and persists the descriptor after starting a rescan. A retry must account for partial work. Register branches separately and require per-wallet, per-range acknowledgement, including scripts exported by the Lightning engine. Debug output includes addresses and descriptors. [Parser][parser] and [registration][register]
* **Scan completion.** `rescanblockchain` rejects initial block download, missing filters and an empty watch set. Accepted scans run asynchronously. The worker logs filter hits **before** fetching matched blocks and skips failed or missing block fetches. Add a durable result tied to the watch generation, range and chain hash, with retries for incomplete coverage and invalidation on reorg. [RPC entry point][register] and [scan worker][scan]
* **Validation.** The daemon enables Assume Utreexo, historical backfill and compact filters by default. Script verification has a separate assume-valid setting. Tip height, validation index and IBD are available over RPC. Backfill runs in a separate task with an internal checkpoint file. Require an explicit successful backfill result, complete watch scans and a checked current tip before any handoff. A validation mismatch must revoke readiness. [Startup flags][cli], [chain status][chain] and [backfill worker][backfill]
* **Peer requirements.** Floresta seeks Utreexo proof peers and compact-filter peers. Historical validation needs archival inclusion proofs, and a selective history scan needs retained filters plus peers able to serve every matched old block. A standard Bitcoin Core regtest peer alone cannot qualify this path. Exercise loss of each capability independently and require visibly incomplete recovery. [Sync peer flags][proofs], [peer selection][peers] and [scan worker][scan]
* **Control access.** The HTTP RPC handler parses POST bodies as bytes and applies CORS middleware without a client credential check. Any local process able to reach it can invoke control methods, including `stop`. Even a browser-style `text/plain` POST can present a JSON body. Require authenticated RPC or an isolated private transport with a tested access boundary, including requests with a browser Origin. Use a dedicated child environment and private files. Injecting a token into an environment variable cannot secure this listener. [Request handler][rpc] and [router][router]

Storage headroom, bandwidth, recovery time and multi-platform process behavior require measurements with the selected runtime. Keep node data separate from Beignet backups and retain the existing Lightning recovery material throughout qualification.

[build]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/bin/florestad/Cargo.toml
[electrum-crate]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/Cargo.toml
[license]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/LICENSE.md
[networks]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/bin/florestad/src/main.rs#L172-L193
[store]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-chain/src/pruned_utreexo/flat_chain_store.rs#L106-L113
[init]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/florestad.rs#L358-L398
[methods]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L256-L539
[utxos]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L320-L377
[cache]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-watch-only/src/lib.rs#L194-L244
[notify]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L812-L866
[fees]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L674-L692
[txs]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-electrum/src/electrum_protocol.rs#L453-L507
[parser]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-common/src/lib.rs#L94-L111
[register]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L106-L193
[scan]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L584-L616
[cli]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/bin/florestad/src/main.rs#L65-L100
[chain]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/blockchain.rs#L246-L286
[backfill]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/running_ctx.rs#L193-L286
[proofs]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/sync_ctx.rs#L40-L49
[peers]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-wire/src/p2p_wire/node/running_ctx.rs#L155-L179
[rpc]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L510-L540
[router]: https://github.com/getfloresta/Floresta/blob/bc2db8d07e72651f9981ce589c5688f4d575dc7a/crates/floresta-node/src/json_rpc/server.rs#L747-L789
