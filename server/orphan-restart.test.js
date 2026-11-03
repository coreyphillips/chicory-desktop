'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A wallet whose daemon was slow to shut down could end up with a LIVE,
 * working daemon the manager no longer tracked: _killProc settled on the
 * timer that sent the SIGKILL rather than on the exit, so the restart spawned
 * a replacement while the old daemon was still up, and the old child's late
 * exit event then cleared rt.proc for that replacement. From there the
 * orphan kept the wallet's instance lock and kept answering /health, so every
 * restart attempt logged healthy and then START_FAILED ("Another beignet
 * instance ... is already using this wallet") forever (field report
 * 2026-09-11, mainnet wallet on port 3102, 58 attempts and counting).
 *
 * Two invariants hold that shut: a kill does not settle before the process is
 * gone, and only the tracked child's exit touches runtime state.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeProc(dieOn) {
	const exits = [];
	return {
		signals: [],
		once(ev, fn) {
			if (ev === 'exit') exits.push(fn);
		},
		kill(sig) {
			this.signals.push(sig);
			if (sig === dieOn) setImmediate(() => this.exit(null, sig));
		},
		exit(code = 0, signal = null) {
			for (const fn of exits.splice(0)) fn(code, signal);
		}
	};
}

function manager(extra = {}) {
	const m = Object.create(WalletManager.prototype);
	m.logs = [];
	m.restarted = 0;
	m._log = (_id, line) => m.logs.push(line);
	m._stopEvents = () => {};
	m._stopLfbwWatch = () => {};
	m._maybeRestart = () => {
		m.restarted += 1;
	};
	return Object.assign(m, extra);
}

const runningState = (proc) => ({
	proc,
	status: 'running',
	healthy: true,
	chainWatch: null
});

test('a kill waits for the exit event, not for the timer that sent the SIGKILL', async () => {
	const m = manager({ killGraceMs: 5, killReapMs: 10000 });
	const proc = fakeProc(null); // ignores every signal
	let settled = false;
	const killed = m._killProc(proc).then(() => {
		settled = true;
	});

	for (let i = 0; i < 200 && !proc.signals.includes('SIGKILL'); i += 1) await sleep(1);
	assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL'], 'the grace lapsed, so it hard-killed');
	await sleep(5);
	assert.equal(settled, false, 'a daemon still holding its instance lock is not gone yet');

	proc.exit(null, 'SIGKILL');
	await killed;
	assert.equal(settled, true);
});

test('a daemon that honours SIGTERM is never hard-killed', async () => {
	const m = manager({ killGraceMs: 10000, killReapMs: 10000 });
	const proc = fakeProc('SIGTERM');
	await m._killProc(proc);
	assert.deepEqual(proc.signals, ['SIGTERM']);
});

test('a wedged process still settles on the reap backstop', async () => {
	const m = manager({ killGraceMs: 5, killReapMs: 5 });
	await m._killProc(fakeProc(null)); // resolves, or this test times out
});

test('a superseded child exiting leaves the running daemon tracked', () => {
	const live = fakeProc(null);
	const rt = runningState(live);
	const m = manager();
	const old = fakeProc(null);

	m._onChildExit('w1', rt, old, 1, null);

	assert.equal(rt.proc, live, 'the replacement keeps its handle');
	assert.equal(rt.status, 'running');
	assert.equal(rt.healthy, true);
	assert.equal(m.restarted, 0, 'nothing to restart: the wallet is up');
	assert.ok(m.logs.some((l) => l.includes('superseded daemon exited')));
});

test('the tracked child exiting clears the wallet and asks for a restart', () => {
	const proc = fakeProc(null);
	const rt = runningState(proc);
	const m = manager();

	m._onChildExit('w1', rt, proc, 1, null);

	assert.equal(rt.proc, null);
	assert.equal(rt.status, 'stopped');
	assert.equal(rt.healthy, false);
	assert.equal(m.restarted, 1);
	assert.ok(m.logs.includes('exited code=1 signal=null'));
});
