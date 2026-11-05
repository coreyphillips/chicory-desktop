import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixtureReferences, verifyCloseClaims, verifyIncomingClaim } from './floresta-lightning-restore.mjs';

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

test('incoming recovery requires the correct preimage, hashlock, branch, confirmed parents and receiver payout', () => {
  const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest();
  const preimage = Buffer.alloc(32, 7), hash = digest('sha256', preimage);
  const claim = { heldSats: 30000, receivedSats: 28240, fundingSats: 499253, senderOfflineAtSettlement: true,
    receiverRestarted: true, settlement: 'pending', paymentHash: hash.toString('hex'), anchors: true, expiry: 190, closeHeight: 117, claimHeight: 119 };
  const fixture = { liveRole: 'incoming-claim', incoming: claim, currentFunding: txid('1') + ':0', commitmentHtlc: txid('2') + ':2', claimOutput: txid('3') + ':0' };
  const { byPoint } = fixtureReferences(fixture);
  const key = '0280' + '11'.repeat(31);
  const redeem = Buffer.from('76a914' + '22'.repeat(20) + '8763ac6721' + key + '7c820120876475527c21' + key +
    '52ae67a914' + digest('ripemd160', hash).toString('hex') + '88ac6851b27568', 'hex');
  const outputScript = Buffer.concat([Buffer.from('0020', 'hex'), digest('sha256', redeem)]);
  const signature = Buffer.from('300602010102010101', 'hex');
  const input = (name, sequence = 1) => ({ hash: Buffer.from(byPoint.get(name).txid, 'hex').reverse(), index: byPoint.get(name).vout, sequence });
  Object.assign(byPoint.get('currentFunding'), { height: 111, tx: { outs: [{ value: 499253 }] } });
  Object.assign(byPoint.get('commitmentHtlc'), { height: 117, tx: { ins: [input('currentFunding')], outs: [null, null, { value: 30000, script: outputScript }] } });
  const paid = { ...input('commitmentHtlc'), witness: [signature, preimage, redeem] };
  Object.assign(byPoint.get('claimOutput'), { height: 119, tx: { version: 2, ins: [paid], outs: [{ value: 28240 }] } });
  verifyIncomingClaim(byPoint, claim);
  for (const change of [{ paymentHash: txid('f') }, { anchors: false }, { expiry: 119 }, { receivedSats: 29000 }]) {
    assert.throws(() => verifyIncomingClaim(byPoint, { ...claim, ...change }));
  }
  paid.sequence = 0;
  assert.throws(() => verifyIncomingClaim(byPoint, claim));
  paid.sequence = 1;
  paid.index++;
  assert.throws(() => verifyIncomingClaim(byPoint, claim));
  paid.index--;
  paid.witness[1] = Buffer.alloc(32, 1);
  assert.throws(() => verifyIncomingClaim(byPoint, claim));
  paid.witness[1] = preimage;
  redeem[redeem.length - 2] = 0x76;
  byPoint.get('commitmentHtlc').tx.outs[2].script = Buffer.concat([Buffer.from('0020', 'hex'), digest('sha256', redeem)]);
  assert.throws(() => verifyIncomingClaim(byPoint, claim));
});
