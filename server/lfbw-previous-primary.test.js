'use strict';

/**
 * Run with: npm test (from server/).
 *
 * Re-pointing a lightning-first wallet's primary (umbrel #86): the old
 * primary is remembered while a channel with it exists, forgotten once it
 * is gone, and the two manager moves that finish the job: closing the old
 * channel so the funds move home, and closing the home channel with
 * lightning-first turned off first so the funds stay on-chain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lfbw = require('./lfbw');
const { WalletManager } = require('./wallet-manager');

const PK_OLD = '03' + '11'.repeat(32);
const PK_NEW = '03' + '22'.repeat(32);

const existing = (extra = {}) => ({
	enabled: true,
	mode: 'internal',
	primaryWalletId: 'p1',
	primaryUri: null,
	primaryPubkey: PK_OLD,
	trusted: true,
	setup: 'ready',
	previousPrimary: null,
	...extra
});
const block = (extra = {}) => ({
	enabled: true,
	mode: 'internal',
	primaryWalletId: 'p2',
	primaryUri: null,
	primaryPubkey: PK_NEW,
	...extra
});

test('a changed primary is remembered with its pubkey, wallet and time', () => {
	const prev = lfbw.previousPrimaryAfterEdit(existing(), block(), false, 1000);
	assert.deepEqual(prev, { pubkey: PK_OLD, walletId: 'p1', at: 1000 });
});

test('an external previous primary carries no wallet id', () => {
	const prev = lfbw.previousPrimaryAfterEdit(
		existing({ mode: 'external', primaryWalletId: null, primaryUri: `${PK_OLD}@h:1` }),
		block(),
		false,
		1000
	);
	assert.deepEqual(prev, { pubkey: PK_OLD, walletId: null, at: 1000 });
});

test('the same primary carries the remembered one forward; switching back forgets it', () => {
	const remembered = { pubkey: PK_NEW, walletId: 'p2', at: 5 };
	assert.deepEqual(lfbw.previousPrimaryAfterEdit(existing({ previousPrimary: remembered }), block({ primaryPubkey: PK_OLD, primaryWalletId: 'p1' }), true), remembered);
	assert.equal(lfbw.previousPrimaryAfterEdit(existing({ previousPrimary: remembered }), block(), false), null);
});

test('a wallet that was not lightning-first, or whose primary had no pubkey yet, remembers nothing', () => {
	assert.equal(lfbw.previousPrimaryAfterEdit(null, block(), false), null);
	assert.equal(lfbw.previousPrimaryAfterEdit({ enabled: false }, block(), false), null);
	assert.equal(lfbw.previousPrimaryAfterEdit(existing({ primaryPubkey: null }), block(), false), null);
});

test('normalizeLfbw records the previous primary on an internal re-point and keeps it on an unrelated edit', () => {
	const records = {
		p1: { id: 'p1', name: 'Old', network: 'regtest', nodeId: PK_OLD, onchainOnly: false },
		p2: { id: 'p2', name: 'New', network: 'regtest', nodeId: PK_NEW, onchainOnly: false }
	};
	const opts = { network: 'regtest', selfId: 'w1', available: true, getRecord: (id) => records[id] };
	const first = lfbw.normalizeLfbw({ enabled: true, primaryWalletId: 'p1' }, opts);
	assert.equal(first.previousPrimary, null);
	const ready = { ...first, setup: 'ready' };
	const moved = lfbw.normalizeLfbw({ enabled: true, primaryWalletId: 'p2' }, { ...opts, existing: ready });
	assert.equal(moved.previousPrimary.pubkey, PK_OLD);
	assert.equal(moved.previousPrimary.walletId, 'p1');
	assert.equal(moved.setup, 'pending', 'a new primary re-runs setup');
	const trustEdit = lfbw.normalizeLfbw({ enabled: true, primaryWalletId: 'p2', trusted: false }, { ...opts, existing: moved });
	assert.deepEqual(trustEdit.previousPrimary, moved.previousPrimary);
	const back = lfbw.normalizeLfbw({ enabled: true, primaryWalletId: 'p1' }, { ...opts, existing: moved });
	assert.equal(back.previousPrimary, null, 'switching back to the remembered primary forgets it');
});

test('previousPrimaryDone is true only when no live channel with that pubkey remains', () => {
	const prev = { pubkey: PK_OLD, walletId: 'p1', at: 1 };
	assert.equal(lfbw.previousPrimaryDone(prev, [{ peerPubkey: PK_OLD, state: 'NORMAL' }]), false);
	assert.equal(lfbw.previousPrimaryDone(prev, [{ peerPubkey: PK_OLD, state: 'NEGOTIATING_CLOSING' }]), false);
	assert.equal(lfbw.previousPrimaryDone(prev, [{ peerPubkey: PK_OLD, state: 'CLOSED' }]), true);
	assert.equal(lfbw.previousPrimaryDone(prev, [{ peerPubkey: PK_NEW, state: 'NORMAL' }]), true);
	assert.equal(lfbw.previousPrimaryDone(null, []), true);
});

/** A manager with one lightning-first wallet, no daemon spawned. */
function harness({ answers = {}, lf = {} } = {}) {
	const rec = {
		id: 'w1',
		name: 'Spending',
		network: 'regtest',
		port: 3902,
		nodeId: '02' + '99'.repeat(32),
		electrum: { host: 'h', port: 1, tls: false },
		lfbw: {
			enabled: true,
			mode: 'internal',
			primaryWalletId: 'p2',
			primaryPubkey: PK_NEW,
			trusted: true,
			setup: 'ready',
			previousPrimary: { pubkey: PK_OLD, walletId: 'p1', at: 1 },
			...lf
		}
	};
	const m = Object.create(WalletManager.prototype);
	const store = { w1: rec };
	m.upserts = [];
	m.registry = { get: (id) => store[id], list: () => Object.values(store), upsert: (r) => m.upserts.push({ ...r, lfbw: r.lfbw && { ...r.lfbw } }) };
	m.runtime = new Map();
	m.runtimeState('w1').proc = { pid: 1 };
	m.runtimeState('w1').healthy = true;
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.onionAddress = () => null;
	m.listenPort = () => 9901;
	m.lfbwAvailable = () => true;
	m.torCircuitOk = null;
	m.restarts = 0;
	m._restartWallet = async () => {
		m.restarts += 1;
	};
	m._waitDaemonHealthy = async () => {};
	m.calls = [];
	m._daemonCall = async (r, method, path, body) => {
		m.calls.push({ method, path, body });
		const key = `${method} ${path}`;
		if (answers[key] instanceof Error) throw answers[key];
		if (answers[key] !== undefined) return answers[key];
		return {};
	};
	return { m, rec };
}

