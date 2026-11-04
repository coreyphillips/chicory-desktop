'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A stop that lands while a start is still probing Electrum. stopWallet
 * flips rt.stopping, writes running=false and finds no child to kill; the
 * start then came back from its probe, spawned anyway and wrote
 * running=true, leaving a daemon up that the owner had just stopped. The
 * start must notice the stop after every await and give way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// wallet-manager takes spawn off child_process at load, so the stub has
// to be in place before it is required.
const spawned = [];
cp.spawn = (cmd, args, opts) => {
	spawned.push({ cmd, args, opts });
	return { pid: 1, stdout: { on() {} }, stderr: { on() {} }, on() {} };
};
const { WalletManager } = require('./wallet-manager');

function harness() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-start-'));
	fs.writeFileSync(path.join(base, 'mnemonic'), 'seed words\n');
	const rec = {
		id: 'w1',
		name: 'Test wallet',
		network: 'regtest',
		electrum: { host: '127.0.0.1', port: 50001, tls: false },
		port: 3001,
		running: true
	};
	const m = Object.create(WalletManager.prototype);
	m.upserts = [];
	m.registry = { get: (id) => (id === 'w1' ? rec : undefined), list: () => [rec], upsert: (r) => m.upserts.push({ ...r }) };
	m.runtime = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.paths = () => ({ base, home: base, data: base, secrets: base, mnemonicFile: path.join(base, 'mnemonic') });
	m.token = () => 't';
	m._daemonEnv = () => ({});
	m._clearStaleInstanceLock = () => {};
	// Host port probing has its own tests; these are about stop ordering.
	m._busyPort = async () => null;
	m._startEvents = () => {};
	m._stopEvents = () => {};
	m._stopLfbwWatch = () => {};
	m._pollHealth = async () => {};
	m._killProc = async () => {};
	let release;
	m._probeElectrum = () => new Promise((r) => (release = r));
	m.releaseProbe = (v) => release(v);
	return { m, rec };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a stop during the Electrum probe cancels the start: nothing spawns, running stays false', async () => {
	const { m, rec } = harness();
	const rt = m.runtimeState('w1');
	const starting = m.startWallet('w1');
	await tick();
	assert.equal(rt.spawning, true, 'the start is parked on the probe');
	await m.stopWallet('w1');
	assert.equal(rec.running, false);
	m.releaseProbe(true);
	await starting;
	try {
		assert.equal(spawned.length, 0, 'no daemon was spawned after the stop');
		assert.equal(rt.proc, null);
		assert.equal(rec.running, false, 'the record still says stopped');
		assert.equal(m.upserts.some((u) => u.running === true), false, 'nothing wrote running=true back');
		assert.equal(rt.status, 'stopped');
		assert.ok(m.logs.some((l) => /start cancelled: stop requested/.test(l)));
	} finally {
		if (rt.chainWatch) clearInterval(rt.chainWatch);
		if (rt.lfbwWatch) clearInterval(rt.lfbwWatch);
	}
});

test('a stop during a probe that finds Electrum down neither waits for it nor marks the wallet running', async () => {
	const { m, rec } = harness();
	const rt = m.runtimeState('w1');
	const starting = m.startWallet('w1');
	await tick();
	await m.stopWallet('w1');
	m.releaseProbe(false);
	await starting;
	try {
		assert.equal(rt.electrumWait, null, 'no deferred start was scheduled');
		assert.equal(rec.running, false);
		assert.equal(m.upserts.some((u) => u.running === true), false);
		assert.equal(rt.status, 'stopped');
	} finally {
		if (rt.electrumWait) clearTimeout(rt.electrumWait);
	}
});

test('desktop shutdown cancels a pending Electrum probe and refuses future starts', async () => {
	const { m, rec } = harness();
	const rt = m.runtimeState('w1');
	const starting = m.startWallet('w1');
	await tick();
	await m.shutdown();
	m.releaseProbe(true);
	await starting;
	assert.equal(rt.stopping, true);
	assert.equal(rt.proc, null);
	assert.equal(spawned.length, 0);
	assert.equal(rec.running, true, 'a normal app quit preserves the next-launch start preference');
	await assert.rejects(m.startWallet('w1'), { code: 'SHUTTING_DOWN' });
});
