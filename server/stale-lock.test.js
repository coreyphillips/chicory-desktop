'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The engine's single-instance lock records {pid, hostname} but verifies
 * liveness by probing the pid in the current pid namespace, so a lock left
 * by a hard-killed daemon in a PREVIOUS container can point at an unrelated
 * live process after an app update recreates the container, and the wallet
 * refuses to start forever. The manager clears exactly that case before
 * spawning: a lock naming another hostname goes, everything else stays.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WalletManager } = require('./wallet-manager');

function managerInTmp() {
	const m = Object.create(WalletManager.prototype);
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	const data = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-lock-test-'));
	return { m, data, rec: { id: 'w1', network: 'mainnet' }, p: { data } };
}

test('a lock from another container (hostname mismatch) is cleared', () => {
	const { m, data, rec, p } = managerInTmp();
	const lock = path.join(data, 'mainnet.lock');
	fs.writeFileSync(
		lock,
		JSON.stringify({ pid: 23, hostname: 'dead-container', createdAt: 1 })
	);
	m._clearStaleInstanceLock(rec, p);
	assert.equal(fs.existsSync(lock), false);
	assert.ok(m.logs.some((l) => l.includes('cleared stale instance lock')));
});

test('a lock from THIS host is left for the engine to judge', () => {
	const { m, data, rec, p } = managerInTmp();
	const lock = path.join(data, 'mainnet.lock');
	fs.writeFileSync(
		lock,
		JSON.stringify({ pid: 23, hostname: os.hostname(), createdAt: 1 })
	);
	m._clearStaleInstanceLock(rec, p);
	assert.equal(fs.existsSync(lock), true, 'same-host liveness is pid-checkable');
	assert.equal(m.logs.length, 0);
});

test('no lock and corrupt lock are both quiet no-ops', () => {
	const { m, data, rec, p } = managerInTmp();
	m._clearStaleInstanceLock(rec, p);
	const lock = path.join(data, 'mainnet.lock');
	fs.writeFileSync(lock, 'not json');
	m._clearStaleInstanceLock(rec, p);
	assert.equal(fs.existsSync(lock), true, 'the engine reclaims corrupt locks');
	assert.equal(m.logs.length, 0);
});
