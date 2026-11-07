'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openPendingWallet, validatePendingPage, PENDING_LINE_BYTES } = require('./floresta-pending-reads.cjs');
const { WatchRequests, PROTOCOL } = require('./floresta-watches.cjs');
const owner = 'aa'.repeat(32);
const scriptHash = 'bb'.repeat(32);
const tipHash = 'cc'.repeat(32);
const id = n => n.toString(16).padStart(2, '0') + '00'.repeat(31);
const status = () => ({ historicalVerification: 'verified', tipSynced: true, height: 104, validatedHeight: 104, tipHash });
const observe = txid => ({ txid, height: 0, fee: 1200, spent: [{ txid: owner, vout: 1, value: 6000 }], created: [{ vout: 2, value: 4500 }] });
function setup(edit = () => {}, chain = status) {
  const signal = new AbortController();
  const watch = { pendingActive: true, active: true, async request(cmd) {
    assert.equal(cmd.owner, owner);
    assert.equal(cmd.action, 'pending');
    if (cmd.pending.scriptHash !== scriptHash) return null;
    const second = Boolean(cmd.pending.after);
    if (second) assert.equal(cmd.pending.after, id(1));
    const value = { phase: 'observed', coverageComplete: false, tipHeight: 104, tipHash, revision: 4,
      rows: [observe(id(second ? 2 : 1))], next: second ? null : id(1) };
    await edit(value, second, watch, signal);
    return validatePendingPage(cmd, value);
  } };
  return { session: openPendingWallet(watch, owner, signal.signal, chain), signal, watch };
}
test('pending pages retain the same owner, chain and revision and disclose incomplete coverage', async () => {
  const { session } = setup();
  assert.deepEqual(await session.observations(scriptHash), { scope: 'observed-pending', coverageComplete: false,
    tipHash, tipHeight: 104, revision: 4, rows: [observe(id(1)), observe(id(2))] });
  assert.equal(await session.observations(owner), null);
  await assert.rejects(session.observations(''), /script hash/);
  assert.deepEqual((await setup(v => { v.rows = []; v.next = null; }).session.observations(scriptHash)).rows, []);
});
test('a fork, new pool revision or stale validation heartbeat discards the entire partial result', async () => {
  for (const edit of [v => { v.revision++; }, v => { v.tipHeight++; }, v => { v.tipHash = owner; }]) {
    const { session } = setup((v, second) => { if (second) edit(v); });
    assert.equal(await session.observations(scriptHash), null);
  }
  for (const state of [{ historicalVerification: 'verifying' }, { tipSynced: false }, { height: 103 }, { validatedHeight: 103 }]) {
    assert.equal(await setup(undefined, () => ({ ...status(), ...state })).session.observations(scriptHash), null);
  }
});
test('wallet revocation or child replacement cancels an in-flight read and unsupported capabilities cannot mint a session', async () => {
  const { session } = setup((_v, _second, _watch, signal) => signal.abort());
  await assert.rejects(session.observations(scriptHash), /closed/);
  await assert.rejects(setup((_v, _second, watch) => { watch.active = false; }).session.observations(scriptHash), /closed/);
  const closed = setup(); closed.session.close();
  await assert.rejects(closed.session.observations(scriptHash), /closed/);
  assert.throws(() => openPendingWallet({ active: true }, owner, new AbortController().signal, status));
  assert.throws(() => openPendingWallet(closed.watch, owner, undefined, status));
});
test('malformed pending rows, duplicate outpoints, backwards cursors and complete claims are refused', async () => {
  for (const edit of [v => { v.coverageComplete = true; }, v => { v.revision = -1; }, v => { v.next = owner; },
    v => { v.rows[0].height = 1; }, v => { v.rows[0].fee = -1; }, v => { v.rows[0].spent[0].value = 21e6 * 1e8 + 1; },
    v => { v.rows[0].created[0].vout = -3; }, v => v.rows[0].spent.push(v.rows[0].spent[0]),
    v => v.rows[0].created.push(v.rows[0].created[0]), v => v.rows.push(v.rows[0]), v => { v.rows[0].txid = id(0); }]) {
    await assert.rejects(setup((v, second) => { if (second) edit(v); }).session.observations(scriptHash), /Invalid/);
  }
  const cmd = { pending: { scriptHash } };
  assert.equal(validatePendingPage(cmd, { phase: 'unavailable' }), null);
  assert.throws(() => validatePendingPage(cmd, { phase: 'unavailable', private: true }));
});
test('only a negotiated pending request can receive a large reply on its own private request ID', async () => {
  let request;
  const watch = new WatchRequests(line => { request = JSON.parse(line); }, assert.fail);
  watch.active = true;
  assert.equal(watch.partialLimit(), 4096);
  watch.pendingActive = true;
  const pending = watch.request({ action: 'pending', owner, pending: { scriptHash } });
  const inputs = Array.from({ length: 110 }, (_, vout) => ({ txid: scriptHash, vout, value: 100 }));
  const reply = { protocol: PROTOCOL, id: request.id, result: { phase: 'observed', coverageComplete: false,
    tipHash, tipHeight: 1, revision: 0, rows: [{ ...observe(id(1)), spent: inputs }], next: null } };
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) > 4096);
  assert.equal(watch.partialLimit(), PENDING_LINE_BYTES);
  assert.equal(watch.replyLimit(reply), PENDING_LINE_BYTES);
  assert.equal(watch.replyLimit({ ...reply, protocol: 'chicory.floresta/1' }), 4096);
  assert.equal(watch.replyLimit({ ...reply, id: request.id + 1 }), 4096);
  watch.receive(reply);
  assert.equal((await pending).rows[0].spent.length, 110);
  assert.equal(watch.partialLimit(), 4096);
});
