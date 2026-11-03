'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The return half of an offline receive (FFOR, beignet #729), held against
 * a stubbed daemon: a fresh start reconciles every ACTIVE epoch the wallet
 * receives on, once the channel to the settlement peer is back; an
 * unreachable peer is reported, not retried forever; and the record model
 * refuses the settlement role where the daemon would.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');
const ffor = require('./ffor');

function managerWith(records, { fforSupported = true } = {}) {
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
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.fforSupported = fforSupported;
	m.lfbwSupported = true;
	m.guardianHostingSupported = true;
	m.engineVersion = '0.21.4';
	m.settings = { get: () => ({ defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: [] }) };
	m._restartWallet = async () => {};
	m._restoreInFlight = async () => false;
	m._normalizeElectrum = (e) => e;
	m.calls = [];
	return { m, store };
}

const receiver = () => ({
	id: 'r1',
	name: 'Receiver',
	network: 'regtest',
	port: 3901,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	recovery: { mode: 'off', guardians: [] }
});

const CH = 'ab'.repeat(32);
const activeEpoch = (state = 'ACTIVE') => ({
	channelId: CH,
	role: 'R',
	state,
	epochId: 'e1',
	slots: [
		{ k: 1, amountMsat: '50000000', state: 'exposed' },
		{ k: 2, amountMsat: '50000000', state: 'unissued' }
	]
});

function stubDaemon(m, { epochs, channelState = 'NORMAL', recover }) {
	m._daemonCall = async (_rec, method, path, body) => {
		m.calls.push([method, path, body]);
		if (path === '/ffor/epochs') {
			if (epochs instanceof Error) throw epochs;
			return epochs;
		}
		if (path === '/channels') return [{ channelId: CH, state: channelState }];
		if (path.startsWith('/ffor/epoch?')) return recover && recover.epoch ? recover.epoch : activeEpoch();
		if (path === '/ffor/enforce') {
			if (m.enforceAnswer instanceof Error) throw m.enforceAnswer;
			return m.enforceAnswer || { ok: true, commitmentTxid: 'cc'.repeat(32), preimagesKnown: 1 };
		}
		if (path === '/ffor/recover') {
			if (recover instanceof Error) throw recover;
			return recover;
		}
		throw new Error(`unexpected ${method} ${path}`);
	};
}

test('a start reconciles every receiver epoch once its channel is back, and keeps the outcome', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const closed = {
		action: 'closed',
		preimagesKnown: [1],
		witnesses: [],
		epoch: { ...activeEpoch('CLOSED'), slots: [{ k: 1, state: 'settled' }, { k: 2, state: 'unsettled' }] }
	};
	stubDaemon(m, { epochs: [activeEpoch(), { channelId: 'cc', role: 'S', state: 'ACTIVE' }], recover: closed });
	await m._fforReturn('r1');
	const recovers = m.calls.filter(([, p]) => p === '/ffor/recover');
	assert.equal(recovers.length, 1, "the S-side record is the sibling's business, not a return");
	assert.deepEqual(recovers[0][2], { channelId: CH, forceCloseIfUnreachable: false });
	const rec = m.publicRecord('r1');
	assert.equal(rec.fforReturn.action, 'closed');
	assert.deepEqual(rec.fforReturn.preimagesKnown, [1]);
	assert.equal(rec.fforReturn.epoch.state, 'CLOSED');
	assert.equal(ffor.describeReturn(rec.fforReturn).complete, false, 'slot 2 still reads unsettled');
	assert.match(m.logs.join('\n'), /ffor return abababababababab: closed, 1 of 2 slots settled, 1 preimage known/);
});

test('no epochs, or an engine that predates the routes, means no return', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	stubDaemon(m, { epochs: [] });
	await m._fforReturn('r1');
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 0);

	const notFound = new Error('Not found');
	notFound.code = 'NOT_FOUND';
	stubDaemon(m, { epochs: notFound });
	await m._fforReturn('r1');
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 0);

	const { m: old } = managerWith({ r1: receiver() }, { fforSupported: false });
	old.runtimeState('r1').proc = {};
	stubDaemon(old, { epochs: [activeEpoch()] });
	await old._fforReturn('r1');
	assert.equal(old.calls.length, 0, 'an engine without the surface is never asked');
});

