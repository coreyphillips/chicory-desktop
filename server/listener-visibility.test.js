'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A daemon whose Lightning listen port did not bind still answers ready, and
 * a guardian on it still answers serving, because the engine treats a failed
 * bind as non-fatal and reports it nowhere except GET /info.listening
 * (beignet #861). Nothing here could see that, so the wallet read healthy
 * while no peer could reach it: a guardian pinned by its URI answered
 * GUARDIAN_UNREACHABLE, and every explanation pointed at the other end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

function managerWith(rec, rt = {}) {
	const m = Object.create(WalletManager.prototype);
	m.registry = { get: () => rec, upsert: () => {} };
	m.runtime = new Map([[rec.id, rt]]);
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	return m;
}

const wallet = () => ({ id: 'w1', name: 'Guardian 1', port: 3911, electrum: {} });

test('a listener that did not bind is logged once, naming the port', () => {
	const m = managerWith(wallet());
	m._noteListener('w1', { nodeId: 'ab', listening: false });
	assert.equal(m.runtime.get('w1').listening, false);
	assert.equal(m.logs.length, 1);
	assert.match(m.logs[0], /no Lightning listener/);
	assert.match(m.logs[0], /9911/, 'the log names the port that did not bind');

	// Still down on the next poll: the operator does not need it repeated.
	m._noteListener('w1', { nodeId: 'ab', listening: false });
	assert.equal(m.logs.length, 1);
});

test('a listener that bound is recorded and says nothing', () => {
	const m = managerWith(wallet());
	m._noteListener('w1', { nodeId: 'ab', listening: true });
	assert.equal(m.runtime.get('w1').listening, true);
	assert.deepEqual(m.logs, []);
});

test('a daemon that omits the field is treated as listening', () => {
	// An older engine has no `listening` on /info. Absence is not a failure.
	const m = managerWith(wallet());
	m._noteListener('w1', { nodeId: 'ab' });
	assert.equal(m.runtime.get('w1').listening, true);
	assert.deepEqual(m.logs, []);
});

test('coming back up after a failed bind is logged as the change it is', () => {
	const m = managerWith(wallet(), { listening: false });
	m._noteListener('w1', { nodeId: 'ab', listening: true });
	assert.equal(m.runtime.get('w1').listening, true);
	assert.deepEqual(m.logs, [], 'recovery is not a warning');
});

test('publicRecord carries the listener state, and null before it is known', () => {
	const rec = { ...wallet(), running: true, createdAt: 0 };
	const m = managerWith(rec, { status: 'running', healthy: true });
	m.listenPort = WalletManager.prototype.listenPort.bind(m);
	m._dependents = () => [];
	m._reach = () => null;
	m.onionAddress = () => null;
	assert.equal(m.publicRecord('w1').listening, null);
	m.runtime.get('w1').listening = false;
	assert.equal(m.publicRecord('w1').listening, false);
});

test('an on-chain only wallet has no listener to report', () => {
	const rec = { ...wallet(), onchainOnly: true, running: true, createdAt: 0 };
	const m = managerWith(rec, { status: 'running', healthy: true, listening: false });
	m.listenPort = WalletManager.prototype.listenPort.bind(m);
	m._dependents = () => [];
	m._reach = () => null;
	m.onionAddress = () => null;
	assert.equal(m.publicRecord('w1').listening, null);
});
