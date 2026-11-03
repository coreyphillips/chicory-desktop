'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A daemon booted in a guardian mode against a fresh database whose
 * namespace the guardians already hold does not run a node: it answers every
 * route but its recovery surface with 503 NODE_RESTORE_PENDING until the
 * restore is run. To the manager that is a daemon that is up and waiting,
 * and the wallet reads 'restore-required' instead of 'starting' forever.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const realFetch = globalThis.fetch;

function managerWith(rt, rec = {}) {
	const m = Object.create(WalletManager.prototype);
	m.registry = { get: () => ({ id: 'w1', port: 3001, electrum: {}, ...rec }) };
	m.runtime = new Map([['w1', rt]]);
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	return m;
}

const state = (extra = {}) => ({
	proc: { pid: 1 },
	status: 'starting',
	healthy: false,
	stopping: false,
	chainStallPolls: 0,
	healthFailPolls: 0,
	lastStallRestartAt: 0,
	lastStartError: null,
	...extra
});

const holding = () => {
	globalThis.fetch = async () => ({
		ok: false,
		status: 503,
		json: async () => ({ ok: false, error: { code: 'NODE_RESTORE_PENDING', message: 'holding' } })
	});
};
const bare503 = () => {
	globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) });
};
const silence = () => {
	globalThis.fetch = async () => {
		throw new Error('timeout');
	};
};
const answers = () => {
	globalThis.fetch = async () => ({
		ok: true,
		json: async () => ({ result: { electrumConnected: true, blockHeight: 100 } })
	});
};

test.afterEach(() => {
	globalThis.fetch = realFetch;
});

test('the ongoing check recognises the hold and does not call it unhealthy or stalled', async () => {
	const rt = state();
	const m = managerWith(rt);
	holding();
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'restore-required');
	assert.equal(rt.healthy, false, 'the daemon itself says not-ready');
	assert.equal(rt.chainStallPolls, 0);
	assert.ok(m.logs.some((l) => l.includes('holding for a guardian restore')));
	await m._checkChainStall('w1');
	assert.equal(m.logs.filter((l) => l.includes('holding')).length, 1, 'said once');
});

test('the first ok answer after a hold is the node booted: running and healthy', async () => {
	const rt = state({ status: 'restore-required', lastStartError: { message: 'old', at: 'x' } });
	const m = managerWith(rt);
	answers();
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'running');
	assert.equal(rt.healthy, true);
	assert.equal(rt.lastStartError, null, 'a start that succeeded has no failure to show');
});

test('silence while holding neither demotes nor restarts', async () => {
	const rt = state({ status: 'restore-required' });
	const m = managerWith(rt);
	silence();
	await m._checkChainStall('w1');
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'restore-required');
	assert.equal(rt.healthFailPolls, 0, 'demotion only counts a daemon that was running');
});

test('a 503 without the code is just a daemon not answering', async () => {
	const rt = state();
	const m = managerWith(rt);
	bare503();
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'starting');
});

test('the startup poll flips to the hold and keeps watching until the node boots', async () => {
	const rt = state();
	const m = managerWith(rt);
	m.restoreHoldPollMs = 5;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls < 3) {
			return {
				ok: false,
				status: 503,
				json: async () => ({ ok: false, error: { code: 'NODE_RESTORE_PENDING' } })
			};
		}
		return { ok: true, json: async () => ({ result: {} }) };
	};
	await m._pollHealth('w1');
	assert.equal(calls, 3, 'two holding answers, then the node booted');
	assert.equal(rt.status, 'running');
	assert.equal(rt.healthy, true);
	assert.ok(m.logs.some((l) => l.includes('holding for a guardian restore')));
	assert.ok(m.logs.some((l) => l.includes('restore finished')));
});

test('a poll whose process was replaced stops reporting', async () => {
	const rt = state();
	const m = managerWith(rt);
	m.restoreHoldPollMs = 5;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls === 2) rt.proc = { pid: 2 };
		return {
			ok: false,
			status: 503,
			json: async () => ({ ok: false, error: { code: 'NODE_RESTORE_PENDING' } })
		};
	};
	await m._pollHealth('w1');
	assert.equal(calls, 2, 'the loop ended when its process went away');
	assert.equal(rt.status, 'restore-required', 'and left the new process to its own poll');
});

