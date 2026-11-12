'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The lightning-first setup sequence, held against a recording daemon: the
 * calls it makes and their order for an internal and an external primary,
 * that a starting channel is opened once and never again, that a failure
 * lands in the record rather than a throw, and that two setups of one
 * wallet cannot overlap.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const PK_W = '02' + '11'.repeat(32);
const PK_P = '03' + '22'.repeat(32);
const PK_X = '02' + '33'.repeat(32);

function harness({ wallet, primary, running = ['w1', 'p1'], answers = {} } = {}) {
	const records = {};
	for (const r of [wallet, primary].filter(Boolean)) records[r.id] = r;
	const m = Object.create(WalletManager.prototype);
	m.registry = {
		get: (id) => records[id],
		list: () => Object.values(records),
		upsert: (r) => {
			records[r.id] = r;
		}
	};
	m.runtime = new Map();
	for (const id of running) m.runtimeState(id).proc = { pid: 1 };
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.lfbwSupported = true;
	m.lfbwSetupRunning = new Set();
	m.onion = null;
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	m.calls = [];
	m.restarts = [];
	m._waitDaemonHealthy = async () => {};
	m._restartWallet = async (id) => {
		m.restarts.push(id);
	};
	m._daemonCall = async (rec, method, path, body) => {
		m.calls.push({ wallet: rec.id, method, path, body });
		const key = `${rec.id} ${method} ${path}`;
		if (answers[key] instanceof Error) throw answers[key];
		if (typeof answers[key] === 'function') return answers[key](body);
		if (answers[key] !== undefined) return answers[key];
		if (path === '/info') return { nodeId: rec.id === 'w1' ? PK_W : PK_P, blockHeight: 100 };
		return {};
	};
	return { m, records };
}

const walletRec = (lf = {}) => ({
	id: 'w1',
	name: 'Spending',
	network: 'regtest',
	port: 3902,
	onchainOnly: false,
	lfbw: {
		enabled: true,
		mode: 'internal',
		primaryWalletId: 'p1',
		primaryUri: null,
		primaryPubkey: null,
		trusted: true,
		initialChannelSats: 0,
		initialChannelOpened: false,
		setup: 'pending',
		setupError: null,
		setupAt: null,
		...lf
	}
});
const primaryRec = (extra = {}) => ({
	id: 'p1',
	name: 'Primary',
	network: 'regtest',
	port: 3901,
	onchainOnly: false,
	liquidityProvider: false,
	...extra
});

test('an internal, trusted setup pairs both ways, arms direct funding on the primary, and connects', async () => {
	const { m, records } = harness({ wallet: walletRec(), primary: primaryRec() });
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	assert.equal(records.w1.nodeId, PK_W);
	assert.equal(records.p1.nodeId, PK_P);
	assert.equal(records.w1.lfbw.primaryPubkey, PK_P);
	assert.equal(records.p1.liquidityProvider, true, 'the primary now provides liquidity');
	const seq = m.calls.map((c) => `${c.wallet} ${c.method} ${c.path}`);
	assert.deepEqual(seq, [
		'w1 GET /info',
		'p1 GET /info',
		'w1 POST /trusted-peer/add',
		'p1 POST /trusted-peer/add',
		'w1 POST /direct-funding/configure',
		'w1 POST /peer/connect'
	]);
	const byPath = (p, w = 'w1') => m.calls.find((c) => c.path === p && c.wallet === w).body;
	assert.deepEqual(byPath('/trusted-peer/add'), { pubkey: PK_P });
	assert.deepEqual(byPath('/trusted-peer/add', 'p1'), { pubkey: PK_W });
	assert.deepEqual(byPath('/direct-funding/configure'), {
		lspPubkey: PK_P,
		lspHost: '127.0.0.1',
		lspPort: 3901 + 6000,
		targetInboundSat: 0,
		trusted: true,
		allowSplice: true,
		allowUnpairedSplice: true
	});
	assert.deepEqual(byPath('/peer/connect'), { pubkey: PK_P, host: '127.0.0.1', port: 3901 + 6000 });
	assert.ok(out.lfbw.setupAt);
});

