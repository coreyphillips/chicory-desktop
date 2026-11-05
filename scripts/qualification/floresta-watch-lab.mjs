// Exercise the same supervisor and private registration protocol used by the
// desktop. Only this disposable regtest fixture can supply a fixed proof peer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import supervisor from '../../desktop/floresta.cjs';
import { REGTEST_GENESIS } from './guards.mjs';
import { checkpointSize, verifyManagedParents } from './floresta-parent-lab.mjs';
import { confirmedFixture } from './floresta-confirmed-lab.mjs';

export async function qualifyManagedWatches({ binary, root, peerPort, proof, script, outpoint, height, blockHash }) {
  assert.equal(await proof('getblockhash', [0]), REGTEST_GENESIS);
  assert.equal(await proof('getblockhash', [height]), blockHash);
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(binary), 'bundle.json'), 'utf8'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const owner = hash('funded regtest wallet');
  const derivedOwner = hash('ranged regtest wallet');
  const forkOwner = hash('regtest detached funding outpoint');
  const descriptor = 'wpkh(tpubD6NzVbkrYhZ4XYwobhBbSnzN9UvAtr6KH2sbToYWosu8V4UCXVL4koZjTeE2exHq5C22UW5yogQnjvvxMnFcEyfpNrh7yq9XNwHPQRMsEaz/0/*)';
  const other = hash('independent regtest wallet');
  const parent = await fs.mkdtemp(path.join(root, 'managed-'));
  const node = new supervisor.ManagedFloresta({
    network: 'regtest', profileDirectory: parent, binary, sha256: manifest.sha256,
    spawnProcess(file, args, options) {
      return spawn(file, [...args, '--connect', '127.0.0.1:' + peerPort], options);
    }
  });
  async function waitFor(label, read, accept) {
    const end = Date.now() + 300000;
    let last;
    while (Date.now() < end) {
      if (node.status().phase === 'failed') throw new Error(node.status().error);
      last = await read();
      if (accept(last)) return last;
      await delay(250);
    }
    throw new Error(label + ' timed out: ' + JSON.stringify(last));
  }
  const atTip = state => state.phase === 'caught-up' && state.height === height && state.hash === blockHash;
  const verifyConfirmed = manifest.patches?.['confirmed-reads.patch'] && confirmedFixture({
    node, proof, waitFor, owners: { miner: hash('regtest mining wallet'), wallet: owner }, script
  });
  async function verifyHistory(target, tip, tipHash) {
    const anchor = await proof('getblockhash', [target]);
    const status = await waitFor('Historical verification', () => node.status(), state => {
      if (state.historicalVerification === 'error') throw new Error('Managed historical verification failed at target ' + target);
      return state.historicalVerification === 'verified' && state.historicalHeight === target &&
        state.historicalTarget === target && state.height === tip && state.validatedHeight === tip &&
        state.tipHash === tipHash && state.tipSynced;
    });
    assert.equal(await proof('getblockhash', [tip]), status.tipHash);
    assert.equal(await proof('getblockhash', [target]), anchor);
    return { state: status.historicalVerification, height: status.historicalHeight,
      target: status.historicalTarget, referenceAnchor: anchor, tip, tipHash };
  }
  const start = performance.now();
  let handingOff = false;
  try {
    await node.start();
    await waitFor('Fresh managed chain sync', () => node.status(),
      state => state.height === height && state.tipHash === blockHash && state.tipSynced);
    const syncMs = Math.round(performance.now() - start);
    const watch = { owner, scripts: [script], outpoints: [outpoint] };
    const empty = { owner: other, scripts: ['6a04deadbeef'], outpoints: [] };
    await Promise.all([node.registerWatches(watch), node.registerWatches(empty)]);
    const [funded, negative] = await Promise.all([owner, other].map(id =>
      waitFor('Confirmed watch coverage', () => node.watchCoverage(id), atTip)));
    const scanMs = Math.round(performance.now() - start) - syncMs;
    assert.equal(funded.matchedTransactions, 1);
    assert.equal(negative.matchedTransactions, 0);
    assert.deepEqual(await node.registerWatches(watch), funded);
    const lookup = { node, owner, otherOwner: other, proof, matchedHeight: height, matchedTxid: outpoint.split(':')[0], parentHeight: 1 };
    const parents = { initial: await verifyManagedParents(lookup) };
    // Fresh regtest starts at genesis and validates the fixture blocks on the
    // foreground chain. Reopening replays to the stored validation anchor.
    const historical = { initial: await verifyHistory(0, height, blockHash) };
    const confirmed = verifyConfirmed ? { initial: await verifyConfirmed(height, blockHash) } : null;
    await node.stop();
    const checkpoint = await checkpointSize(parent);
    await node.start();
    const recovered = await waitFor('Recovered durable scan', () => node.watchCoverage(owner), atTip);
    assert.deepEqual(recovered, funded);
    parents.reopened = await verifyManagedParents(lookup);
    historical.reopened = await verifyHistory(height, height, blockHash);
    if (confirmed) confirmed.reopened = await verifyConfirmed(height, blockHash);
    // Adding an existing funded script to an initially empty wallet must find
    // history older than registration, without losing the other owner's data.
    await node.registerWatches({ owner: other, scripts: [script], outpoints: [] });
    const expanded = await waitFor('Expanded history', () => node.watchCoverage(other), atTip);
    assert.equal(expanded.matchedTransactions, 1);
    assert.equal(expanded.requiredScripts, 2);
    assert.deepEqual(await node.watchCoverage(owner), funded);
    // The fixture address was derived at index 105 by a separate BIP32 implementation.
    // Only the public extended key was retained. Discover it through the range
    // API, without supplying either the address or transaction to this owner.
    async function derive(end) {
      await node.registerWatches({ owner: derivedOwner, scripts: [], outpoints: [], descriptors: [{ descriptor, range: [0, end] }] });
      return waitFor('Ranged descriptor scan', () => node.watchCoverage(derivedOwner), atTip);
    }
    const beforeExpansion = await derive(104);
    assert.equal(beforeExpansion.matchedTransactions, 0);
    const afterExpansion = await derive(105);
    assert.equal(afterExpansion.matchedTransactions, 1);
    assert.equal(afterExpansion.requiredScripts, 106);
    const evidence = { funded, negative, recovered, expanded, beforeExpansion, afterExpansion, parents, checkpoint, historical, confirmed,
      walletReady: node.status().walletReady, forks: [],
      environment: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model,
        memoryBytes: os.totalmem(), proofPeer: 'loopback', network: 'regtest', binarySha256: manifest.sha256,
        binaryBytes: (await fs.stat(binary)).size, syncMs, twoOwnerScanMs: scanMs, chainHeight: height } };
    handingOff = true;
    return { evidence, stop: () => node.stop(), async atTip({ tipHeight, tipHash, outpoint, expectedMatches, stage }) {
      const reached = state => state.phase === 'caught-up' && state.height === tipHeight && state.hash === tipHash;
      await node.registerWatches({ owner: forkOwner, scripts: [], outpoints: [outpoint] });
      const [funded, detached] = await Promise.all([owner, forkOwner].map(id =>
        waitFor('Fork-specific watch coverage', () => node.watchCoverage(id), reached)));
      assert.equal(funded.matchedTransactions, expectedMatches);
      assert.equal(detached.matchedTransactions, stage === 'beforeFork' ? 1 : 0);
      const proofs = await verifyManagedParents({ node, owner, proof, matchedHeight: 103, parentHeight: 2,
        ...(stage === 'beforeFork' ? { matchedTxid: outpoint.split(':')[0] } : { detachedTxid: outpoint.split(':')[0] }) });
      if (stage === 'afterFork') {
        assert.equal(await node.confirmedTransaction(forkOwner, proofs.parent.txid), null);
      }
      const history = await verifyHistory(height, tipHeight, tipHash);
      evidence.forks.push({ stage, funded, detached, proofs, historical: history,
        confirmed: verifyConfirmed ? await verifyConfirmed(tipHeight, tipHash) : null });
    } };
  } finally {
    if (!handingOff) await node.stop();
  }
}
