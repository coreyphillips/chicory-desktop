import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureReferences, verifyCloseClaims } from './floresta-lightning-restore.mjs';

const txid = byte => byte.repeat(64);
const base = { liveRole: 'channel-counterparty', live: { owner: txid('a') }, restoredRole: 'recipient',
  restored: { owner: txid('b'), snapshot: { status: 'observed' } }, currentFunding: txid('1') + ':1' };

test('splice restore still requires all three distinct funding and parent references plus a recency hold', () => {
  const splice = { ...base, priorFunding: txid('2') + ':0', payerCoin: txid('3') + ':0',
    restore: { kind: 'full-backup', heldOrClosed: true } };
  const { remote, byPoint } = fixtureReferences(splice);
  assert.equal(remote, false);
  assert.deepEqual([...byPoint.keys()], ['priorFunding', 'currentFunding', 'payerCoin']);
  for (const changed of [{ payerCoin: undefined }, { priorFunding: splice.payerCoin }, { restore: { kind: 'full-backup' } }]) {
    assert.throws(() => fixtureReferences({ ...splice, ...changed }));
  }
});

test('guardian requires an observed replacement owner, a settled receipt and unspent funding', () => {
  const quorum = { ...base, confirmedSpend: null, restore: { kind: 'quorum', chainOutcome: 'funding-unspent',
    restoredPayment: true, fundedSats: 200000 } };
  assert.equal(fixtureReferences(quorum).byPoint.size, 1);
  for (const changed of [{ confirmedSpend: txid('4') }, { restored: { ...base.restored, owner: base.live.owner } },
    { restored: { ...base.restored, snapshot: { status: 'recovery-pending' } } },
    { restore: { ...quorum.restore, restoredPayment: false } }, { restore: { ...quorum.restore, chainOutcome: 'unknown' } }]) {
    assert.throws(() => fixtureReferences({ ...quorum, ...changed }));
  }
});

test('a spent peer-storage funding output needs a separate confirmed spending transaction', () => {
  const peer = { ...base, confirmedSpend: txid('4'), restore: { kind: 'peer-storage', chainOutcome: 'confirmed-spend-channel-unusable',
    restoredPayment: false, fundedSats: 200000 } };
  assert.deepEqual(fixtureReferences(peer).byPoint.get('confirmedSpend'), { txid: txid('4') });
  for (const invalid of [null, txid('1'), 'unconfirmed']) assert.throws(() => fixtureReferences({ ...peer, confirmedSpend: invalid }));
});

test('final sweeps require the actual HTLC timeout locktime, correct parents and CSV maturity', () => {
  const close = { reason: 'HTLC_EXPIRY_FORCE_CLOSE', heldSats: 30000, expiry: 165, csvBlocks: 144 };
  const fixture = { liveRole: 'reopened-closer', close, currentFunding: txid('1') + ':0', commitmentHtlc: txid('2') + ':1',
    commitmentBalance: txid('2') + ':0', secondLevel: txid('3') + ':0', balanceSweep: txid('4') + ':0', timeoutSweep: txid('5') + ':0' };
  const { byPoint } = fixtureReferences(fixture);
  const spend = (parent, sequence = 0xffffffff) => {
    const item = byPoint.get(parent);
    return { hash: Buffer.from(item.txid, 'hex').reverse(), index: item.vout, sequence };
  };
  const commitment = { ins: [spend('currentFunding')], outs: [{ value: 50000 }, { value: 30000 }] };
  Object.assign(byPoint.get('currentFunding'), { height: 110 });
  for (const key of ['commitmentHtlc', 'commitmentBalance']) Object.assign(byPoint.get(key), { height: 172, tx: commitment });
  Object.assign(byPoint.get('secondLevel'), { height: 173, tx: { ins: [spend('commitmentHtlc')], locktime: 165 } });
  Object.assign(byPoint.get('balanceSweep'), { height: 316, tx: { ins: [spend('commitmentBalance', 144)] } });
  Object.assign(byPoint.get('timeoutSweep'), { height: 317, tx: { ins: [spend('secondLevel', 144)] } });
  verifyCloseClaims(byPoint, close);
  assert.throws(() => verifyCloseClaims(byPoint, { ...close, expiry: 166 }));
  assert.throws(() => verifyCloseClaims(byPoint, { ...close, csvBlocks: 1 }));
  byPoint.get('timeoutSweep').height = 316;
  assert.throws(() => verifyCloseClaims(byPoint, close), /CSV maturity/);
  byPoint.get('timeoutSweep').tx.ins = [spend('commitmentBalance', 144)];
  assert.throws(() => verifyCloseClaims(byPoint, close), /ancestry/);
});
