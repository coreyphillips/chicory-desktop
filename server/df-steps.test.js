'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A slow or refused direct funding explains itself only in the daemon's
 * action log, which nothing printed. These pin that its df_ entries reach the
 * wallet log once each, and that a payment can find its own steps again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Console } = require('console');
const { Writable } = require('stream');
const { ActionLogCursor, PrintedStepReader, DirectFundingSteps, ATTEMPT_MAX_MS } = require('./df-steps');
const { WalletManager } = require('./wallet-manager');

const REQUEST = 'd'.repeat(32);
const OTHER = 'e'.repeat(32);
const T0 = 1_757_800_000_000;

/** A daemon's action log, answering GET /logs the way the engine does. */
function fakeDaemon() {
	const log = [];
	const calls = [];
	return {
		log,
		calls,
		call: async (_rec, method, apiPath) => {
			calls.push(`${method} ${apiPath}`);
			const url = new URL(apiPath, 'http://daemon');
			assert.equal(url.pathname, '/logs');
			const since = Number(url.searchParams.get('since'));
			const category = url.searchParams.get('category');
			// Inclusive since, newest first: what sqlite-storage.loadActionLog does.
			return log
				.filter((e) => (!category || e.category === category) && e.timestamp >= since)
				.sort((a, b) => b.timestamp - a.timestamp);
		}
	};
}

function managerWith(daemon, { dir } = {}) {
	const m = Object.create(WalletManager.prototype);
	m.runtime = new Map();
	m.fallbackLogs = new Map();
	m.registry = { get: (id) => (id === 'w1' ? { id: 'w1', port: 3100 } : undefined) };
	m.paths = () => ({ base: dir });
	m._daemonCall = daemon.call;
	m.lines = [];
	m._log = (_id, line, at) => m.lines.push({ line, at });
	const rt = m.runtimeState('w1');
	rt.proc = {};
	rt.healthy = true;
	rt.dfCursor = new ActionLogCursor(T0);
	return { m, rt };
}

const entry = (timestamp, action, data = {}, category = 'channel') => ({ category, action, timestamp, data });

test('the action log\'s df_ entries reach the wallet log once each across two reads, and nothing else does', async () => {
	const daemon = fakeDaemon();
	const { m } = managerWith(daemon);
	daemon.log.push(
		entry(T0 + 100, 'df_lane_skipped', { transportType: 2, reason: 'lane_not_established', error: 'dial timed out' }),
		entry(T0 + 150, 'ready', { channelId: 'c'.repeat(64) }),
		entry(T0 + 200, 'df_offer_accepted', { offerId: 'ab'.repeat(16), paired: false })
	);
	await m._pullDfSteps('w1');
	assert.deepEqual(daemon.calls, [`GET /logs?category=channel&since=${T0}`]);

	// The same millisecond as the last read's newest, which the inclusive since
	// hands back again, and a later one.
	daemon.log.push(
		entry(T0 + 200, 'df_frame_dropped', { transport: 'onion', reason: 'no_listener' }),
		entry(T0 + 900, 'df_offer_completed', { offerId: 'ab'.repeat(16) }),
		entry(T0 + 950, 'channel_update', {})
	);
	await m._pullDfSteps('w1');
	assert.equal(daemon.calls[1], `GET /logs?category=channel&since=${T0 + 200}`, 'the read starts where the last one ended');

	assert.deepEqual(
		m.lines.map((l) => l.line),
		[
			'df_lane_skipped {"transportType":2,"reason":"lane_not_established","error":"dial timed out"}',
			'df_offer_accepted {"offerId":"abababababababababababababababab","paired":false}',
			'df_frame_dropped {"transport":"onion","reason":"no_listener"}',
			'df_offer_completed {"offerId":"abababababababababababababababab"}'
		]
	);
	assert.deepEqual(
		m.lines.map((l) => l.at),
		[T0 + 100, T0 + 200, T0 + 200, T0 + 900],
		'stamped with when the daemon logged them, not when they were read'
	);

	await m._pullDfSteps('w1');
	assert.equal(m.lines.length, 4, 'a third read with nothing new adds nothing');
});