test('the primary daemon is restarted once when it was spawned without the provider role', async () => {
	const { m } = harness({ wallet: walletRec(), primary: primaryRec() });
	m.runtimeState('p1').spawnedEnv = { BEIGNET_NETWORK: 'regtest' };
	await m.setupLfbw('w1');
	assert.deepEqual(m.restarts, ['p1']);
	// The restart spawned it with the role; the next setup leaves it alone.
	m.runtimeState('p1').spawnedEnv = { BEIGNET_JIT_RECEIVE: 'true', BEIGNET_DF_RELAY: 'true', BEIGNET_WAIVE_CLIENT_RESERVE: 'true', BEIGNET_JIT_FLAT_FEE_SAT: '0', BEIGNET_JIT_FEE_PPM: '0', BEIGNET_JIT_MAX_CLIENT_FUNDING_SAT: '1000000', BEIGNET_JIT_MAX_CONCURRENT_FUNDINGS: '3' };
	await m.setupLfbw('w1');
	assert.deepEqual(m.restarts, ['p1']);
});

test('an untrusted internal pair skips trust in both directions and asks for no zero-conf', async () => {
	const { m } = harness({ wallet: walletRec({ trusted: false }), primary: primaryRec() });
	await m.setupLfbw('w1');
	assert.equal(m.calls.some((c) => c.path === '/trusted-peer/add'), false);
	const cfg = m.calls.find((c) => c.path === '/direct-funding/configure').body;
	assert.equal(cfg.trusted, false);
	assert.equal(cfg.allowSplice, true, 'splicing the home channel needs no zero-conf');
});

test('the starting channel is opened from the primary exactly once, even across a retry', async () => {
	const { m, records } = harness({ wallet: walletRec({ initialChannelSats: 200000 }), primary: primaryRec() });
	await m.setupLfbw('w1');
	const opens = m.calls.filter((c) => c.path === '/channel/connect-and-open');
	assert.equal(opens.length, 1);
	assert.equal(opens[0].wallet, 'p1', 'funded by the primary');
	assert.deepEqual(opens[0].body, {
		pubkey: PK_W,
		host: '127.0.0.1',
		port: 3902 + 6000,
		amountSats: 200000,
		trusted: true
	});
	assert.equal(records.w1.lfbw.initialChannelOpened, true);
	await m.setupLfbw('w1');
	assert.equal(m.calls.filter((c) => c.path === '/channel/connect-and-open').length, 1);
});

test('a starting-channel call that throws still counts as opened, so a retry cannot open twice', async () => {
	const { m, records } = harness({
		wallet: walletRec({ initialChannelSats: 200000 }),
		primary: primaryRec(),
		answers: { 'p1 POST /channel/connect-and-open': new Error('timed out') }
	});
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'failed');
	assert.match(out.lfbw.setupError, /timed out/);
	assert.equal(records.w1.lfbw.initialChannelOpened, true);
});

test('an external primary is trusted by the wallet alone, gets no return trust, and is asked to sell inbound', async () => {
	const wallet = walletRec({
		mode: 'external',
		primaryWalletId: null,
		primaryUri: `${PK_X}@lsp.example:9735`,
		primaryPubkey: PK_X,
		trusted: true
	});
	const { m } = harness({ wallet, running: ['w1'] });
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	const seq = m.calls.map((c) => `${c.wallet} ${c.method} ${c.path}`);
	assert.deepEqual(seq, ['w1 GET /info', 'w1 POST /trusted-peer/add', 'w1 POST /direct-funding/configure', 'w1 POST /peer/connect']);
	assert.deepEqual(m.calls.find((c) => c.path === '/trusted-peer/add').body, { pubkey: PK_X });
	const cfg = m.calls.find((c) => c.path === '/direct-funding/configure').body;
	assert.deepEqual(cfg, {
		lspPubkey: PK_X,
		lspHost: 'lsp.example',
		lspPort: 9735,
		targetInboundSat: 100000,
		trusted: true,
		allowSplice: true,
		allowUnpairedSplice: true
	});
	// Declined: no trust call at all, and no zero-conf on direct funding.
	const declined = harness({ wallet: walletRec({ mode: 'external', primaryWalletId: null, primaryUri: `${PK_X}@lsp.example:9735`, primaryPubkey: PK_X, trusted: false }), running: ['w1'] });
	await declined.m.setupLfbw('w1');
	assert.equal(declined.m.calls.some((c) => c.path === '/trusted-peer/add'), false);
	assert.equal(declined.m.calls.find((c) => c.path === '/direct-funding/configure').body.trusted, false);
	assert.deepEqual(m.calls.find((c) => c.path === '/peer/connect').body, {
		pubkey: PK_X,
		host: 'lsp.example',
		port: 9735
	});
});

