'use strict';

/**
 * Run with: npm test (from server/).
 *
 * An edit to a lightning-first wallet's primary answers once the restarted
 * daemon is linked with its primary again, as the phone's engine does, so
 * the app's read right after the save sees the connection rather than the
 * moment before it. The wait is bounded, ends on a failed or stopped start,
 * and is never taken by an edit that leaves the primary alone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const PK_P = '03' + '22'.repeat(32);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function managerWith(records) {
	const m = Object.create(WalletManager.prototype);
	const store = { ...records };
	m.registry = {
		get: (id) => store[id],
		list: () => Object.values(store),
		upsert: (r) => {
			store[r.id] = r;
		}
	};
	m.runtime = new Map();
	m.channelLogs = new Map();
	m.fallbackLogs = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.lfbwSupported = true;
	m.engineVersion = '0.10.0';
	m.settings = { get: () => ({ defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: [] }) };
	m.onion = null;
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	m.paths = () => ({ base: '/nonexistent' });
	return { m, store };
}

const primary = () => ({
	id: 'p1',
	name: 'Primary',
	network: 'regtest',
	port: 3901,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	liquidityProvider: true,
	nodeId: PK_P,
	recovery: { mode: 'off', guardians: [] }
});
const wallet = () => ({
	id: 'w1',
	name: 'Spending',
	network: 'regtest',
	port: 3902,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	recovery: { mode: 'off', guardians: [] },
	lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1', primaryUri: null, setup: 'ready' }
});

/**
 * A running w1 whose restart spawns a new child after `spawnMs` and links it
 * with the primary `linkMs` later, as the startup poll and setup would.
 */
function running({ spawnMs = 20, linkMs = 60 } = {}) {
	const { m, store } = managerWith({ p1: primary(), w1: wallet() });
	const rt = m.runtimeState('w1');
	rt.proc = { pid: 1 };
	m.restarts = 0;
	m._restartWallet = async () => {
		m.restarts++;
		rt.proc = null;
		rt.spawning = true;
		setTimeout(() => {
			rt.spawning = false;
			rt.proc = { pid: 2 };
			const done = sleep(linkMs).then(() => {
				store.w1.lfbw.setup = 'ready';
				store.w1.lfbw.setupAt = new Date().toISOString();
			});
			rt.linksRestored = { proc: rt.proc, done };
		}, spawnMs);
	};
	return { m, store, rt };
}

test('a primary edit answers once the restarted wallet is linked with its primary', async () => {
	const { m, store } = running();
	const t0 = Date.now();
	const out = await m.updateWallet('w1', { lfbw: { enabled: true, primaryWalletId: 'p1', trusted: false } });
	assert.equal(m.restarts, 1);
	assert.ok(Date.now() - t0 >= 70, 'it waited for the spawn and the link');
	assert.equal(out.lfbw.setup, 'ready', 'the answer describes the wallet as it is linked');
	assert.ok(store.w1.lfbw.setupAt);
});

test('an edit that leaves the primary alone answers at the restart', async () => {
	const { m } = running({ spawnMs: 5000 });
	const t0 = Date.now();
	await m.updateWallet('w1', { name: 'Renamed' });
	assert.equal(m.restarts, 1);
	assert.ok(Date.now() - t0 < 1000, 'no wait for a link nobody changed');
});

test('a stopped wallet is not restarted and nothing is waited for', async () => {
	const { m } = managerWith({ p1: primary(), w1: wallet() });
	let restarted = false;
	m._restartWallet = async () => {
		restarted = true;
	};
	const t0 = Date.now();
	await m.updateWallet('w1', { lfbw: { enabled: true, primaryWalletId: 'p1' } });
	assert.equal(restarted, false);
	assert.ok(Date.now() - t0 < 1000);
});

test('the wait ends at its deadline, on a failed start, and when no child is coming', async () => {
	const { m } = managerWith({ w1: wallet() });
	const rt = m.runtimeState('w1');

	rt.proc = { pid: 3 };
	let t0 = Date.now();
	await m._awaitPrimaryLink('w1', 300);
	assert.ok(Date.now() - t0 >= 290 && Date.now() - t0 < 1500, 'a child that never links is waited on until the deadline');

	rt.linksRestored = { proc: rt.proc, done: new Promise(() => {}) };
	t0 = Date.now();
	await m._awaitPrimaryLink('w1', 300);
	assert.ok(Date.now() - t0 >= 290 && Date.now() - t0 < 1500, 'a link that never finishes is bounded too');

	rt.linksRestored = { proc: { pid: 'old' }, done: Promise.resolve() };
	rt.proc = null;
	rt.spawning = true;
	rt.status = 'error';
	t0 = Date.now();
	await m._awaitPrimaryLink('w1', 5000);
	assert.ok(Date.now() - t0 < 500, 'a failed start ends the wait');

	rt.status = 'waiting-electrum';
	rt.spawning = false;
	t0 = Date.now();
	await m._awaitPrimaryLink('w1', 5000);
	assert.ok(Date.now() - t0 < 500, 'no child spawning and none coming ends the wait');
});

test('the link a primary edit waits on is the setup, not the offline-receive return after it', async () => {
	const { m } = managerWith({ w1: wallet() });
	const rt = m.runtimeState('w1');
	rt.proc = { pid: 4 };
	const order = [];
	let releaseReturn;
	m._captureNodeId = async () => order.push('node id');
	m._restoreLfbwLinks = async () => order.push('links');
	m._fforReturn = () =>
		new Promise((resolve) => {
			releaseReturn = resolve;
		});
	const healthy = m._onHealthy('w1');
	assert.equal(rt.linksRestored.proc, rt.proc, 'recorded for the child that came up');
	await rt.linksRestored.done;
	assert.deepEqual(order, ['node id', 'links']);
	await m._awaitPrimaryLink('w1', 5000);
	releaseReturn();
	await healthy;

	// A failed setup still ends the wait; the record carries the failure.
	rt.proc = { pid: 5 };
	m._restoreLfbwLinks = async () => {
		throw new Error('primary unreachable');
	};
	m._fforReturn = async () => {};
	await assert.rejects(m._onHealthy('w1'), /primary unreachable/);
	await rt.linksRestored.done;
});