test('a peer that never reestablishes is reported as unreachable, after one recover call', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const nothing = { action: 'nothing', preimagesKnown: [], witnesses: [], epoch: activeEpoch() };
	stubDaemon(m, { epochs: [activeEpoch()], channelState: 'AWAITING_REESTABLISH', recover: nothing });
	const realTimeout = ffor.RETURN_REESTABLISH_TIMEOUT_MS;
	// The wait is a module constant; shorten it through the method's argument.
	const orig = m._waitChannelNormal;
	m._waitChannelNormal = (rec, ch) => orig.call(m, rec, ch, 10);
	await m._fforReturn('r1');
	assert.equal(realTimeout, 90000);
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 1);
	const rec = m.publicRecord('r1');
	assert.equal(rec.fforReturn.action, 'nothing');
	assert.equal(rec.fforReturn.outcome, 'unreachable');
	assert.equal(ffor.describeReturn(rec.fforReturn).complete, false);
	assert.match(m.logs.join('\n'), /settlement peer not reachable, 0 of 2 slots settled so far/);
});

test('a drain in progress answers nothing too, and is a return in progress rather than an unreachable peer', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const draining = { ...activeEpoch('DRAINING'), slots: [{ k: 1, state: 'settled' }, { k: 2, state: 'unsettled' }] };
	stubDaemon(m, { epochs: [draining], recover: { action: 'nothing', preimagesKnown: [], witnesses: [], epoch: draining } });
	const orig = m._waitEpochSettled;
	m._waitEpochSettled = (rec, ch) => orig.call(m, rec, ch, 10);
	await m._fforReturn('r1');
	const rec = m.publicRecord('r1');
	assert.equal(rec.fforReturn.outcome, 'draining');
	assert.equal(ffor.describeReturn(rec.fforReturn).complete, false);
	assert.match(m.logs.join('\n'), /closing with the peer, 1 of 2 slots settled so far/);
	assert.ok(m.runtimeState('r1').fforDrainTimer, 'the manager keeps watching the drain');
	clearTimeout(m.runtimeState('r1').fforDrainTimer);
	// And an epoch that already closed reads closed, whatever the action said.
	const closed = { ...activeEpoch('CLOSED'), slots: [{ k: 1, state: 'settled' }, { k: 2, state: 'unsettled' }] };
	stubDaemon(m, { epochs: [closed], recover: { action: 'nothing', preimagesKnown: [], witnesses: [], epoch: closed } });
	await m.fforReturn('r1', { channelId: CH });
	assert.equal(m.publicRecord('r1').fforReturn.outcome, 'closed');
});

test('an epoch on a force-closed channel is not reconciled on start: it is enforced on-chain', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	stubDaemon(m, { epochs: [activeEpoch()], channelState: 'FORCE_CLOSED', recover: { action: 'nothing', preimagesKnown: [], witnesses: [], epoch: activeEpoch() } });
	await m._fforReturn('r1');
	assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 0);
	// Asked by hand, the record says so rather than blaming the peer.
	const orig = m._waitEpochSettled;
	m._waitEpochSettled = (rec, ch) => orig.call(m, rec, ch, 10);
	await m.fforReturn('r1', { channelId: CH });
	assert.equal(m.publicRecord('r1').fforReturn.outcome, 'enforced');
});

test('enforce reads the refusal the daemon answers inside a 200, and a broadcast clears the warning', async () => {
	const { m } = managerWith({ r1: receiver() });
	const rt = m.runtimeState('r1');
	rt.proc = {};
	rt.fforEnforce = { at: 1, channelId: CH };
	stubDaemon(m, { epochs: [activeEpoch()] });
	m.enforceAnswer = { ok: false, error: 'channel restored from a capsule: pass acceptStaleStateRisk' };
	await assert.rejects(m.fforEnforce('r1', { channelId: CH }), (err) => err.code === 'FFOR_ENFORCE_REFUSED' && /capsule/.test(err.message));
	assert.deepEqual(rt.fforEnforce, { at: 1, channelId: CH }, 'a refusal leaves the warning up');
	assert.equal(m.publicRecord('r1').fforEnforced, null);
	m.enforceAnswer = null;
	const done = await m.fforEnforce('r1', { channelId: CH });
	assert.equal(done.commitmentTxid, 'cc'.repeat(32));
	assert.equal(rt.fforEnforce, null, 'the warning is answered by the broadcast');
	rt.fforReturn = { at: 1, channelId: CH, action: 'nothing', outcome: 'unreachable', epoch: activeEpoch() };
	await m.fforEnforce('r1', { channelId: CH });
	assert.equal(m.publicRecord('r1').fforReturn.outcome, 'enforced', 'the unreachable return is superseded by the broadcast');
	assert.equal(m.publicRecord('r1').fforEnforced.channelId, CH);
	assert.match(m.logs.join('\n'), /force close broadcast/);
	await assert.rejects(m.fforEnforce('r1', {}), (err) => err.code === 'INVALID_PARAMS');
});