test('an external Iroh primary is dialed by endpoint and relay, and is a relay for payers only through its onion', async () => {
	const endpoint = '8e'.repeat(32);
	const relay = 'https://use1-1.relay.n0.iroh.link./';
	const uri = `${PK_X}@iroh:${endpoint}?relay=${encodeURIComponent(relay)}`;
	const onion = 'b'.repeat(56) + '.onion';
	const irohWallet = (extra = {}) =>
		walletRec({ mode: 'external', primaryWalletId: null, primaryUri: uri, primaryPubkey: PK_X, trusted: true, ...extra });

	const { m } = harness({ wallet: irohWallet(), running: ['w1'] });
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	const seq = m.calls.map((c) => `${c.wallet} ${c.method} ${c.path}`);
	assert.deepEqual(seq, ['w1 GET /info', 'w1 POST /trusted-peer/add', 'w1 POST /direct-funding/configure', 'w1 POST /peer/connect']);
	assert.deepEqual(m.calls.find((c) => c.path === '/peer/connect').body, {
		pubkey: PK_X,
		transport: 'iroh',
		endpointId: endpoint,
		relayUrl: relay
	});
	assert.deepEqual(m.calls.find((c) => c.path === '/direct-funding/configure').body, {
		lspPubkey: PK_X,
		targetInboundSat: 100000,
		trusted: true,
		allowSplice: true,
		allowUnpairedSplice: true
	});

	const fallback = harness({ wallet: irohWallet({ primaryFallbackUri: `${PK_X}@${onion}:9735` }), running: ['w1'] });
	assert.equal((await fallback.m.setupLfbw('w1')).lfbw.setup, 'ready');
	assert.deepEqual(fallback.m.calls.find((c) => c.path === '/peer/connect').body, {
		pubkey: PK_X,
		transport: 'iroh',
		endpointId: endpoint,
		relayUrl: relay,
		fallbackOnion: { host: onion, port: 9735 }
	});
	const cfg = fallback.m.calls.find((c) => c.path === '/direct-funding/configure').body;
	assert.equal(cfg.lspHost, onion);
	assert.equal(cfg.lspPort, 9735);

	// On a computer with no native Iroh module (issue #80) the engine reaches
	// the node through the onion alone. A link held without one, from a
	// version that took it, fails with what to change and is not dialed; one
	// with it is dialed as before, and the engine falls back.
	const bare = harness({ wallet: irohWallet(), running: ['w1'] });
	bare.m.irohSupported = true;
	bare.m.irohModuleSupported = false;
	const failed = await bare.m.setupLfbw('w1');
	assert.equal(failed.lfbw.setup, 'failed');
	assert.match(failed.lfbw.setupError, /^This app has no Iroh module for this computer \(.+ on .+\), so it cannot connect through an Iroh link alone\. Use another address for the node, or add its onion address as the Tor fallback\.$/);
	assert.equal(bare.m.calls.some((c) => c.path === '/peer/connect'), false);
	const viaTor = harness({ wallet: irohWallet({ primaryFallbackUri: `${PK_X}@${onion}:9735` }), running: ['w1'] });
	viaTor.m.irohSupported = true;
	viaTor.m.irohModuleSupported = false;
	assert.equal((await viaTor.m.setupLfbw('w1')).lfbw.setup, 'ready');
	assert.deepEqual(viaTor.m.calls.find((c) => c.path === '/peer/connect').body.fallbackOnion, { host: onion, port: 9735 });
});


test('an external Porch primary is dialed by its WebSocket URL alone, and is no relay for payers (coreyphillips/beignet#1980)', async () => {
	const url = `wss://relay.example/v1/p/${'a'.repeat(32)}`;
	const porchWallet = () =>
		walletRec({ mode: 'external', primaryWalletId: null, primaryUri: `${PK_X}@${url}`, primaryPubkey: PK_X, trusted: true });

	const { m } = harness({ wallet: porchWallet(), running: ['w1'] });
	m.porchDialSupported = true;
	const out = await m.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'ready', out.lfbw.setupError);
	const seq = m.calls.map((c) => `${c.wallet} ${c.method} ${c.path}`);
	assert.deepEqual(seq, ['w1 GET /info', 'w1 POST /trusted-peer/add', 'w1 POST /direct-funding/configure', 'w1 POST /peer/connect']);
	// No host and no port: the engine takes the address from the URL and
	// refuses a pair beside it that differs.
	assert.deepEqual(m.calls.find((c) => c.path === '/peer/connect').body, { pubkey: PK_X, transport: 'ws', url });
	// The relay is not the node, so payers are given no address for it.
	assert.deepEqual(m.calls.find((c) => c.path === '/direct-funding/configure').body, {
		lspPubkey: PK_X,
		targetInboundSat: 100000,
		trusted: true,
		allowSplice: true,
		allowUnpairedSplice: true
	});
	assert.deepEqual(await m._primaryEndpoint(out.lfbw), {
		pubkey: PK_X,
		connectHost: null,
		connectPort: 0,
		transport: { type: 'ws', url },
		relayHost: null,
		relayPort: 0,
		rec: null
	});

	// An engine that would dial the relay outside the wallet's route (before
	// beignet #1995) is never asked to: the setup fails saying so.
	const old = harness({ wallet: porchWallet(), running: ['w1'] });
	old.m.porchDialSupported = false;
	const failed = await old.m.setupLfbw('w1');
	assert.equal(failed.lfbw.setup, 'failed');
	assert.equal(failed.lfbw.setupError, 'The bundled engine does not support Porch links, so it cannot reach this primary node.');
	assert.equal(old.m.calls.some((c) => c.path === '/peer/connect'), false);
	// The missing Iroh module is no obstacle to a Porch link (issue #80).
	const noIroh = harness({ wallet: porchWallet(), running: ['w1'] });
	noIroh.m.porchDialSupported = true;
	noIroh.m.irohSupported = true;
	noIroh.m.irohModuleSupported = false;
	assert.equal((await noIroh.m.setupLfbw('w1')).lfbw.setup, 'ready');
	assert.deepEqual(noIroh.m.calls.find((c) => c.path === '/peer/connect').body, { pubkey: PK_X, transport: 'ws', url });
});

