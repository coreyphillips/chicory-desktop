'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkpoint, headerHash, checkActiveCheckpoint, chainTrustAccepted } = require('./floresta-checkpoint.cjs');

// Mainnet block 939,969, read back from the cold-start trial and independently hashed.
const anchor = '0000002a4c5e551f7bad3aaecb7a518f909ef0a8e6f024eaee5d00000000000000000000e56578be843261f2749d7beb1c5834d5a9cea1e36cbe56cb31aecff8e70cc07adc8aae69ccf00117e986c412';
const tip = '11'.repeat(80);
const state = {
  network: 'mainnet', tipSynced: true, tipHash: headerHash(tip), height: 974692, validatedHeight: 974692,
  historicalVerification: 'verifying', historicalTarget: checkpoint.height, checkpointEligible: true,
};
test('quick start requires the pinned mainnet header on the same validated tip and a healthy independent replay', async () => {
  assert.equal(headerHash(anchor), checkpoint.hash);
  const headers = async heights => {
    assert.deepEqual(heights, [974692, 939969, 974692]);
    return [tip, anchor, tip];
  };
  assert.equal(await checkActiveCheckpoint('mainnet', state, headers), true);
  for (const invalid of [{tipSynced:false}, {validatedHeight: 999}, {checkpointEligible:false},
    {checkpointEligible:undefined}, {historicalTarget:0}, {historicalVerification:'error'}, {historicalVerification:'pending'}]) {
    assert.equal(await checkActiveCheckpoint('mainnet', {...state, ...invalid}, () => assert.fail()), false);
  }
  assert.equal(await checkActiveCheckpoint('testnet', state, () => assert.fail()), false);
  for (const response of [[tip, tip, tip], [tip, anchor, anchor], [anchor, anchor, anchor]]) {
    assert.equal(await checkActiveCheckpoint('mainnet', state, async () => response), false);
  }
  assert.equal(chainTrustAccepted(state), false);
  assert.equal(chainTrustAccepted({ ...state, checkpointAccepted:true }), true);
  assert.equal(chainTrustAccepted({ ...state, checkpointAccepted:true, historicalVerification:'error' }), false);
  assert.equal(chainTrustAccepted({ ...state, checkpointAccepted:true, network:'regtest' }), false);
  assert.equal(chainTrustAccepted({ historicalVerification:'verified' }), true);
});

test('requesting full verification revokes an assumed-state session immediately', () => {
  const { ManagedFloresta } = require('./floresta.cjs');
  const { WatchRequests } = require('./floresta-watches.cjs');
  const node = new ManagedFloresta({ network: 'mainnet', checkpointQuickStart: true });
  node.watch = new WatchRequests(() => assert.fail(), () => assert.fail());
  node.watch.active = true;
  const old = node.watch.lifetime.signal;
  node._state('running', { ...state, checkpointAccepted: true });
  node.setCheckpointQuickStart(false);
  assert.equal(old.aborted, true);
  assert.equal(node.status().checkpointAccepted, false);
  assert.equal(node.status().tipSynced, null);
  node.setCheckpointQuickStart(true);
  assert.equal(old.aborted, true);
  assert.equal(node.status().checkpointAccepted, false);
});