test('enforce reads the refusal 0.31.0 answers as FORCE_CLOSE_FAILED the same way', async () => {
	const { m } = managerWith({ r1: receiver() });
	const rt = m.runtimeState('r1');
	rt.proc = {};
	rt.fforEnforce = { at: 1, channelId: CH };
	stubDaemon(m, { epochs: [activeEpoch()] });
	m.enforceAnswer = Object.assign(new Error('channel restored from a capsule: pass acceptStaleStateRisk'), { code: 'FORCE_CLOSE_FAILED' });
	await assert.rejects(m.fforEnforce('r1', { channelId: CH }), (err) => err.statusCode === 502 && err.code === 'FFOR_ENFORCE_REFUSED' && /capsule/.test(err.message));
	assert.deepEqual(rt.fforEnforce, { at: 1, channelId: CH }, 'a refusal leaves the warning up');
	assert.equal(m.publicRecord('r1').fforEnforced, null);
	assert.match(m.logs.join('\n'), /refused, channel restored from a capsule/);
	m.enforceAnswer = Object.assign(new Error('fetch failed'), { code: 'DAEMON_ERROR' });
	await assert.rejects(m.fforEnforce('r1', { channelId: CH }), (err) => err.code === 'DAEMON_ERROR');
	// A success without the in-band ok flag, as 0.31.0 answers it.
	m.enforceAnswer = { commitmentTxid: 'cc'.repeat(32), preimagesKnown: 1 };
	const done = await m.fforEnforce('r1', { channelId: CH });
	assert.equal(done.commitmentTxid, 'cc'.repeat(32));
	assert.equal(rt.fforEnforce, null);
});

test('a refused recover is kept on the record with its reason, and surfaces as a 502 to the caller', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.runtimeState('r1').proc = {};
	const refused = new Error('no FFOR epoch on this channel');
	refused.code = 'NOT_FOUND';
	stubDaemon(m, { epochs: [activeEpoch()], recover: refused });
	await assert.rejects(m.fforReturn('r1', { channelId: CH }), (err) => err.statusCode === 502 && err.code === 'NOT_FOUND');
	assert.equal(m.publicRecord('r1').fforReturn.error, 'no FFOR epoch on this channel');
	await assert.rejects(m.fforReturn('r1', {}), (err) => err.code === 'INVALID_PARAMS');
	m.runtimeState('r1').proc = null;
	await assert.rejects(m.fforReturn('r1', { channelId: CH }), (err) => err.code === 'NOT_RUNNING');
});

test('the settlement role is validated like the daemon would, on create and on edit', async () => {
	const { m, store } = managerWith({ r1: receiver() });
	assert.deepEqual(m._normalizeFfor(undefined, null, false).settle, { ...ffor.SETTLE_DEFAULTS });
	assert.throws(() => m._normalizeFfor({ settle: { enabled: true } }, null, true), (err) => err.code === 'FFOR_NEEDS_LIGHTNING');
	const { m: old } = managerWith({});
	old.fforSupported = false;
	assert.throws(() => old._normalizeFfor({ settle: { enabled: true } }, null, false), (err) => err.code === 'FFOR_UNSUPPORTED');
	assert.equal(old._normalizeFfor({ settle: { enabled: false } }, null, false).settle.enabled, false, 'off is always fine');

	const edited = await m.updateWallet('r1', { ffor: { settle: { enabled: true, feePpm: 50 } } });
	assert.equal(edited.ffor.settle.enabled, true);
	assert.equal(edited.ffor.settle.feePpm, 50);
	assert.equal(store.r1.ffor.settle.enabled, true);
	const parked = await m.updateWallet('r1', { onchainOnly: true });
	assert.equal(parked.ffor.settle.enabled, false, 'parking Lightning drops the settlement role');
	assert.equal(parked.ffor.settle.feePpm, 50, 'but keeps the terms for when it comes back');
});