test('a read is skipped while the daemon is not up, and a failed one is asked again from the same place', async () => {
	const daemon = fakeDaemon();
	const { m, rt } = managerWith(daemon);
	rt.healthy = false;
	await m._pullDfSteps('w1');
	assert.equal(daemon.calls.length, 0);

	rt.healthy = true;
	const call = daemon.call;
	m._daemonCall = async () => {
		throw new Error('socket hang up');
	};
	await m._pullDfSteps('w1');
	m._daemonCall = call;
	daemon.log.push(entry(T0 + 5, 'df_lane_skipped', { transportType: 3, reason: 'lane_disabled' }));
	await m._pullDfSteps('w1');
	assert.equal(daemon.calls[0], `GET /logs?category=channel&since=${T0}`);
	assert.equal(m.lines.length, 1);
});

test('a line filed with its own time lands in order in the log ring', () => {
	const m = Object.create(WalletManager.prototype);
	m.runtime = new Map();
	const write = process.stdout.write;
	// Keep the ring's echo to container output out of the test report.
	process.stdout.write = () => true;
	try {
		m._log('w1', 'df_send_started {');
		m._log('w1', 'df_send_committed {');
		m._log('w1', 'df_lane_skipped {}', Date.now() - 60_000);
	} finally {
		process.stdout.write = write;
	}
	assert.deepEqual(
		m.logs('w1').map((l) => l.replace(/^\[[^\]]+\] /, '')),
		['df_lane_skipped {}', 'df_send_started {', 'df_send_committed {']
	);
});

/** What the daemon prints for a step: console.info(action, data), line by line. */
function printed(action, data) {
	let out = '';
	const sink = new Writable({
		write(chunk, _enc, cb) {
			out += chunk;
			cb();
		}
	});
	// A daemon prints to a pipe, so never in colour. In a terminal node --test
	// sets FORCE_COLOR, which would otherwise colour these lines.
	new Console({ stdout: sink, stderr: sink, colorMode: false }).info(action, data);
	return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

test('the payer\'s printed df_send_* lines are read back into steps, however console.info broke them', () => {
	const reader = new PrintedStepReader();
	const steps = [];
	const feed = (lines, at) => lines.forEach((l) => steps.push(...reader.read(l, at)));
	feed(printed('df_send_started', { requestId: REQUEST, offerId: 'f'.repeat(32), amountSat: '50000', resumed: false }), T0);
	feed(['healthy'], T0 + 1);
	feed(printed('df_send_completed', { requestId: REQUEST }), T0 + 2);
	feed(
		printed('df_send_prepared', { requestId: REQUEST, connection: { kind: 'dialing', host: 'x'.repeat(80) }, peerNodeId: '02' + 'ab'.repeat(32) }),
		T0 + 3
	);

	assert.deepEqual(steps, [
		{
			timestamp: T0,
			action: 'df_send_started',
			data: { requestId: REQUEST, offerId: 'f'.repeat(32), amountSat: '50000', resumed: false }
		},
		{ timestamp: T0 + 2, action: 'df_send_completed', data: { requestId: REQUEST } },
		{
			timestamp: T0 + 3,
			action: 'df_send_prepared',
			// The nested connection is a caption the step can do without.
			data: { requestId: REQUEST, peerNodeId: '02' + 'ab'.repeat(32) }
		}
	]);
});

test('a printed df_send_* line starts reading the action log, and an ending one only catches up', async () => {
	const daemon = fakeDaemon();
	const { m, rt } = managerWith(daemon);
	const before = Date.now();
	for (const line of printed('df_send_started', { requestId: REQUEST, offerId: 'f'.repeat(32) })) {
		m._notePrintedStep('w1', rt, line);
	}
	await rt.dfPull;
	assert.equal(daemon.calls.length, 1);
	assert.ok(rt.dfFastUntil > before, 'read on every tick while the exchange can be live');

	for (const line of printed('df_send_completed', { requestId: REQUEST, offerId: 'f'.repeat(32) })) {
		m._notePrintedStep('w1', rt, line);
	}
	await rt.dfPull;
	assert.equal(daemon.calls.length, 2);
	assert.equal(rt.dfFastUntil, 0);
	assert.deepEqual(
		rt.dfSteps.forRequest(REQUEST).map((s) => s.action),
		['df_send_started', 'df_send_completed']
	);
});

test('a step that lands while a read is out is caught up by one more read, which anyone waiting also waits on', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfsteps-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const daemon = fakeDaemon();
	const { m, rt } = managerWith(daemon, { dir });
	let release;
	const held = new Promise((resolve) => (release = resolve));
	const call = daemon.call;
	m._daemonCall = async (...args) => {
		const answer = await call(...args);
		if (daemon.calls.length === 1) await held;
		return answer;
	};
	// The printed refusal is stamped when it is read, so the rest sit just before now.
	const now = Date.now();
	rt.dfSteps.add({ timestamp: now - 120_000, action: 'df_send_started', data: { requestId: REQUEST } });
	m._pullDfSteps('w1');

	daemon.log.push(entry(now - 90_000, 'df_lane_skipped', { transportType: 2, reason: 'lane_not_established' }));
	for (const line of printed('df_send_refused', { requestId: REQUEST, reason: 'offer timed out' })) {
		m._notePrintedStep('w1', rt, line);
	}
	const steps = m.directFundingSteps('w1', { requestId: REQUEST });
	const caughtUp = m.catchUpDirectFundingSteps('w1');
	release();
	assert.deepEqual(
		(await steps).map((s) => s.action),
		['df_send_started', 'df_lane_skipped', 'df_send_refused']
	);
	await caughtUp;
	assert.equal(daemon.calls.length, 2);
	assert.deepEqual(
		m.recordDirectFundingFallback('w1', { reason: 'offer timed out', requestId: REQUEST }).steps.map((s) => s.action),
		['df_send_started', 'df_lane_skipped', 'df_send_refused']
	);
});