test('a connect refusal is not a failure when the peer list shows the primary connected', async () => {
	const { m } = harness({
		wallet: walletRec(),
		primary: primaryRec(),
		answers: {
			'w1 POST /peer/connect': new Error('already connected'),
			'w1 GET /peers': [{ pubkey: PK_P }]
		}
	});
	assert.equal((await m.setupLfbw('w1')).lfbw.setup, 'ready');
	const { m: m2 } = harness({
		wallet: walletRec(),
		primary: primaryRec(),
		answers: { 'w1 POST /peer/connect': new Error('unreachable'), 'w1 GET /peers': [] }
	});
	const out = await m2.setupLfbw('w1');
	assert.equal(out.lfbw.setup, 'failed');
	assert.match(out.lfbw.setupError, /unreachable/);
});

test('a primary that is missing, on-chain only or stopped fails setup with a reason', async () => {
	const missing = harness({ wallet: walletRec() });
	assert.match((await missing.m.setupLfbw('w1')).lfbw.setupError, /no longer exists/);
	const parked = harness({ wallet: walletRec(), primary: primaryRec({ onchainOnly: true }) });
	assert.match((await parked.m.setupLfbw('w1')).lfbw.setupError, /on-chain only/);
	const stopped = harness({ wallet: walletRec(), primary: primaryRec(), running: ['w1'] });
	assert.match((await stopped.m.setupLfbw('w1')).lfbw.setupError, /not running/);
});

test('setup refuses a wallet that is not lightning-first or not running', async () => {
	const plain = harness({ wallet: { ...walletRec(), lfbw: null }, primary: primaryRec() });
	await assert.rejects(plain.m.setupLfbw('w1'), (err) => err.code === 'NOT_LFBW');
	const stopped = harness({ wallet: walletRec(), primary: primaryRec(), running: ['p1'] });
	await assert.rejects(stopped.m.setupLfbw('w1'), (err) => err.code === 'NOT_RUNNING');
	await assert.rejects(stopped.m.setupLfbw('nope'), (err) => err.code === 'NOT_FOUND');
});

test('two setups of one wallet do not overlap', async () => {
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const { m } = harness({ wallet: walletRec(), primary: primaryRec() });
	const inner = m._daemonCall;
	m._daemonCall = async (rec, method, path, body) => {
		if (path === '/info' && rec.id === 'w1') await gate;
		return inner(rec, method, path, body);
	};
	const first = m.setupLfbw('w1');
	const second = await m.setupLfbw('w1');
	assert.equal(second.lfbw.setup, 'pending', 'the second call returns the record as it stands');
	release();
	assert.equal((await first).lfbw.setup, 'ready');
	assert.equal(m.calls.filter((c) => c.path === '/direct-funding/configure').length, 1);
});

test('restoring links after a primary comes up re-runs setup for itself and its running dependents', async () => {
	const { m } = harness({ wallet: walletRec(), primary: primaryRec() });
	const ran = [];
	m.setupLfbw = async (id) => {
		ran.push(id);
	};
	await m._restoreLfbwLinks('p1');
	assert.deepEqual(ran, ['w1']);
	ran.length = 0;
	await m._restoreLfbwLinks('w1');
	assert.deepEqual(ran, ['w1']);
	ran.length = 0;
	m.runtimeState('w1').proc = null;
	await m._restoreLfbwLinks('p1');
	assert.deepEqual(ran, [], 'a stopped dependent is left for its own start');
});