const oldOpen = { channelId: 'old1', peerPubkey: PK_OLD, state: 'NORMAL', htlcUsable: true, localBalanceSats: 120000 };
const home = { channelId: 'home', peerPubkey: PK_NEW, state: 'NORMAL', htlcUsable: true, localBalanceSats: 200000 };

test('moveHome closes every open channel with the previous primary and nothing else', async () => {
	const { m } = harness({ answers: { 'GET /channels': [oldOpen, home, { ...oldOpen, channelId: 'old2' }] } });
	const r = await m.moveHome('w1');
	assert.deepEqual(r, { closed: ['old1', 'old2'], pubkey: PK_OLD });
	const closes = m.calls.filter((c) => c.path === '/channel/close').map((c) => c.body.channelId);
	assert.deepEqual(closes, ['old1', 'old2']);
});

test('moveHome refuses when there is no previous primary, and when its channel is already closing', async () => {
	const none = harness({ lf: { previousPrimary: null } });
	await assert.rejects(() => none.m.moveHome('w1'), (e) => e.code === 'NO_PREVIOUS_PRIMARY');
	const closing = harness({ answers: { 'GET /channels': [{ ...oldOpen, state: 'NEGOTIATING_CLOSING', htlcUsable: false }, home] } });
	await assert.rejects(() => closing.m.moveHome('w1'), (e) => e.code === 'NO_PREVIOUS_CHANNEL');
	assert.equal(closing.m.calls.some((c) => c.path === '/channel/close'), false);
});

test('moveHome forgets a previous primary whose channel is already gone, and says so', async () => {
	const { m, rec } = harness({ answers: { 'GET /channels': [home] } });
	await assert.rejects(() => m.moveHome('w1'), (e) => e.code === 'NO_PREVIOUS_CHANNEL');
	assert.equal(rec.lfbw.previousPrimary, null);
	assert.equal(m.upserts.length, 1);
});

test('the channelize pass forgets the previous primary once its channel is gone, even below the floor', async () => {
	const { m, rec } = harness({
		answers: { 'GET /balance': { onchain: 1000 }, 'GET /channels': [home] }
	});
	await m._lfbwChannelize('w1');
	assert.equal(rec.lfbw.previousPrimary, null);
	assert.ok(m.logs.some((l) => /previous primary is gone/.test(l)));
});

test('the channelize pass keeps the previous primary when the channel list cannot be read', async () => {
	// A transient daemon error is not an empty channel list: forgetting the
	// previous primary on it would persist the loss for good.
	const { m, rec } = harness({
		answers: {
			'GET /balance': { onchain: 50000 },
			'GET /utxos': [{ height: 90 }],
			'GET /channels': new Error('socket hang up')
		}
	});
	await m._lfbwChannelize('w1');
	assert.deepEqual(rec.lfbw.previousPrimary, { pubkey: PK_OLD, walletId: 'p1', at: 1 });
	assert.equal(m.upserts.some((u) => u.lfbw && u.lfbw.previousPrimary === null), false, 'nothing persisted it as gone');
	assert.equal(m.logs.some((l) => /previous primary is gone/.test(l)), false);
});

test('closeHome with turnOff drops lightning-first, restarts the daemon, then closes on the restarted one', async () => {
	const { m, rec } = harness();
	const order = [];
	m._restartWallet = async () => order.push('restart');
	m._waitDaemonHealthy = async () => order.push('healthy');
	const call = m._daemonCall;
	m._daemonCall = async (...args) => {
		if (args[2] === '/channel/close') order.push('close');
		return call(...args);
	};
	const r = await m.closeHome('w1', { channelId: 'home', turnOff: true });
	assert.equal(rec.lfbw, null, 'the record is no longer lightning-first');
	assert.deepEqual(order, ['restart', 'healthy', 'close']);
	assert.equal(r.lfbwOff, true);
	assert.equal(r.record.lfbw, null);
});

test('closeHome without turnOff closes and leaves the record alone', async () => {
	const { m, rec } = harness();
	const r = await m.closeHome('w1', { channelId: 'home' });
	assert.equal(m.restarts, 0);
	assert.ok(rec.lfbw.enabled);
	assert.equal(r.lfbwOff, false);
	assert.deepEqual(m.calls.filter((c) => c.path === '/channel/close').map((c) => c.body), [{ channelId: 'home' }]);
});
