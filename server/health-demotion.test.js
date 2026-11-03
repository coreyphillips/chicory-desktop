'use strict';

/**
 * Run with: npm test (from server/).
 *
 * healthy used to be written once by the startup poll and never revisited, so
 * a daemon that deadlocked mid-life (process alive, API silent; see beignet
 * issue #437) kept reading healthy forever and nothing upstream could tell.
 * The chain-stall poll now doubles as the ongoing health check: two straight
 * silent polls of a daemon that had finished starting demote it, any answer
 * restores it, and a daemon still starting is left to the startup poll.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const realFetch = globalThis.fetch;

function managerWith(rt) {
	const m = Object.create(WalletManager.prototype);
	m.registry = { get: () => ({ id: 'w1', port: 3001, electrum: {} }) };
	m.runtime = new Map([['w1', rt]]);
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	return m;
}

const runningState = () => ({
	proc: { pid: 1 },
	status: 'running',
	healthy: true,
	stopping: false,
	chainStallPolls: 0,
	healthFailPolls: 0,
	lastStallRestartAt: 0
});

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

test('a running daemon that goes silent is demoted on the second poll', async () => {
	const rt = runningState();
	const m = managerWith(rt);
	silence();
	await m._checkChainStall('w1');
	assert.equal(rt.healthy, true, 'one silent poll is a grace, not a verdict');
	await m._checkChainStall('w1');
	assert.equal(rt.healthy, false);
	assert.ok(m.logs.some((l) => l.includes('stopped answering')));
});

test('any answer restores healthy and resets the count', async () => {
	const rt = runningState();
	rt.healthy = false;
	rt.healthFailPolls = 5;
	const m = managerWith(rt);
	answers();
	await m._checkChainStall('w1');
	assert.equal(rt.healthy, true);
	assert.equal(rt.healthFailPolls, 0);
	assert.ok(m.logs.some((l) => l.includes('answering /health again')));
});

test('a slow boot that answers after the startup window is promoted to running', async () => {
	// Seen in the field: a 67s first boot (lock clear plus gossip chew) outlasted
	// the 45s startup poll, and the record read 'starting' forever with the
	// demotion path unarmed.
	const rt = runningState();
	rt.status = 'starting';
	rt.healthy = false;
	const m = managerWith(rt);
	answers();
	await m._checkChainStall('w1');
	assert.equal(rt.status, 'running');
	assert.equal(rt.healthy, true);
	assert.ok(m.logs.some((l) => l.includes('after the startup poll window')));
});

test('a slow boot still gets its post-start setup, once per process', async () => {
	// The setup used to hang off the startup poll alone: a wallet promoted
	// here read healthy with its node id uncaptured and its lightning-first
	// links never re-applied.
	const rt = runningState();
	rt.status = 'starting';
	rt.healthy = false;
	rt.postStartFor = null;
	const m = managerWith(rt);
	const ran = [];
	m._onHealthy = async (id) => {
		ran.push(id);
	};
	answers();
	await m._checkChainStall('w1');
	assert.deepEqual(ran, ['w1']);
	// Later polls of the same child do not run it again.
	await m._checkChainStall('w1');
	assert.deepEqual(ran, ['w1']);
	// A new child does.
	rt.proc = { pid: 2 };
	rt.status = 'starting';
	await m._checkChainStall('w1');
	assert.deepEqual(ran, ['w1', 'w1']);
});

test('the startup poll and the stall poll never double up on the setup', async () => {
	const rt = runningState();
	rt.status = 'starting';
	rt.healthy = false;
	rt.postStartFor = null;
	const m = managerWith(rt);
	const ran = [];
	m._onHealthy = async (id) => {
		ran.push(id);
	};
	// The startup poll got there first.
	m._runPostStart('w1', rt);
	answers();
	rt.status = 'starting';
	await m._checkChainStall('w1');
	assert.deepEqual(ran, ['w1']);
});

test('a daemon still starting is not demoted; startup owns that window', async () => {
	const rt = runningState();
	rt.status = 'starting';
	rt.healthy = false;
	const m = managerWith(rt);
	silence();
	await m._checkChainStall('w1');
	await m._checkChainStall('w1');
	assert.equal(rt.healthy, false, 'unchanged');
	assert.equal(
		m.logs.length,
		0,
		'no demotion noise while the startup poll is still in charge'
	);
});