test('settlement candidates are the opted-in siblings, marked by health', () => {
	const { m } = managerWith({
		r1: receiver(),
		s1: { ...receiver(), id: 's1', name: 'Settler', nodeId: '02' + 'cd'.repeat(32), ffor: { settle: { enabled: true } } },
		s2: { ...receiver(), id: 's2', name: 'Quiet', nodeId: '02' + 'ef'.repeat(32) }
	});
	m.runtimeState('s1').healthy = true;
	assert.deepEqual(m.fforCandidates('r1'), [{ id: 's1', name: 'Settler', nodeId: '02' + 'cd'.repeat(32), running: true, settles: true, witnesses: false, issues: false }]);
	assert.throws(() => m.fforCandidates('nope'), (err) => err.code === 'NOT_FOUND');
});

test('startup leaves automatic requests to the daemon coordinator and fails closed on unreadable status', async () => {
	const { m } = managerWith({ r1: receiver() });
	m.offlineReceiveSupported = true;
	m.runtimeState('r1').proc = {};
	const calls = [];
	m._daemonCall = async (_r, method, path) => {
		calls.push(path);
		if (path === '/ffor/epochs') return [activeEpoch()];
		if (path === '/receive/status') return { requests: [{ channelId: CH }] };
		if (path === '/channels') return [{ channelId: CH, state: 'NORMAL' }];
		throw Error('Must not close an automatic request');
	};
	await m._fforReturn('r1');
	assert.equal(calls.includes('/ffor/recover'), false);
	m._daemonCall = async (_r, _m, path) => {
		if (path === '/ffor/epochs') return [activeEpoch()];
		throw Error('journal unavailable');
	};
	await assert.rejects(m._fforReturn('r1'), /journal unavailable/);
});


test('concurrent startup refreshes receipts without closing the book or treating proof as credit', async () => {
  const { m } = managerWith({ r1: receiver() });
  m.runtimeState('r1').proc = {};
  const epoch = { ...activeEpoch(), concurrent: true, concurrentVersion: 2, snapshotSeq: 3, slots: [{ k: 1, state: 'redeemed' }, { k: 2, state: 'settled' }] };
  m._daemonCall = async (_rec, method, path, body) => {
    m.calls.push([method, path, body]);
    if (path === '/ffor/epochs') return [epoch];
    if (path === '/channels') return [{ channelId: CH, state: 'NORMAL' }];
    if (path.startsWith('/ffor/epoch?')) return epoch;
    if (path === '/ffor/recover') return { action: 'synced', epoch };
    throw Error(`Unexpected ${path}`);
  };
  await m._fforReturn('r1');
  assert.equal(m.calls.filter(([, p]) => p === '/ffor/recover').length, 1);
  assert.ok(!m.calls.some(([, p]) => ['/ffor/epoch/close', '/ffor/enforce'].includes(p)));
  const result = m.runtimeState('r1').fforReturn;
  assert.equal(result.epoch.snapshotSeq, 3);
  assert.equal(ffor.describeReturn(result).credited, 1);
  assert.equal(ffor.describeReturn(result).complete, false);
});

test('reconnect skips legacy books and scopes concurrent recovery to the reconnected peer', async () => {
  const { m } = managerWith({ r1: receiver() });
  m.runtimeState('r1').proc = {};
  const epoch = { ...activeEpoch(), concurrent: true, concurrentVersion: 2 };
  m._daemonCall = async (_rec, _method, path) => {
    if (path === '/ffor/epochs') return [epoch, { ...activeEpoch(), channelId: 'legacy' }];
    if (path === '/channels') return [{ channelId: CH, state: 'NORMAL', peerPubkey: 'settler' }, { channelId: 'legacy', state: 'NORMAL', peerPubkey: 'settler' }];
    throw Error(`Unexpected ${path}`);
  };
  const calls = [];
  m.fforReturn = async (_id, job) => calls.push(job.channelId);
  await m._fforReturn('r1', { concurrentOnly: true, peer: 'witness' });
  assert.deepEqual(calls, []);
  await m._fforReturn('r1', { concurrentOnly: true, peer: 'settler' });
  assert.deepEqual(calls, [CH]);
});