test('a payment\'s steps run from its start to its end, with the lanes\' unnamed steps between', () => {
	const steps = new DirectFundingSteps();
	const add = (timestamp, action, data = {}) => steps.add({ timestamp, action, data });
	add(T0, 'df_send_started', { requestId: OTHER });
	add(T0 + 10, 'df_send_refused', { requestId: OTHER, reason: 'expired' });
	add(T0 + 1000, 'df_send_prepared', { requestId: REQUEST });
	add(T0 + 1100, 'df_send_started', { requestId: REQUEST });
	add(T0 + 31_100, 'df_lane_skipped', { transportType: 2, reason: 'lane_not_established' });
	add(T0 + 31_200, 'df_frame_dropped', { reason: 'request_id_mismatch', requestId: OTHER });
	add(T0 + 40_000, 'df_offer_accepted', { offerId: 'ab'.repeat(16) });
	add(T0 + 71_600, 'df_send_committed', { requestId: REQUEST });
	add(T0 + 73_900, 'df_send_completed', { requestId: REQUEST });
	add(T0 + 90_000, 'df_lane_skipped', { transportType: 3, reason: 'lane_disabled' });

	assert.deepEqual(
		steps.forRequest(REQUEST).map((s) => [s.timestamp - T0, s.action]),
		[
			[1000, 'df_send_prepared'],
			[1100, 'df_send_started'],
			[31_100, 'df_lane_skipped'],
			[71_600, 'df_send_committed'],
			[73_900, 'df_send_completed']
		],
		'from the prepare to the receipt; a step naming another request, an offer received, and one after the end, are not this payment\'s'
	);
	assert.deepEqual(
		steps.forRequest(OTHER).map((s) => s.action),
		['df_send_started', 'df_send_refused']
	);
	assert.deepEqual(steps.forRequest(REQUEST.toUpperCase()).length, 5);
	assert.deepEqual(steps.forRequest('0'.repeat(32)), []);
	assert.deepEqual(steps.forRequest(REQUEST, { until: T0 + 500 }), [], 'nothing of it had begun by then');
});

