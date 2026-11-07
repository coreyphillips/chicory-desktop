'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { FlorestaCollection, publicSnapshot } = require('./floresta-collection');

const descriptor = 'wpkh([12345678/84h/1h/0h]tpub' + 'A'.repeat(107) + '/0/*)#abcdefgh';
const view = { status: 'observed', coverageComplete: false, network: 'regtest', fromHeight: 0,
  descriptors: [{ descriptor, range: [0, 100] }], generation: 'ae'.repeat(32),
  scripts: ['0014' + '11'.repeat(20)], outpoints: [{ outpoint: 'ab'.repeat(32) + ':12', scriptHash: null }],
  unresolvedHashes: [], acknowledged: false };

function childFixture() {
  const child = new EventEmitter();
  child.connected = true;
  child.messages = [];
  child.reply = (request, result) => child.emit('message', { type: 'chicory-chain-reply/v1', id: request.id, result });
  child.send = (message, callback) => {
    child.messages.push(message);
    callback();
    if (message.action !== 'watch-snapshot') queueMicrotask(() => child.reply(message, {}));
  };
  return child;
}

test('private network collection follows opt-in, child replacement, closed wallets and disable during a poll', async () => {
  const child = childFixture();
  const other = childFixture();
  const rows = [{ network: 'regtest', id: 'private-wallet-id' }, { network: 'regtest', id: 'stopped-id' },
    { network: 'mainnet', id: 'other-id' }];
  const manager = { runtime: new Map([[rows[0].id, { proc: child }], [rows[2].id, { proc: other }]]),
    registry: { list: () => rows, get: id => rows.find(row => row.id === id) } };
  const bridge = new FlorestaCollection(manager);
  assert.deepEqual(await bridge.snapshots('regtest'), []);
  bridge.setEnabled('regtest', true);
  assert.equal(child.messages[0].action, 'enable-observation');
  assert.deepEqual(other.messages, []);
  const owner = createHash('sha256').update('regtest:private-wallet-id').digest('hex');
  const first = bridge.snapshots('regtest');
  assert.equal(bridge.snapshots('regtest'), first);
  child.reply(child.messages.at(-1), { ...view, mnemonic: 'private-wallet-id' });
  const wallets = await first;
  assert.deepEqual(wallets.find(w => w.owner === owner).snapshot, view);
  assert.equal(wallets.length, 2);
  assert.equal(wallets.find(w => w.owner !== owner).snapshot.status, 'engine-unavailable');
  assert.equal(JSON.stringify(wallets).includes('private-wallet-id'), false);
  const old = bridge.snapshots('regtest');
  const fresh = childFixture();
  manager.runtime.set(rows[0].id, { proc: fresh });
  child.reply(child.messages.at(-1), view);
  assert.equal((await old).find(w => w.owner === owner).snapshot.status, 'engine-unavailable');
  const interrupted = bridge.snapshots('regtest');
  const query = fresh.messages.at(-1);
  bridge.setEnabled('regtest', false);
  assert.equal(fresh.messages.at(-1).action, 'disable-observation');
  bridge.setEnabled('regtest', true);
  fresh.reply(query, view);
  assert.deepEqual(await interrupted, []);
});

test('manager forwards public fields only and caps its aggregate snapshot budget', () => {
  const publicView = publicSnapshot({ ...view, apiToken: 'sensitive', descriptors: [{ ...view.descriptors[0], key: 'sensitive' }],
    outpoints: [{ ...view.outpoints[0], signingKey: 'sensitive' }] }, 'regtest', { remaining: 65536 });
  assert.deepEqual(publicView, view);
  assert.equal(publicSnapshot(view, 'regtest', { remaining: 1 }).status, 'collection-incomplete');
  for (const invalid of [
    { descriptors: [{ descriptor: descriptor.replace('tpub', 'tprv'), range: [0, 2] }] },
    { descriptors: [{ descriptor, range: [0, 0x80000000] }] },
    { outpoints: [{ outpoint: 'ab'.repeat(32) + ':4294967296', scriptHash: null }] },
    { scripts: ['wallet secret'] }, { network: 'mainnet' }, { generation: null }, { coverageComplete: true },
  ]) assert.equal(publicSnapshot({ ...view, ...invalid }, 'regtest', { remaining: 65536 }).status, 'engine-unavailable');
});

test('desktop journal changes advance the registration generation; unreadable journals yield incomplete coverage', async () => {
  const child = childFixture();
  const rec = { network: 'regtest', id: 'wallet' };
  const bridge = new FlorestaCollection({ registry: { list: () => [rec], get: () => rec },
    runtime: new Map([[rec.id, { proc: child }]]) });
  bridge.setEnabled('regtest', true);
  const read = async () => {
    const pending = bridge.snapshots('regtest');
    child.reply(child.messages.at(-1), view);
    return (await pending)[0].snapshot;
  };
  bridge.desktopWatches = () => [{ scripts: [], outpoints: [] }];
  assert.equal((await read()).generation, view.generation);
  bridge.desktopWatches = () => [{ scripts: ['51'], outpoints: [{ txid: '12'.repeat(32), vout: 4 }] }];
  const merged = await read();
  assert.ok(merged.scripts.includes('51'));
  assert.deepEqual(merged.outpoints[0], { outpoint: '12'.repeat(32) + ':4', scriptHash: null });
  assert.notEqual(merged.generation, view.generation);
  assert.equal((await read()).generation, merged.generation);
  bridge.desktopWatches = () => { throw new Error('private data'); };
  assert.deepEqual(await read(), { status: 'collection-incomplete', coverageComplete: false });
});
