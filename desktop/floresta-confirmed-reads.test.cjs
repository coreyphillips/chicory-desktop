'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openConfirmedWallet, validateConfirmedPage } = require('./floresta-confirmed-reads.cjs');
const owner = 'aa'.repeat(32);
const scriptHash = 'bb'.repeat(32);
const tipHash = 'cc'.repeat(32);
const status = () => ({ historicalVerification: 'verified', tipSynced: true, height: 11, validatedHeight: 11, tipHash });
function setup(modify = () => {}, chain = status) {
  const controller = new AbortController();
  const watch = { active: true, confirmedReadsActive: true, transactionsActive: true,
    async request(command) {
      assert.equal(command.owner, owner);
      const { query } = command;
      const start = query.after ? 12 : 0;
      const rows = Array.from({ length: start ? 1 : 12 }, (_, i) => ({ txid: scriptHash, height: 11, position: start + i,
        ...(query.kind === 'unspent' && { vout: 3, value: 4 }) }));
      const next = start ? null : '0000000b0000000b' + (query.kind === 'history' ? '00000000' : '00000003');
      const value = { phase: 'confirmed-only', kind: query.kind, scriptHash, tipHeight: 11, tipHash, rows, next };
      await modify(command, value, watch, controller);
      return validateConfirmedPage(command, value);
    } };
  return { watch, controller, session: openConfirmedWallet(watch, owner, controller.signal, chain) };
}
test('one authorized owner gets ordered pages and confirmed-only balances', async () => {
  const { session } = setup();
  assert.equal((await session.history(scriptHash)).rows.length, 13);
  const utxos = await session.unspent(scriptHash);
  assert.deepEqual(utxos.rows.at(-1), { txid: scriptHash, height: 11, position: 12, vout: 3, value: 4 });
  assert.deepEqual(await session.balance(scriptHash), { scope: 'confirmed-only', tipHeight: 11, tipHash, confirmed: 52 });
  await assert.rejects(session.balance('other-wallet'), /hash/);
});
test('a stale anchor, incomplete validation, changed owner or unsupported daemon yields no result', async () => {
  const moving = setup((command, page) => { if (command.query.after) page.tipHash = owner; });
  assert.equal(await moving.session.unspent(scriptHash), null);
  assert.equal(await setup(undefined, () => ({ ...status(), historicalVerification: 'verifying' })).session.history(scriptHash), null);
  const { controller, watch, session } = setup();
  controller.abort();
  await assert.rejects(session.balance(scriptHash), /closed/);
  assert.throws(() => openConfirmedWallet({ ...watch, confirmedReadsActive: false }, owner, new AbortController().signal, status));
  const delayed = setup((_command, _page, _watch, control) => control.abort());
  await assert.rejects(delayed.session.history(scriptHash), /closed/);
  const revoked = setup();
  revoked.session.close();
  await assert.rejects(revoked.session.history(scriptHash), /closed/);
});
test('private replies enforce script identity, amounts, chronological order, page size and cursors', async () => {
  for (const modify of [p => { p.scriptHash = owner; }, p => p.rows.reverse(), p => p.rows.push(p.rows[0]),
    p => { p.rows[0].value = -1; }, p => { p.rows[0].height = 12; }, p => { p.next = owner; }]) {
    await assert.rejects(setup((_q, page) => modify(page)).session.unspent(scriptHash), /Invalid/);
  }
});
