# Bugs and fixes found while integrating Floresta

Use this register to decide what to file, where to file it and which existing issues can use additional evidence. All funded tests use disposable Bitcoin regtest funds. The [Floresta report](floresta-upstream-bugs.md) contains the commands, expected and observed responses, release pins, transaction evidence and upstream source references. The [qualification log](floresta-qualification.md) covers separate feature and release requirements.

## Chicory Desktop

### Honor the selected Electrum server's TLS policy over Tor

**Already filed.** On the original desktop revision, configuring a v3 onion Electrum server with TLS and certificate verification opened a SOCKS tunnel but sent plaintext Electrum into it. The selected certificate identity and pins never reached the TLS client. The resolver's original unit test expected TLS to be disabled. A TLS-only endpoint could fail to serve the wallet. [Issue 45 and original source](https://github.com/coreyphillips/chicory-desktop/issues/45)

**Fix and verification.** The client now negotiates TLS over the tunnel using the configured onion hostname. The prepared-engine regression verifies hostname and pin handling and denies wallet writes when certificate verification fails. The explicit plaintext case is also covered. The test uses a controlled local TLS destination and bridge. [Fix](https://github.com/coreyphillips/chicory-desktop/commit/a926253) · [Prepared-engine tests](../server/engine-endpoint-policy.test.js) · [Resolver tests](../server/desktop-network.test.js)

## Beignet wallet engine

### A failed Electrum history batch can look like an empty Lightning script

**Suggested filing target.** Beignet 0.38.0. Set up an ElectrumBackend for one script with an outer transport success containing a per-item error, for example `{data: [{error: {code: -32000}}]}`. Call `getScriptHashHistory` for that script. The stock loop skips the failed entry and returns an empty array, the same value returned for a successful script with no funding history. A Lightning watcher needs to treat the first case as unavailable and retry. The fixture demonstrates the wrong return value. It does not simulate a lost payment. [Pinned Beignet method](https://github.com/coreyphillips/beignet/blob/954d034b13f57b38297406dd0d30dddc1208b192/src/lightning/chain/electrum-backend.ts#L422-L449)

**Chicory fix.** Check that the single requested script received exactly one valid history result before using its rows. A successful empty result remains valid. The prepared-engine tests exercise an empty result, a funded result, a missing response, a per-item error and malformed data with ordinary external wallets as well as the managed watch guard. Run `node --test server/engine-watch-control.test.js` after preparing the desktop runtime. [Engine guard](../scripts/engine-watch-control.cjs) · [Regression tests](../server/engine-watch-control.test.js)

### A wallet health check can reject an authenticated selective index

On a private, per-wallet Electrum bridge, the pinned wallet connected successfully
but its refresh still reported the peer offline. Its health check queried a
hardcoded wallet script that lay outside the registered owner scope. The
qualification path uses `server.ping` on the authenticated local connection.
The ordinary external health check keeps its existing behavior. [Pinned calls
and scoped correction](floresta-beignet.md)

### A recovered wallet could release its watch snapshot before the required restart

Beignet's Tier 2 peer-storage restore swaps a channel database and returns `restartRequired`. The desktop watch observer previously omitted this flag. A wallet could therefore reuse coverage collected before recovery. Chicory now withdraws the old acknowledgement, reports recovery pending and waits for a fresh snapshot after restart. A funded test also checks the recovered channel's funding script against an independent Bitcoin Core node. [Watch observer](../scripts/engine-watch-control.cjs) · [Regression](../server/engine-watch-control.test.js)

## Floresta

The following rows are separate filing or follow-up decisions. Check the linked upstream work before opening another issue. No report has been submitted to Floresta by this project.

| Suggested subject | Evidence on the release | Review action |
| --- | --- | --- |
| Duplicate fixed peers during mainnet bootstrap | All 215 overlapping mainnet and signet records have the same address and port. A native message from the other network fails the network magic check. | Remove the signet records from the mainnet fallback and include the upstream proof discovery seed. |
| SOCKS IPv6 and hidden-service requests use the wrong address encoding | Local SOCKS fixtures capture the exact address type and bytes, and a closed greeting used to panic. | Review the existing upstream handshake fix and downstream address conversions separately. |
| Valid proof-only nodes can be dropped or sent a raw block request | Two peer roles in a native regression. Disk/gossip advertised WITNESS and UTREEXO without NETWORK_LIMITED. A raw-block-only peer and a proof-only peer received the wrong request types. | Accept truthful proof-only advertisements, maintain their service buckets, and select the appropriate peer for each request. |
| Wrong output index in listunspent | Funded output 2 returned as index 1, its transaction position in the block | Request a release or backport of the existing development fix. |
| Peer funding, replacements and conflicts absent before confirmation | Peer accepted transactions while watched pending history and UTXOs missed them | Add acceptance cases to upstream #1303 and distinguish eviction work in #1307. |
| A detached confirmation can survive a reorg | Confirmed balance, history and an old Merkle proof disagreed with the active chain at height 104 | Separate wallet rollback report. Include the conflicting spend and active header. |
| Verbose transaction retrieval returns raw hex | Raw and verbose probes of the same funded transaction | Request decoded verbose data or an explicit capability error. |
| Unwatched parents and unknown txids have ambiguous errors | The independent block contained the parent. Both raw and verbose cache lookups failed. | Separate selective-history support from the client's error-classification requirement. |
| Fee estimates are constant across targets | Four target queries plus the release's constant return | Request an estimate with a documented source or an unavailable result. |
| Unregistered scripts can return null confirmed balance | Electrum probe and source. The client liveness test accepts the result. | Request numeric amounts for an indexed script and an explicit coverage result otherwise. |
| Loopback RPC accepts requests without credentials | Read-only POST returned current chain data. Administrative methods share the router. | Review the control-access report and threat model. |
| Overlapping subscriptions, descriptor branches and partial rescans | Release source and comparison to a pinned development commit | Reproduce each separately before filing as a runtime defect. |
| Historical validation can skip script checks or discard errors | Partial-chain script flag and error match, plus regressions in the Chicory backfill patch | Supplement existing #1335. |
| Historical completion and assumed-state persistence | Empty/truncated checkpoint path, replay commitment comparison, and repeated-start accumulator checks | See the detailed store findings and distinguish a downstream regression from the upstream writes it exposed. |
| Chain-status delays during durable post-sync flush | Timestamped native status at heights 102 and 103 and sampled threads inside the whole-store checksum and chain lock | Share the debug-build results separately from the transient inconsistent reorg index. Include the optimized comparison on the same chain and hardware. |
| Inconsistent active-tip reads during a reorg | A deterministic ten-block fork exposes an inactive validated header to a concurrent reader | Request a coherent snapshot or a retryable transition, and include the native regression. |
| Unverified historical blocks can reach retrieval callers | Existing upstream report and proposed fix | Follow #1354 and its associated change. |

Each row's release/development comparison, upstream links and precise evidence are in the [upstream report](floresta-upstream-bugs.md). Protected control, explicit watch scopes, per-owner historical lookup and independent replay in the candidate are downstream mitigations. A successful confirmed scan alone provides no evidence about mempool or Lightning recovery.

## Defects found in the review branch itself

These entries describe integration or test defects found before release. They should be filed against Chicory only if they recur.

| Reproduction | Correction and regression coverage |
| --- | --- |
| Put an old receipt or an extra library alongside a previously prepared candidate whose executable still has the expected digest, then prepare it again. | Verify the entire staged payload before reusing the directory. The regression covers an identical installation, a changed receipt and an extra DLL. |
| Reopen an independently verified genesis-anchor store after the chain advances. | The old target-specific receipt caused a full replay of the verified prefix. Reuse an authenticated active prefix under the same validation policy. A funded week-backlog test, competing fork, corruption and policy-mismatch regressions verify the change. |
| Launch the new Settings preload in a VM context without process arguments. | The preload reads the development flag defensively. Run the preload tests and the Electron Settings smoke. |
| Run a new desktop against an older candidate that can start but lacks private transaction reads. | Negotiate the transaction capability explicitly before requesting wallet data. Use the native supervisor and funded parent-recovery tests. |
| Erase a profile after disconnecting the volume containing its managed chain data. | Make the user choose between retrying and erasing the wallet while leaving the unavailable node data. The managed-path cleanup has separate ownership, lock and content checks. |
| Run the first platforms matrix with a slow flush or a newer Windows compiler. | Three native runners built the daemon but exceeded its stop timeout. Windows Boost 1.85 bootstrap initially failed to select a compatible compiler. The native workflow and supervisor tests track these separately from wallet bugs. |
| Trigger an invalid control message, then advance the clock past the health deadline while the child flushes. | The heartbeat timeout could overwrite the original failure during shutdown. Stop the health timer when shutdown begins and retain the first failure. The supervisor regression exercises both events. |
| Reopen an initialized external store with its original directory missing from a still-accessible mount path. | Previously a fresh store could be created in the replacement location. The supervisor now refuses to create a replacement on restart, including after an in-process retry. The regression restores the original directory and verifies the same node can reopen it. |

The review branch also qualifies a real confirmed-coin direct-funding splice. The original fixture skipped it, then a first combined run attempted a second funding before the recipient's earlier splice had locked. The final fixture waits for that channel state, verifies that the new transaction spends both the payer's coin and the previous channel outpoint, and compares the confirmed txid and amount at the recipient. [Desktop qualification](desktop-qualification.md)

For future reports, retain the commit or runtime digest, exact command, initial wallet and node state, independent expected result, observed output, and the first passing regression. Mark source observations explicitly until reproduced. Keep wallet seeds, keys, tokens and real wallet history out of attachments.
