'use strict';

/**
 * Run with: npm test (from server/).
 *
 * Several ranked primary nodes on the desktop manager
 * (coreyphillips/beignet#1924): a record from before the list reads as one
 * entry and nothing else changes for it; the record rules for the list; the
 * setup that seeds an empty engine, trusts and dials every entry and keeps
 * the wallet ready while a lower-ranked node is away; the engine's list
 * taken as read once synced, direct funding following its head; the record
 * following a write the dashboard made at the engine; and channelize moving
 * a deposit toward the receive target.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lfbw = require('./lfbw');
const { WalletManager } = require('./wallet-manager');
const { requiresTor } = require('./desktop-network');
const { createOfflineCapacity } = require('./offline-capacity');

const PK_W = '02' + '11'.repeat(32);
const PK_P = '03' + '22'.repeat(32);
const PK_A = '02' + '33'.repeat(32);
const PK_B = '03' + '44'.repeat(32);
const PK_C = '02' + '55'.repeat(32);
const URI_A = `${PK_A}@a.example:9735`;
const URI_B = `${PK_B}@b.example:9736`;
const URI_C = `${PK_C}@c.example:9737`;
const ONION = 'b'.repeat(56) + '.onion';

const normalize = (input, extra = {}) =>
	lfbw.normalizeLfbw(input, { network: 'regtest', selfId: 'w1', available: true, irohAvailable: true, getRecord: () => null, ...extra });

const legacy = (extra = {}) => ({
	enabled: true,
	mode: 'external',
	primaryWalletId: null,
	primaryUri: URI_A,
	primaryFallbackUri: null,
	primaryPubkey: PK_A,
	trusted: true,
	initialChannelSats: 0,
	initialChannelOpened: false,
	setup: 'ready',
	setupError: null,
	setupAt: '2026-11-01T00:00:00.000Z',
	previousPrimary: null,
	...extra
});

test('a block from before the list reads as the one entry it named, once, with its scalar fields untouched', () => {
	const migrated = lfbw.migratePrimaries(legacy());
	assert.deepEqual(migrated.primaries, [
		{ pubkey: PK_A, walletId: null, uri: URI_A, fallbackUri: null, trusted: true, setup: 'ready', setupError: null, setupAt: '2026-11-01T00:00:00.000Z' }
	]);
	assert.equal(migrated.primariesThresholdSat, null);
	assert.equal(migrated.primariesReceiveTarget, null);
	assert.equal(migrated.primariesSyncedAt, null, 'the engine has not been made to agree yet');
	const { primaries, primariesThresholdSat, primariesReceiveTarget, primariesSyncedAt, ...scalars } = migrated;
	assert.deepEqual(scalars, legacy(), 'every field a one-primary reader knows is as it was');
	assert.equal(lfbw.migratePrimaries(migrated), migrated, 'idempotent');
	const internal = lfbw.migratePrimaries(legacy({ mode: 'internal', primaryWalletId: 'p1', primaryUri: null, primaryPubkey: PK_P }));
	assert.deepEqual(internal.primaries.map((e) => [e.walletId, e.pubkey, e.uri]), [['p1', PK_P, null]]);
	assert.deepEqual(lfbw.migratePrimaries(legacy({ primaryUri: null, primaryPubkey: null })).primaries, [], 'a block naming no primary lists none');
	assert.equal(lfbw.migratePrimaries({ enabled: false }).primaries, undefined);
	assert.equal(lfbw.migratePrimaries(null), null);
});

test('the keys, the Iroh test and the Tor demand read every ranked entry, and fall back to the one primary', () => {
	const two = { ...lfbw.migratePrimaries(legacy()), primaries: [{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_B, uri: `${PK_B}@iroh:${'8e'.repeat(32)}`, fallbackUri: `${PK_B}@${ONION}:9735` }] };
	assert.deepEqual(lfbw.primaryPubkeys(two), [PK_A, PK_B]);
	assert.deepEqual(lfbw.primaryPubkeys(legacy()), [PK_A]);
	assert.deepEqual(lfbw.primaryPubkeys({ enabled: false, primaryPubkey: PK_A }), []);
	assert.equal(lfbw.isIrohPrimary(two), true, 'an Iroh node at rank 2 needs the endpoint');
	assert.equal(lfbw.isIrohPrimary(lfbw.migratePrimaries(legacy())), false);
	assert.equal(requiresTor({ lfbw: two }), true, 'the onion fallback of the second node warms Tor');
	assert.equal(requiresTor({ lfbw: { ...two, primaries: [{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_B, uri: URI_B }] } }), false);
	assert.equal(requiresTor({ lfbw: { ...two, primaries: [{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_B, uri: `${PK_B}@${ONION}:9735` }] } }), true);
});

test('a lightning-first request may list the ranked primaries; the first is the block\'s primary and the others keep their state', () => {
	const block = normalize({ enabled: true, primaries: [{ uri: URI_A }, { uri: URI_B, trusted: false }] });
	assert.equal(block.primaryUri, URI_A);
	assert.equal(block.primaryPubkey, PK_A);
	assert.equal(block.trusted, true);
	assert.deepEqual(block.primaries.map((e) => [e.pubkey, e.uri, e.trusted, e.setup]), [[PK_A, URI_A, true, 'pending'], [PK_B, URI_B, false, 'pending']]);
	assert.equal(block.primariesSyncedAt, null);
	assert.equal(block.primariesThresholdSat, null);
	// Re-normalizing the same list against the block keeps every entry's state and the sync stamp.
	const synced = { ...block, primariesSyncedAt: 't1', primariesReceiveTarget: PK_B, primaries: block.primaries.map((e) => ({ ...e, setup: 'ready', setupAt: 't0' })) };
	const same = normalize({ enabled: true, primaries: [{ uri: URI_A }, { uri: URI_B, trusted: false }] }, { existing: synced });
	assert.deepEqual(same.primaries.map((e) => e.setup), ['ready', 'ready']);
	assert.equal(same.primariesSyncedAt, 't1');
	assert.equal(same.primariesReceiveTarget, PK_B);
	// A scalar edit replaces rank 1 and keeps the others; the engine is made to agree at the next setup.
	const replaced = normalize({ enabled: true, primaryUri: URI_C }, { existing: synced });
	assert.deepEqual(replaced.primaries.map((e) => [e.pubkey, e.setup]), [[PK_C, 'pending'], [PK_B, 'ready']]);
	assert.equal(replaced.primaryPubkey, PK_C);
	assert.equal(replaced.primariesSyncedAt, null);
	assert.equal(replaced.primariesReceiveTarget, null);
	assert.deepEqual(replaced.previousPrimary && replaced.previousPrimary.pubkey, PK_A, 'the old rank 1 is remembered as before');
	// Promoting rank 2 by the scalar edit keeps one entry per node.
	const promoted = normalize({ enabled: true, primaryUri: URI_B }, { existing: synced });
	assert.deepEqual(promoted.primaries.map((e) => e.pubkey), [PK_B]);
	// The threshold travels with the request, or stays.
	assert.equal(normalize({ enabled: true, primaryUri: URI_A, primariesThresholdSat: 250000 }).primariesThresholdSat, 250000);
	assert.equal(normalize({ enabled: true, primaryUri: URI_A }, { existing: { ...synced, primariesThresholdSat: 7 } }).primariesThresholdSat, 7);
	assert.equal(normalize({ enabled: true, primaryUri: URI_A, primariesThresholdSat: null }, { existing: { ...synced, primariesThresholdSat: 7 } }).primariesThresholdSat, null);
	// A legacy block as `existing` is read as one entry first.
	const fromLegacy = normalize({ enabled: true, primaryUri: URI_A, trusted: false }, { existing: legacy() });
	assert.deepEqual(fromLegacy.primaries.map((e) => [e.pubkey, e.setup, e.trusted]), [[PK_A, 'ready', false]]);
	assert.equal(fromLegacy.setup, 'ready');
	const refused = (input) => assert.throws(() => normalize(input), (err) => err.status === 400 && err.code === 'BAD_LFBW_PEER');
	refused({ enabled: true, primaries: [] });
	refused({ enabled: true, primaries: [{ uri: URI_A }, { uri: URI_A }] });
	refused({ enabled: true, primaries: Array.from({ length: lfbw.MAX_PRIMARIES + 1 }, (_, i) => ({ uri: `${(i % 2 ? '02' : '03') + i.toString(16).padStart(64, '0')}@h${i}.example:9735` })) });
	refused({ enabled: true, primaries: [{ uri: URI_A }, { uri: 'garbage' }] });
	assert.throws(
		() => normalize({ enabled: true, primaries: [{ uri: URI_A }, { uri: `${PK_B}@iroh:${'8e'.repeat(32)}` }] }, { irohAvailable: false }),
		(err) => err.code === 'IROH_UNSUPPORTED'
	);
});

test('the setup state over the entries, the entry a deposit moves toward, and who depends on a sibling', () => {
	const ready = { pubkey: PK_A, setup: 'ready' };
	const failed = { pubkey: PK_B, setup: 'failed', setupError: 'dial failed' };
	assert.deepEqual(lfbw.aggregateSetup([ready, failed]), { setup: 'ready', setupError: 'dial failed' });
	assert.deepEqual(lfbw.aggregateSetup([failed, ready]), { setup: 'ready', setupError: 'dial failed' });
	assert.deepEqual(lfbw.aggregateSetup([failed, { ...failed, pubkey: PK_C, setupError: 'other' }]), { setup: 'failed', setupError: 'dial failed' });
	assert.deepEqual(lfbw.aggregateSetup([{ pubkey: PK_A, setup: 'pending' }, failed]), { setup: 'pending', setupError: 'dial failed' });
	assert.deepEqual(lfbw.aggregateSetup([]), { setup: 'pending', setupError: null });
	const lf = { enabled: true, primaries: [ready, { pubkey: PK_B, setup: 'ready' }], primariesReceiveTarget: PK_B };
	assert.equal(lfbw.receiveTargetEntry(lf).pubkey, PK_B);
	assert.equal(lfbw.receiveTargetEntry({ ...lf, primaries: [ready, failed] }).pubkey, PK_A, 'a target that is not set up is not moved toward');
	assert.equal(lfbw.receiveTargetEntry({ ...lf, primaries: [ready] }).pubkey, PK_A, 'one entry: rank 1 whatever the target says');
	assert.equal(lfbw.receiveTargetEntry(legacy()), null);
	const sibling = { id: 'p1', nodeId: PK_P };
	const atRankTwo = { id: 'w1', lfbw: { enabled: true, mode: 'external', primaryWalletId: null, primaries: [{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_P, walletId: 'p1' }] } };
	assert.deepEqual(lfbw.dependentsOf(sibling, [sibling, atRankTwo]).map((r) => r.id), ['w1']);
});

test('the engine writes that make its list agree with the record, and the record entries the engine list reads as', () => {
	const rowA = { pubkey: PK_A, host: 'a.example', port: 9735 };
	const rowB = { pubkey: PK_B, host: 'b.example', port: 9736 };
	const irohB = { pubkey: PK_B, uri: `${PK_B}@iroh:${'8e'.repeat(32)}` };
	const info = (primaries, fillThresholdSat = null) => ({ primaries: primaries.map((p, i) => ({ ...p, rank: i + 1 })), fillThresholdSat, receiveTarget: primaries[0] ? primaries[0].pubkey : null });
	assert.deepEqual(lfbw.planPrimariesSync(info([]), [rowA, rowB], null), [{ op: 'add', row: rowA }, { op: 'add', row: rowB }]);
	assert.deepEqual(lfbw.planPrimariesSync(info([rowA, rowB]), [rowA, rowB], null), [], 'an engine that agrees is written nothing');
	assert.deepEqual(lfbw.planPrimariesSync(info([{ ...rowA, host: undefined, port: undefined, uri: URI_A }]), [rowA], null), [], 'a row the engine reports by URI is the same address');
	assert.deepEqual(lfbw.planPrimariesSync(info([rowA, rowB]), [rowB, rowA], null), [{ op: 'reorder', order: [PK_B, PK_A] }]);
	assert.deepEqual(lfbw.planPrimariesSync(info([rowA, rowB]), [rowA], 5000), [{ op: 'remove', pubkey: PK_B }, { op: 'threshold', fillThresholdSat: 5000 }]);
	assert.deepEqual(
		lfbw.planPrimariesSync(info([rowA, rowB]), [{ ...rowA, port: 9999 }, rowB], null),
		[{ op: 'remove', pubkey: PK_A }, { op: 'add', row: { ...rowA, port: 9999 } }, { op: 'reorder', order: [PK_A, PK_B] }],
		'a moved address is removed and added again, then put back in rank'
	);
	assert.deepEqual(lfbw.planPrimariesSync(info([rowA], 5000), [rowA], null), [{ op: 'threshold', fillThresholdSat: null }]);
	assert.deepEqual(lfbw.planPrimariesSync(info([rowA, irohB]), [rowA, irohB], null), []);

	const prior = [{ pubkey: PK_A, walletId: null, uri: URI_A, fallbackUri: null, trusted: false, setup: 'ready', setupError: null, setupAt: 't0' }];
	const entries = lfbw.engineToEntries(info([rowB, rowA, { pubkey: PK_P, host: '127.0.0.1', port: 9901 }, { pubkey: PK_C, uri: 'ws://nope' }]), prior, {
		siblingOf: (pubkey) => (pubkey === PK_P ? 'p1' : null)
	});
	assert.deepEqual(entries.map((e) => [e.pubkey, e.uri, e.walletId, e.trusted, e.setup]), [
		[PK_B, URI_B, null, true, 'pending'],
		[PK_A, URI_A, null, false, 'ready'],
		[PK_P, null, 'p1', true, 'pending'],
		[PK_C, 'ws://nope', null, true, 'failed']
	]);
	assert.match(entries[3].setupError, /Unsupported primary address/);
	assert.equal(entries[1].setupAt, 't0', 'the same node at the same address keeps its state');
	assert.deepEqual(lfbw.engineToEntries(info([{ ...rowA, port: 9999 }]), [{ ...prior[0], fallbackUri: `${PK_A}@${ONION}:9735` }])[0].fallbackUri, null, 'a moved address drops the fallback that named the old one');
});

// --- The manager against a recording daemon, as lfbw-setup.test.js runs it.

function harness({ wallet, primary, running = ['w1'], answers = {}, engine = { primaries: [], fillThresholdSat: null, receiveTarget: null } } = {}) {
	const records = {};
	for (const r of [wallet, primary].filter(Boolean)) records[r.id] = r;
	const m = Object.create(WalletManager.prototype);
	m.registry = { get: (id) => records[id], list: () => Object.values(records), upsert: (r) => { records[r.id] = r; } };
	m.runtime = new Map();
	for (const id of running) {
		m.runtimeState(id).proc = { pid: 1 };
		m.runtimeState(id).healthy = true;
	}
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.lfbwSupported = true;
	m.primariesSupported = true;
	m.lfbwSetupRunning = new Set();
	m.onion = null;
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	m.calls = [];
	m._waitDaemonHealthy = async () => {};
	m._restartWallet = async () => {};
	const list = () => ({
		fillThresholdSat: engine.fillThresholdSat,
		receiveTarget: engine.receiveTarget || (engine.primaries[0] ? engine.primaries[0].pubkey : null),
		primaries: engine.primaries.map((p, i) => ({ ...p, rank: i + 1, balanceSat: 0, channelCount: 0, isReceiveTarget: i === 0, selectionOrder: i + 1 }))
	});
	m._daemonCall = async (rec, method, path, body) => {
		m.calls.push({ wallet: rec.id, method, path, body });
		const key = `${rec.id} ${method} ${path}`;
		if (answers[key] instanceof Error) throw answers[key];
		if (typeof answers[key] === 'function') return answers[key](body);
		if (answers[key] !== undefined) return answers[key];
		if (path === '/info') return { nodeId: rec.id === 'w1' ? PK_W : PK_P, blockHeight: 100 };
		if (path === '/primaries') return list();
		if (path === '/primaries/add') {
			if (engine.primaries.some((p) => p.pubkey === body.pubkey)) throw Object.assign(new Error('already a primary'), { code: 'DUPLICATE' });
			engine.primaries.push({ pubkey: body.pubkey, host: body.host, port: body.port, uri: body.uri });
			return list();
		}
		if (path === '/primaries/remove') { engine.primaries = engine.primaries.filter((p) => p.pubkey !== body.pubkey); return list(); }
		if (path === '/primaries/reorder') { engine.primaries = body.order.map((k) => engine.primaries.find((p) => p.pubkey === k)); return list(); }
		if (path === '/primaries/threshold') { engine.fillThresholdSat = body.fillThresholdSat; return list(); }
		return {};
	};
	return { m, records, engine };
}

const external = (entries, extra = {}) => ({
	id: 'w1',
	name: 'Spending',
	network: 'regtest',
	port: 3902,
	onchainOnly: false,
	lfbw: {
		enabled: true,
		mode: 'external',
		primaryWalletId: null,
		primaryUri: entries[0].uri,
		primaryFallbackUri: null,
		primaryPubkey: entries[0].pubkey,
		trusted: true,
		initialChannelSats: 0,
		initialChannelOpened: false,
		setup: 'pending',
		setupError: null,
		setupAt: null,
		primaries: entries.map((e) => ({ walletId: null, fallbackUri: null, trusted: true, setup: 'pending', setupError: null, setupAt: null, ...e })),
		primariesThresholdSat: null,
		primariesReceiveTarget: null,
		primariesSyncedAt: null,
		...extra
	}
});
const seq = (m) => m.calls.map((c) => `${c.wallet} ${c.method} ${c.path}`);

test('a one-entry record seeds an empty engine after the same four calls as before, and is then marked synced', async () => {
	const { m, records, engine } = harness({ wallet: external([{ pubkey: PK_A, uri: URI_A }]) });
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	assert.deepEqual(seq(m), [
		'w1 GET /info',
		'w1 POST /trusted-peer/add',
		'w1 POST /direct-funding/configure',
		'w1 POST /peer/connect',
		'w1 GET /primaries',
		'w1 POST /primaries/add',
		'w1 GET /primaries'
	]);
	assert.deepEqual(m.calls.find((c) => c.path === '/primaries/add').body, { pubkey: PK_A, host: 'a.example', port: 9735 });
	assert.deepEqual(engine.primaries.map((p) => p.pubkey), [PK_A]);
	const lf = records.w1.lfbw;
	assert.ok(lf.primariesSyncedAt);
	assert.deepEqual(lf.primaries.map((e) => [e.pubkey, e.setup]), [[PK_A, 'ready']]);
	assert.equal(lf.primaryPubkey, PK_A);
	assert.equal(lf.primariesReceiveTarget, PK_A);
	// The next setup finds the engine agreeing and writes nothing.
	m.calls = [];
	await m.setupLfbw('w1');
	assert.deepEqual(seq(m).filter((s) => s.includes('/primaries')), ['w1 GET /primaries']);
	// An engine without the routes is never asked (the one-primary wallet as it was).
	const plain = harness({ wallet: external([{ pubkey: PK_A, uri: URI_A }]) });
	plain.m.primariesSupported = false;
	await plain.m.setupLfbw('w1');
	assert.deepEqual(seq(plain.m), ['w1 GET /info', 'w1 POST /trusted-peer/add', 'w1 POST /direct-funding/configure', 'w1 POST /peer/connect']);
});

test('two ranked externals are both trusted and dialed, direct funding names the first, and the engine lists them in rank order', async () => {
	const { m, records, engine } = harness({ wallet: external([{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_B, uri: URI_B, trusted: false }]) });
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	assert.equal(out.lfbw.setupError, null);
	assert.deepEqual(engine.primaries.map((p) => p.pubkey), [PK_A, PK_B]);
	const trusts = m.calls.filter((c) => c.path === '/trusted-peer/add').map((c) => c.body.pubkey);
	assert.deepEqual(trusts, [PK_A], 'the second node declined trust');
	const dials = m.calls.filter((c) => c.path === '/peer/connect').map((c) => c.body);
	assert.deepEqual(dials, [{ pubkey: PK_A, host: 'a.example', port: 9735 }, { pubkey: PK_B, host: 'b.example', port: 9736 }]);
	const dfs = m.calls.filter((c) => c.path === '/direct-funding/configure');
	assert.equal(dfs.length, 1);
	assert.equal(dfs[0].body.lspPubkey, PK_A);
	assert.deepEqual(records.w1.lfbw.primaries.map((e) => [e.pubkey, e.setup, e.trusted]), [[PK_A, 'ready', true], [PK_B, 'ready', false]]);
	assert.ok(records.w1.lfbw.primaries[1].setupAt);
});

test('the first-ranked node out of reach leaves the wallet ready on the second, names the failure, and retries it a bounded number of times', async () => {
	const dialFail = Object.assign(new Error('dial timed out'), { code: 'CONNECT_FAILED' });
	const { m, records } = harness({
		wallet: external([{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_B, uri: URI_B }]),
		answers: {
			'w1 POST /peer/connect': (body) => { if (body.pubkey === PK_A) throw dialFail; return {}; },
			'w1 GET /peers': []
		}
	});
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready');
	assert.equal(out.lfbw.setupError, 'dial timed out', 'the dashboard still names the node that needs attention');
	assert.deepEqual(records.w1.lfbw.primaries.map((e) => [e.pubkey, e.setup, e.setupError]), [[PK_A, 'failed', 'dial timed out'], [PK_B, 'ready', null]]);
	assert.equal(m.runtimeState('w1').setupRetries, 1, 'a retry is scheduled for the failed node');
	clearTimeout(m.runtimeState('w1').setupRetry);
	assert.ok(m.logs.some((l) => /first-ranked primary is out of reach/.test(l)));
	// Every node out of reach is the failure it always was.
	const none = harness({
		wallet: external([{ pubkey: PK_A, uri: URI_A }, { pubkey: PK_B, uri: URI_B }]),
		answers: { 'w1 POST /peer/connect': dialFail, 'w1 GET /peers': [] }
	});
	const failed = await none.m.setupLfbw('w1');
	assert.equal(failed.lfbw.setup, 'failed');
	assert.equal(failed.lfbw.setupError, 'dial timed out');
	assert.deepEqual(none.records.w1.lfbw.primaries.map((e) => e.setup), ['failed', 'failed']);
	clearTimeout(none.m.runtimeState('w1').setupRetry);
	// One primary: a failed dial fails the setup, as before.
	const one = harness({ wallet: external([{ pubkey: PK_A, uri: URI_A }]), answers: { 'w1 POST /peer/connect': dialFail, 'w1 GET /peers': [] } });
	assert.equal((await one.m.setupLfbw('w1')).lfbw.setup, 'failed');
	clearTimeout(one.m.runtimeState('w1').setupRetry);
});

test('once synced, the engine\'s list is taken as read: the record follows its order and direct funding its head', async () => {
	const engine = { primaries: [{ pubkey: PK_B, host: 'b.example', port: 9736 }, { pubkey: PK_A, host: 'a.example', port: 9735 }], fillThresholdSat: 20000, receiveTarget: PK_B };
	const { m, records } = harness({
		wallet: external([{ pubkey: PK_A, uri: URI_A, setup: 'ready' }, { pubkey: PK_B, uri: URI_B, setup: 'ready' }], { primariesSyncedAt: '2026-11-01T00:00:00.000Z' }),
		engine
	});
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	assert.equal(seq(m).filter((s) => /\/primaries\/(add|remove|reorder|threshold)/.test(s)).length, 0, 'nothing is written to an engine that is the authority');
	const lf = records.w1.lfbw;
	assert.deepEqual(lf.primaries.map((e) => e.pubkey), [PK_B, PK_A]);
	assert.equal(lf.primaryPubkey, PK_B);
	assert.equal(lf.primaryUri, URI_B);
	assert.equal(lf.primariesThresholdSat, 20000);
	assert.equal(lf.primariesReceiveTarget, PK_B);
	const dfs = m.calls.filter((c) => c.path === '/direct-funding/configure').map((c) => c.body.lspPubkey);
	assert.deepEqual(dfs, [PK_A, PK_B], 'armed for the record\'s head first, then re-armed for the engine\'s');
	assert.deepEqual(m.calls.filter((c) => c.path === '/peer/connect').map((c) => c.body.pubkey).sort(), [PK_A, PK_B].sort(), 'every node is dialed after a start');
});

test('the record follows a write the dashboard made at the engine: the new node is trusted and dialed, the threshold and target mirrored', async () => {
	const engine = { primaries: [{ pubkey: PK_A, host: 'a.example', port: 9735 }], fillThresholdSat: null, receiveTarget: PK_A };
	const { m, records } = harness({
		wallet: external([{ pubkey: PK_A, uri: URI_A, setup: 'ready', setupAt: 't0' }], { setup: 'ready', setupAt: 't0', primariesSyncedAt: 't0' }),
		engine
	});
	// The dashboard added a node and set the fill target through the proxy.
	engine.primaries.push({ pubkey: PK_C, host: 'c.example', port: 9737 });
	engine.fillThresholdSat = 50000;
	engine.receiveTarget = PK_C;
	const out = await m.syncPrimaries('w1');
	assert.deepEqual(seq(m), ['w1 GET /primaries', 'w1 POST /trusted-peer/add', 'w1 POST /peer/connect']);
	assert.deepEqual(m.calls[1].body, { pubkey: PK_C });
	assert.deepEqual(m.calls[2].body, { pubkey: PK_C, host: 'c.example', port: 9737 });
	const lf = records.w1.lfbw;
	assert.deepEqual(lf.primaries.map((e) => [e.pubkey, e.uri, e.setup]), [[PK_A, URI_A, 'ready'], [PK_C, URI_C, 'ready']]);
	assert.equal(lf.primariesThresholdSat, 50000);
	assert.equal(lf.primariesReceiveTarget, PK_C);
	assert.equal(lf.primaryPubkey, PK_A, 'the head did not move');
	assert.equal(out.lfbw.setup, 'ready');
	assert.equal(out.lfbw.primaries.length, 2, 'the public record carries the list');
	// Removing the head through the proxy re-arms direct funding for the new one.
	m.calls = [];
	engine.primaries = engine.primaries.filter((p) => p.pubkey !== PK_A);
	engine.receiveTarget = PK_C;
	await m.syncPrimaries('w1');
	assert.deepEqual(seq(m), ['w1 GET /primaries', 'w1 POST /direct-funding/configure']);
	assert.equal(m.calls[1].body.lspPubkey, PK_C);
	assert.equal(m.calls[1].body.lspHost, 'c.example');
	assert.deepEqual(records.w1.lfbw.primaries.map((e) => e.pubkey), [PK_C]);
	assert.equal(records.w1.lfbw.primaryUri, URI_C);
	// Without the routes, or while the wallet is down, the record is not touched.
	m.primariesSupported = false;
	await assert.rejects(m.syncPrimaries('w1'), (err) => err.code === 'PRIMARIES_UNSUPPORTED');
	m.primariesSupported = true;
	m.runtimeState('w1').healthy = false;
	await assert.rejects(m.syncPrimaries('w1'), (err) => err.code === 'NOT_RUNNING');
});

test('a deposit moves toward the receive target when the wallet keeps several primaries', async () => {
	const PK_X = PK_B;
	const rec = {
		id: 'w1',
		name: 'Spending',
		network: 'regtest',
		port: 3902,
		nodeId: PK_W,
		lfbw: {
			enabled: true,
			mode: 'internal',
			primaryWalletId: 'p1',
			primaryPubkey: PK_P,
			trusted: true,
			setup: 'ready',
			primaries: [
				{ pubkey: PK_P, walletId: 'p1', uri: null, trusted: true, setup: 'ready' },
				{ pubkey: PK_X, walletId: null, uri: URI_B, trusted: true, setup: 'ready' }
			],
			primariesReceiveTarget: PK_X
		}
	};
	const primary = { id: 'p1', name: 'Primary', network: 'regtest', port: 3901, nodeId: PK_P, onchainOnly: false };
	const m = Object.create(WalletManager.prototype);
	const store = { w1: rec, p1: primary };
	m.registry = { get: (id) => store[id], list: () => Object.values(store), upsert: () => {} };
	m.runtime = new Map();
	m.runtimeState('w1').proc = { pid: 1 };
	m.runtimeState('w1').healthy = true;
	m.runtimeState('p1').proc = { pid: 2 };
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.onionAddress = () => null;
	m._waitDaemonHealthy = async () => {};
	m.offlineReceiveSupported = false;
	m.calls = [];
	const answers = {
		'w1 GET /balance': { onchain: 50000 },
		'w1 GET /utxos': [{ height: 90 }],
		'w1 GET /channels': [
			{ channelId: 'home-p', peerPubkey: PK_P, state: 'NORMAL', htlcUsable: true },
			{ channelId: 'home-x', peerPubkey: PK_X, state: 'NORMAL', htlcUsable: true }
		],
		'w1 GET /fees/estimates': { normal: 7 },
		'w1 POST /channel/splice-quote': { maxAmountSats: 48000 }
	};
	m._daemonCall = async (r, method, path, body) => {
		m.calls.push({ wallet: r.id, method, path, body });
		const key = `${r.id} ${method} ${path}`;
		if (answers[key] !== undefined) return answers[key];
		if (path === '/info') return { nodeId: r.nodeId, blockHeight: 100 };
		return {};
	};
	await m._lfbwChannelize('w1');
	assert.equal(m.calls.find((c) => c.path === '/channel/splice-in').body.channelId, 'home-x', 'the deposit joins the channel with the receive target');
	// With no channel at the target yet, the open goes to it: an external node is asked to sell inbound first.
	m.calls = [];
	answers['w1 GET /channels'] = [{ channelId: 'home-p', peerPubkey: PK_P, state: 'NORMAL', htlcUsable: true }];
	answers['w1 POST /tx/quote'] = { maxSendSats: 200000, feeSats: 300 };
	m.runtimeState('w1').lfbwRetryAt = 0;
	await m._lfbwChannelize('w1');
	const open = m.calls.find((c) => c.path === '/channel/open-v2');
	assert.equal(open.body.pubkey, PK_X);
	// Back on one primary the pass is what it was: the home channel with the sibling.
	m.calls = [];
	rec.lfbw.primaries = [rec.lfbw.primaries[0]];
	rec.lfbw.primariesReceiveTarget = null;
	await m._lfbwChannelize('w1');
	assert.equal(m.calls.find((c) => c.path === '/channel/splice-in').body.channelId, 'home-p');
});

test('the offline receive figure is the receive target\'s channel', async () => {
	const channel = (peer, remote) => ({ channelId: peer.slice(0, 8), peerPubkey: peer, state: 'NORMAL', htlcUsable: true, localBalanceSats: 0, remoteBalanceSats: remote });
	const asked = [];
	const manager = {
		registry: { get: () => ({ id: 'w1', lfbw: { enabled: true, primaryPubkey: PK_A, primariesReceiveTarget: PK_B } }) },
		offlineReceiveAvailable: () => true,
		_daemonCall: async (_record, _method, route) => {
			asked.push(route);
			if (route.startsWith('/receive/quote')) return { mode: 'bolt11' };
			if (route === '/channels') return [channel(PK_A, 400000), channel(PK_B, 120000)];
			if (route === '/receive/status') return { reservedChannelIds: [] };
			return [];
		}
	};
	const offline = createOfflineCapacity(manager, { wait: 50 });
	assert.deepEqual(await offline('w1'), { maxSats: 70000 });
	assert.ok(asked.some((route) => route.startsWith(`/receive/quote?peer=${encodeURIComponent(PK_B)}`)), 'the target is the node asked');
});
