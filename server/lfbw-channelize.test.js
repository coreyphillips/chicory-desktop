'use strict';

/**
 * Run with: npm test (from server/).
 *
 * Channelize's I/O shell around the pure decision: what it reads, what it
 * calls, that it never overlaps itself, backs off after a failure, and
 * coalesces a burst of triggers into one pass.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const PK_P = '03' + '22'.repeat(32);

function harness({ answers = {}, lf = {} } = {}) {
	const rec = {
		id: 'w1',
		name: 'Spending',
		network: 'regtest',
		port: 3902,
		nodeId: '02' + '11'.repeat(32),
		lfbw: {
			enabled: true,
			mode: 'internal',
			primaryWalletId: 'p1',
			primaryPubkey: PK_P,
			trusted: true,
			setup: 'ready',
			...lf
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
	m.calls = [];
	m._daemonCall = async (r, method, path, body) => {
		m.calls.push({ wallet: r.id, method, path, body });
		const key = `${r.id} ${method} ${path}`;
		if (answers[key] instanceof Error) throw answers[key];
		if (answers[key] !== undefined) return answers[key];
		if (path === '/info') return { nodeId: r.nodeId, blockHeight: 100 };
		return {};
	};
	return { m, rec };
}

const usable = { channelId: 'c1', peerPubkey: PK_P, state: 'NORMAL', htlcUsable: true };
const confirmed = [{ height: 90 }];

test('a confirmed deposit with a home channel becomes a splice-in at the daemon quote', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /channel/splice-quote': { maxAmountSats: 48000 }
		}
	});
	await m._lfbwChannelize('w1');
	const splice = m.calls.find((c) => c.path === '/channel/splice-in');
	assert.deepEqual(splice.body, { channelId: 'c1', amountSats: 48000, feeratePerkw: 1750 });
	assert.deepEqual(m.calls.find((c) => c.path === '/channel/splice-quote').body, {
		channelId: 'c1',
		direction: 'in',
		feeratePerkw: 1750
	});
});

test('with no channel yet the whole balance opens one to the primary, zero-conf for a trusted pair', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /tx/quote': { maxSendSats: 49000 }
		}
	});
	await m._lfbwChannelize('w1');
	const open = m.calls.find((c) => c.path === '/channel/connect-and-open');
	assert.deepEqual(open.body, {
		pubkey: PK_P,
		host: '127.0.0.1',
		port: 3901 + 6000,
		amountSats: 49000,
		satsPerVbyte: 7,
		max: true,
		trusted: true
	});
	assert.deepEqual(m.calls.find((c) => c.path === '/tx/quote').body, { satsPerVbyte: 7, max: true, channelFunding: true });
});

test('nothing moves while a UTXO is unconfirmed, below the floor, or when setup is not ready', async () => {
	const unconfirmed = harness({
		answers: { 'w1 GET /balance': { onchain: 50000 }, 'w1 GET /utxos': [{ height: null }], 'w1 GET /channels': [usable] }
	});
	await unconfirmed.m._lfbwChannelize('w1');
	assert.equal(unconfirmed.m.calls.some((c) => c.method === 'POST'), false);

	const small = harness({ answers: { 'w1 GET /balance': { onchain: 12000 } } });
	await small.m._lfbwChannelize('w1');
	assert.deepEqual(small.m.calls.map((c) => c.path), ['/balance'], 'the floor is checked before anything else is read');

	const notReady = harness({ lf: { setup: 'failed' }, answers: { 'w1 GET /balance': { onchain: 50000 } } });
	await notReady.m._lfbwChannelize('w1');
	assert.deepEqual(notReady.m.calls, []);
});

test('a failed attempt backs off, and a pass never overlaps another', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /channel/splice-quote': { maxAmountSats: 48000 },
			'w1 POST /channel/splice-in': new Error('peer disconnected')
		}
	});
	await m._lfbwChannelize('w1');
	const rt = m.runtimeState('w1');
	assert.ok(rt.lfbwRetryAt > Date.now(), 'backing off');
	assert.match(m.logs.at(-1), /peer disconnected/);
	const before = m.calls.length;
	await m._lfbwChannelize('w1');
	assert.equal(m.calls.length, before, 'no call during the backoff');
	rt.lfbwRetryAt = 0;
	rt.lfbwBusy = true;
	await m._lfbwChannelize('w1');
	assert.equal(m.calls.length, before, 'no call while another pass runs');
});

test('a burst of triggers coalesces into one pass', async () => {
	const { m } = harness();
	let passes = 0;
	m._lfbwChannelize = async () => {
		passes++;
	};
	m._scheduleChannelize('w1');
	m._scheduleChannelize('w1');
	m._scheduleChannelize('w1');
	assert.ok(m.runtimeState('w1').lfbwTimer);
	await new Promise((r) => setTimeout(r, 2200));
	assert.equal(passes, 1);
	assert.equal(m.runtimeState('w1').lfbwTimer, null);
});

test('an external primary is asked to sell inbound first, then opened to plainly when it refuses', async () => {
	const PK_X = '02' + '33'.repeat(32);
	const { m } = harness({
		lf: { mode: 'external', primaryWalletId: null, primaryUri: `${PK_X}@lsp.example:9735`, primaryPubkey: PK_X, trusted: false },
		answers: {
			'w1 GET /balance': { onchain: 200000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /tx/quote': { maxSendSats: 200000 },
			'w1 POST /channel/open-v2': new Error('peer sells no liquidity')
		}
	});
	await m._lfbwChannelize('w1');
	const v2 = m.calls.find((c) => c.path === '/channel/open-v2');
	assert.equal(v2.body.requestFunds.blockheight, 100);
	const open = m.calls.find((c) => c.path === '/channel/connect-and-open');
	assert.equal(open.body.host, 'lsp.example');
	assert.equal(open.body.trusted, false);
	assert.match(m.logs.find((l) => /inbound purchase failed/.test(l)), /sells no liquidity/);
});

test('an Iroh primary is dialed again over Iroh, then opened to on that connection', async () => {
	const PK_X = '02' + '33'.repeat(32);
	const endpoint = '8e'.repeat(32);
	const relay = 'https://use1-1.relay.n0.iroh.link./';
	const { m } = harness({
		lf: {
			mode: 'external',
			primaryWalletId: null,
			primaryUri: `${PK_X}@iroh:${endpoint}?relay=${encodeURIComponent(relay)}`,
			primaryPubkey: PK_X,
			trusted: true
		},
		answers: {
			'w1 GET /balance': { onchain: 200000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /tx/quote': { maxSendSats: 200000 },
			'w1 POST /channel/open-v2': new Error('peer sells no liquidity')
		}
	});
	const outcome = await m._lfbwChannelize('w1');
	assert.equal(outcome.action, 'open', outcome.error);
	const seq = m.calls.filter((c) => c.method === 'POST').map((c) => c.path);
	assert.deepEqual(seq, ['/tx/quote', '/channel/open-v2', '/peer/connect', '/channel/open']);
	assert.deepEqual(m.calls.find((c) => c.path === '/peer/connect').body, {
		pubkey: PK_X,
		transport: 'iroh',
		endpointId: endpoint,
		relayUrl: relay
	});
	assert.deepEqual(m.calls.find((c) => c.path === '/channel/open').body, {
		pubkey: PK_X,
		amountSats: 200000,
		satsPerVbyte: 7,
		max: true
	});
	assert.equal(m.calls.some((c) => c.path === '/channel/connect-and-open'), false, 'there is no host and port to dial');
});

test('a dual-funded open that succeeds is a decision of its own, and "move now" reports it', async () => {
	const PK_X = '02' + '33'.repeat(32);
	const { m } = harness({
		lf: { mode: 'external', primaryWalletId: null, primaryUri: `${PK_X}@lsp.example:9735`, primaryPubkey: PK_X, trusted: false },
		answers: {
			'w1 GET /balance': { onchain: 200000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /tx/quote': { maxSendSats: 200000 },
			'w1 POST /channel/open-v2': { channelId: 'c2' }
		}
	});
	const rt = m.runtimeState('w1');
	rt.lfbwLast = { at: 1, action: 'wait', reason: 'fee-too-high', feeSats: 4000 };
	const outcome = await m._lfbwChannelize('w1');
	const v2 = m.calls.find((c) => c.path === '/channel/open-v2');
	assert.ok(v2, 'the purchase was placed');
	assert.equal(m.calls.some((c) => c.path === '/channel/connect-and-open'), false, 'no plain open after a success');
	assert.equal(outcome.action, 'open-v2');
	assert.equal(outcome.amountSats, v2.body.amountSats);
	assert.equal(outcome.requestedSats, v2.body.requestFunds.requestedSats);
	assert.equal(rt.lfbwLast.action, 'open-v2', 'the stale fee wait is replaced by the open');
	// "Move now anyway" is the owner's path to a forced open: it reports
	// the open, never a 503 for a wallet that answered.
	const now = await m.channelizeNow('w1');
	assert.equal(now.action, 'open-v2');
	assert.equal(m.calls.filter((c) => c.path === '/channel/open-v2').length, 2);
});

test('channelize is woken by a deposit arriving, one confirming, and the home channel becoming usable', () => {
	const { CHANNELIZE_EVENTS } = require('./lfbw');
	// transaction:received as well: the engine relays confirmed only on a
	// transition, so a deposit first seen in a block never confirms again.
	assert.deepEqual([...CHANNELIZE_EVENTS], ['transaction:received', 'transaction:confirmed', 'channel:ready']);
});

test('a fee above a twentieth of the deposit holds the move, is said once, and yields to "move now"', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable],
			'w1 GET /fees/estimates': { normal: 40 },
			'w1 POST /channel/splice-quote': { maxAmountSats: 48000, feeSats: 4000 }
		}
	});
	await m._lfbwChannelize('w1');
	assert.equal(m.calls.some((c) => c.path === '/channel/splice-in'), false, 'nothing moved');
	const rt = m.runtimeState('w1');
	assert.equal(rt.lfbwLast.reason, 'fee-too-high');
	assert.equal(rt.lfbwLast.feeSats, 4000);
	assert.equal(rt.lfbwLast.amountSats, 48000);
	assert.equal(m.logs.filter((l) => /wait to move/.test(l)).length, 1);
	await m._lfbwChannelize('w1');
	assert.equal(m.logs.filter((l) => /wait to move/.test(l)).length, 1, 'the wait is logged once, not every tick');
	assert.equal(m.publicRecord('w1').lfbw.lastChannelize.reason, 'fee-too-high', 'the record says why');

	const outcome = await m.channelizeNow('w1');
	const splice = m.calls.find((c) => c.path === '/channel/splice-in');
	assert.equal(splice.body.amountSats, 48000, 'forced past the fee wait');
	assert.deepEqual({ action: outcome.action, amountSats: outcome.amountSats }, { action: 'splice-in', amountSats: 48000 });
	assert.equal(rt.lfbwLast.action, 'splice-in');
});

test('"move now" runs at once through a backoff, but never past the channel minimums or another pass', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 26000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable],
			'w1 GET /fees/estimates': { normal: 40 },
			'w1 POST /channel/splice-quote': { maxAmountSats: 21000, feeSats: 5000 }
		}
	});
	const rt = m.runtimeState('w1');
	rt.lfbwRetryAt = Date.now() + 60000;
	const outcome = await m.channelizeNow('w1');
	assert.deepEqual({ action: outcome.action, reason: outcome.reason }, { action: 'wait', reason: 'quote-too-small' });
	assert.equal(m.calls.some((c) => c.path === '/channel/splice-in'), false);
	rt.lfbwBusy = true;
	assert.equal((await m.channelizeNow('w1')).action, 'busy');
	rt.lfbwBusy = false;
	rt.proc = null;
	await assert.rejects(m.channelizeNow('w1'), (e) => e.code === 'NOT_RUNNING');
});

test('a wait below the floor and a failed attempt are recorded for the dashboard', async () => {
	const small = harness({ answers: { 'w1 GET /balance': { onchain: 12000 } } });
	await small.m._lfbwChannelize('w1');
	assert.deepEqual(
		{ action: small.m.runtimeState('w1').lfbwLast.action, reason: small.m.runtimeState('w1').lfbwLast.reason },
		{ action: 'wait', reason: 'below-floor' }
	);
	const failing = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable],
			'w1 GET /fees/estimates': { normal: 7 },
			'w1 POST /channel/splice-quote': { maxAmountSats: 48000, feeSats: 300 },
			'w1 POST /channel/splice-in': new Error('peer disconnected')
		}
	});
	await failing.m._lfbwChannelize('w1');
	assert.equal(failing.m.runtimeState('w1').lfbwLast.action, 'failed');
	await assert.rejects(failing.m.channelizeNow('w1'), (e) => e.code === 'CHANNELIZE_FAILED' && /peer disconnected/.test(e.message));
});

test('automatic receive reservations are excluded from deposit channelization', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable, { ...usable, channelId: 'spendable' }],
			'w1 GET /receive/status': { reservedChannelIds: ['c1'] },
			'w1 POST /channel/splice-quote': { maxAmountSats: 48000 }
		}
	});
	m.offlineReceiveSupported = true;
	await m._lfbwChannelize('w1');
	assert.ok(!m.calls.some((c) => ['/channel/splice-in', '/channel/open'].includes(c.path)));
	assert.equal(m.runtimeState('w1').lfbwLast.action, 'wait');
});
test('an unreadable reservation journal prevents channelization', async () => {
	const { m } = harness({
		answers: {
			'w1 GET /balance': { onchain: 50000 },
			'w1 GET /utxos': confirmed,
			'w1 GET /channels': [usable],
			'w1 GET /receive/status': new Error('unavailable')
		}
	});
	m.offlineReceiveSupported = true;
	await m._lfbwChannelize('w1');
	assert.equal(
		m.calls.some((c) => c.method === 'POST'),
		false
	);
});