test('a daemon holding on a restored database is restarted for it, once', async () => {
	const rt = state({ status: 'running', healthy: true });
	const m = managerWith(rt);
	const killed = [];
	m._killProc = async (proc) => killed.push(proc.pid);
	let started = 0;
	m.startWallet = async () => {
		started += 1;
		rt.proc = { pid: 2 };
	};
	globalThis.fetch = async () => ({
		ok: false,
		status: 503,
		json: async () => ({ ok: false, error: { code: 'NODE_RESTART_REQUIRED' } })
	});
	await m._checkChainStall('w1');
	assert.deepEqual(killed, [1], 'the old process was stopped');
	assert.equal(started, 1, 'and the wallet started again');
	assert.ok(m.logs.some((l) => l.includes('restarting on the restored state')));
	// The startup poll does the same, then leaves the new process to its own poll.
	const rt2 = state();
	const m2 = managerWith(rt2);
	m2._killProc = async () => {};
	let started2 = 0;
	m2.startWallet = async () => {
		started2 += 1;
		rt2.proc = { pid: 3 };
	};
	await m2._pollHealth('w1');
	assert.equal(started2, 1);
});

test('a START_FAILED line from the daemon is kept as the wallet\'s last start error', () => {
	const rt = state();
	const m = managerWith(rt);
	m._noteStartFailure(rt, 'plain log line');
	assert.equal(rt.lastStartError, null);
	m._noteStartFailure(
		rt,
		JSON.stringify({ ok: false, error: { code: 'START_FAILED', message: 'Recovery mode quorum needs exactly 3 guardians (crash-v1 is 2-of-3); got 2' } })
	);
	assert.match(rt.lastStartError.message, /exactly 3 guardians/);
	m._noteStartFailure(rt, JSON.stringify({ ok: true, result: {} }));
	assert.match(rt.lastStartError.message, /exactly 3 guardians/, 'an unrelated line does not clear it');
});

// A peer-storage daemon that applied a checkpoint by itself (beignet #690)
// rebuilds its node in-process, and for that moment answers every route
// with NODE_RESTORE_PENDING. Peer storage has no guardian hold to be in, so
// the manager reads that as a boot in progress, not a hold.
test('a peer-storage daemon rebuilding on a checkpoint is not parked in the hold, and comes back running', async () => {
	const rt = state({ status: 'running', healthy: true });
	const m = managerWith(rt, { recovery: { mode: 'peer-storage', guardians: [], autoApply: true } });
	holding();
	await m._checkChainStall('w1');
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'running', 'not parked');
	assert.equal(m.logs.filter((l) => l.includes('holding for a guardian restore')).length, 0, 'no guardian talk');
	assert.equal(m.logs.filter((l) => l.includes('being rebuilt')).length, 1, 'said once');
	answers();
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'running');
	assert.equal(rt.healthy, true);
	assert.equal(rt.checkpointRebuildPolls, 0, 'the run is reset by an answer');
	// A guardian-mode wallet still gets the hold on the same answer.
	const g = state({ status: 'running', healthy: true });
	const gm = managerWith(g, { recovery: { mode: 'quorum', guardians: ['a', 'b', 'c'] } });
	holding();
	await gm._checkChainStall('w1');
	assert.equal(g.status, 'restore-required');
});

test('a rebuild that never ends falls through to the hold', async () => {
	const rt = state({ status: 'running', healthy: true });
	const m = managerWith(rt, { recovery: { mode: 'peer-storage', guardians: [] } });
	holding();
	for (let i = 0; i < 13; i++) await m._checkChainStall('w1');
	assert.equal(rt.status, 'restore-required');
	assert.ok(m.logs.some((l) => l.includes('has not finished')));
});

test('the startup poll keeps polling through the rebuild rather than entering the hold', async () => {
	const rt = state();
	const m = managerWith(rt, { recovery: { mode: 'peer-storage', guardians: [], autoApply: true } });
	m._onHealthy = async () => {};
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls < 3) return { ok: false, status: 503, json: async () => ({ ok: false, error: { code: 'NODE_RESTORE_PENDING', message: 'rebuilding' } }) };
		return { ok: true, json: async () => ({ result: { electrumConnected: true, blockHeight: 100 } }) };
	};
	await m._pollHealth('w1');
	assert.equal(rt.status, 'running');
	assert.equal(rt.healthy, true);
	assert.equal(m.logs.filter((l) => l.includes('holding for a guardian restore')).length, 0);
});