test('an attempt that never logged its end stops at the next payment, or after ATTEMPT_MAX_MS', () => {
	const steps = new DirectFundingSteps();
	const add = (timestamp, action, data = {}) => steps.add({ timestamp, action, data });
	add(T0, 'df_send_started', { requestId: REQUEST });
	add(T0 + 5000, 'df_lane_skipped', { transportType: 2 });
	add(T0 + 6000, 'df_send_started', { requestId: OTHER });
	add(T0 + 7000, 'df_lane_skipped', { transportType: 3 });
	assert.deepEqual(steps.forRequest(REQUEST).map((s) => s.timestamp - T0), [0, 5000]);

	const lone = new DirectFundingSteps();
	lone.add({ timestamp: T0, action: 'df_send_started', data: { requestId: REQUEST } });
	lone.add({ timestamp: T0 + ATTEMPT_MAX_MS + 1, action: 'df_lane_skipped', data: {} });
	assert.equal(lone.forRequest(REQUEST).length, 1);

	// Resumed after the daemon came back: the old start is not this attempt's.
	lone.add({ timestamp: T0 + 2 * ATTEMPT_MAX_MS, action: 'df_send_started', data: { requestId: REQUEST, resumed: true } });
	lone.add({ timestamp: T0 + 2 * ATTEMPT_MAX_MS + 5000, action: 'df_send_completed', data: { requestId: REQUEST } });
	assert.deepEqual(
		lone.forRequest(REQUEST).map((s) => s.action),
		['df_send_started', 'df_send_completed']
	);
	assert.equal(lone.forRequest(REQUEST)[0].data.resumed, true);
});

test('the steps buffer drops its oldest past its cap, and a step heard twice is held once', () => {
	const steps = new DirectFundingSteps({ max: 3 });
	for (let i = 0; i < 5; i++) steps.add({ timestamp: T0 + i, action: 'df_lane_skipped', data: { i } });
	assert.equal(steps.add({ timestamp: T0 + 4, action: 'df_lane_skipped', data: { i: 4 } }), false);
	assert.deepEqual(steps.steps.map((s) => s.data.i), [2, 3, 4]);
	assert.equal(steps.add({ timestamp: T0, action: 'ready', data: {} }), false, 'only df_ steps');
});

test('directFundingSteps reads the daemon first and answers for the request asked', async () => {
	const daemon = fakeDaemon();
	const { m, rt } = managerWith(daemon);
	await assert.rejects(m.directFundingSteps('nope', { requestId: REQUEST }), { statusCode: 404 });
	await assert.rejects(m.directFundingSteps('w1', { requestId: 'xyz' }), { statusCode: 400 });

	rt.dfSteps.add({ timestamp: T0 + 1, action: 'df_send_started', data: { requestId: REQUEST } });
	daemon.log.push(entry(T0 + 30_000, 'df_lane_skipped', { transportType: 2, reason: 'lane_not_established' }));
	const steps = await m.directFundingSteps('w1', { requestId: REQUEST });
	assert.deepEqual(steps.map((s) => s.action), ['df_send_started', 'df_lane_skipped']);
});

test('a fallback keeps the steps the manager saw, and only well-formed scalars of any it is handed', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfsteps-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const { m, rt } = managerWith(fakeDaemon(), { dir });
	rt.dfSteps.add({ timestamp: T0, action: 'df_send_started', data: { requestId: REQUEST } });
	rt.dfSteps.add({ timestamp: T0 + 30_000, action: 'df_lane_skipped', data: { transportType: 2, reason: 'lane_not_established' } });
	rt.dfSteps.add({ timestamp: T0 + 120_000, action: 'df_send_refused', data: { requestId: REQUEST, reason: 'offer timed out' } });

	const seen = m.recordDirectFundingFallback('w1', {
		reason: 'offer timed out',
		requestId: REQUEST,
		steps: [{ timestamp: 1, action: 'df_send_completed', data: {} }]
	});
	assert.deepEqual(
		seen.steps.map((s) => s.action),
		['df_send_started', 'df_lane_skipped', 'df_send_refused'],
		'the manager\'s own record wins over the browser\'s'
	);

	// An RBF bump re-records from the browser after the buffer has moved on.
	const moved = m.recordDirectFundingFallback('w1', {
		reason: 'offer timed out',
		requestId: OTHER,
		steps: [
			{ timestamp: T0, action: 'df_send_started', data: { requestId: OTHER, nested: { a: 1 }, long: 'x'.repeat(900) } },
			{ timestamp: 'soon', action: 'df_lane_skipped', data: {} },
			{ timestamp: T0 + 1, action: '<script>', data: {} }
		]
	});
	assert.deepEqual(moved.steps, [
		{ timestamp: T0, action: 'df_send_started', data: { requestId: OTHER, long: 'x'.repeat(500) } }
	]);
});
