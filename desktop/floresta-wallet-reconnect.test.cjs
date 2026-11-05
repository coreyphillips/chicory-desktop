'use strict';

const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');
const { grantWalletBridge } = require('./floresta-wallet-bridge.cjs');

const hash = byte => byte.repeat(64);
const owner = hash('a');
const funding = { txid: hash('b'), wtxid: hash('c'), scriptHash: hash('d'), vout: 1, value: 300000 };

async function fixture(t) {
  const manager = Object.assign(new EventEmitter(), { connected: true });
  const parent = new AbortController();
  const anchor = { tipHeight: 106, tipHash: hash('f') };
  const status = { network: 'regtest', phase: 'running', height: 106, validatedHeight: 106, tipHash: anchor.tipHash,
    historicalVerification: 'verified', tipSynced: true };
  const state = {
    proof: { ...anchor, scope: 'confirmed-only', height: 101, confirmations: 6, txid: funding.txid, wtxid: funding.wtxid },
    unspent: { ...anchor, scope: 'confirmed-only', rows: [{ txid: funding.txid, height: 101, vout: 1, value: 300000 }] },
    observed: { ...anchor, scope: 'observed-pending', coverageComplete: false, revision: 1, rows: [] },
    grants: 0,
  };
  manager.send = (message, done) => {
    if (message.type === 'floresta:bridge-open') {
      state.grants++;
      queueMicrotask(() => {
        manager.emit('message', { type: 'floresta:bridge-ready', id: message.id, endpoint: {
          host: '127.0.0.1', port: 6000 + state.grants, tls: true, psk: hash(String(state.grants)) } });
        state.onOpen?.();
      });
    }
    done?.();
  };
  const node = {
    watch: { active: true, lifetime: new AbortController(), walletOffersActive: true }, status: () => status,
    openConfirmedWallet(given) {
      assert.equal(given, owner);
      return { transaction: async id => { assert.equal(id, funding.txid); return state.proof; },
        unspent: async h => { assert.equal(h, funding.scriptHash); return state.unspent; }, close() {} };
    },
    openPendingWallet(given) {
      assert.equal(given, owner);
      return { observations: async h => { assert.equal(h, funding.scriptHash); return state.observed; }, close() {} };
    },
  };
  const grant = await grantWalletBridge({ qualification: true, manager, node, owner, signal: parent.signal });
  t.after(() => parent.abort());
  return { grant, status, state, node, parent };
}

test('one closed grant reopens its own reviewed funding once with read-only authority', async t => {
  const { grant, state } = await fixture(t);
  await assert.rejects(grant.reopenConfirmedFunding(funding));
  grant.close();
  const opening = grant.reopenConfirmedFunding(funding);
  await assert.rejects(grant.reopenConfirmedFunding(funding));
  const reopened = await opening;
  t.after(reopened.close);
  assert.notEqual(grant.endpoint.psk, reopened.endpoint.psk);
  assert.throws(() => reopened.authorizeBroadcast(funding.txid, funding.wtxid));
  await assert.rejects(grant.reopenConfirmedFunding(funding));
  assert.equal(state.grants, 2);
});

test('renewal refuses unverified and shallow funding, known spends, lost owner authorization and post-open races', async t => {
  for (const [label, mutate] of Object.entries({
    shallow: f => { f.state.proof.confirmations = 5; },
    witness: f => { f.state.proof.wtxid = hash('1'); },
    spent: f => { f.state.unspent.rows = []; },
    conflict: f => { f.state.observed.rows = [{ spent: [{ txid: funding.txid, vout: 1 }] }]; },
    offline: f => { f.status.tipSynced = false; },
    locked: f => { f.parent.abort(); },
    'tip race': f => { f.state.onOpen = () => { f.status.tipHash = hash('2'); }; },
    'revision race': f => { f.state.onOpen = () => { f.state.observed.revision++; }; },
    'native replacement': f => { f.state.onOpen = () => { f.node.watch = { ...f.node.watch }; }; },
    'native lifetime change': f => { f.state.onOpen = () => { f.node.watch.lifetime.abort(); f.node.watch.lifetime = new AbortController(); }; },
  })) await t.test(label, async sub => {
    const f = await fixture(sub);
    f.grant.close();
    mutate(f);
    await assert.rejects(f.grant.reopenConfirmedFunding(funding));
  });
});
