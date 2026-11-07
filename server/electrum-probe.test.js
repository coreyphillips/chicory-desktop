'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The conversation the dashboard has with an Electrum server before anyone
 * trusts it with a wallet: what a reachable server reports, how a slow, silent
 * or absent one is described, how a certificate the wallet would refuse is
 * reported, and the short cache the three callers share.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const { WalletManager } = require('./wallet-manager');
const { KEY, CERT, PIN } = require('./fixtures/electrum-test-cert');
const {
	chainOfGenesis,
	headerHash,
	probeElectrum,
	cachedProbe,
	clearProbeCache,
	probeCacheSize,
	discoverServers,
	MAX_REPLY_BYTES
} = require('./electrum-probe');

const MAINNET = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const TESTNET = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const TESTNET4 = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';
const SIGNET = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
const REGTEST = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const OTHER = 'ff'.repeat(32);

// Each chain's block 0 header, which hashes to its genesis hash.
const GENESIS_TAIL = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a';
const GENESIS_HEADERS = {
	[MAINNET]: `${GENESIS_TAIL}29ab5f49ffff001d1dac2b7c`,
	[TESTNET]: `${GENESIS_TAIL}dae5494dffff001d1aa4ae18`,
	[SIGNET]: `${GENESIS_TAIL}008f4d5fae77031e8ad22203`,
	[REGTEST]: `${GENESIS_TAIL}dae5494dffff7f2002000000`
};

/**
 * A fake Electrum server on loopback. `mode` shapes how it answers:
 * normal (one reply per request, in order), batched (every reply in one
 * write, out of order), split (a reply cut across two writes), silent
 * (connects, never answers), no-features (server.features is an error),
 * drop-features (closes the connection when asked server.features, as
 * Bitkit's server does), no-chain (neither server.features nor block 0's
 * header is answered), flood (bytes without end and never a newline),
 * hangup (answers the first two requests and closes before the third).
 */
async function fakeElectrum(t, { tls: useTls = false, genesis = MAINNET, software = 'electrs/0.10.9', height = 840000, mode = 'normal' } = {}) {
	const state = { connections: 0, lines: [] };
	const unknown = (msg) => ({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
	const answer = (msg) => {
		if (msg.method === 'server.version') return { id: msg.id, result: [software, '1.4'] };
		if (msg.method === 'server.features') {
			if (mode === 'no-features' || mode === 'no-chain') return unknown(msg);
			return { id: msg.id, result: { genesis_hash: genesis, protocol_min: '1.4', protocol_max: '1.4.2', server_version: software } };
		}
		if (msg.method === 'blockchain.block.header' && msg.params[0] === 0) {
			if (mode === 'no-chain') return unknown(msg);
			// A genesis this file has no header for gets one that hashes to
			// no known chain, as a server on some other chain would send.
			return { id: msg.id, result: GENESIS_HEADERS[genesis] || '00'.repeat(80) };
		}
		if (msg.method === 'blockchain.headers.subscribe') return { id: msg.id, result: { height, hex: '' } };
		return unknown(msg);
	};
	const onConnection = (socket) => {
		state.connections += 1;
		socket.on('error', () => {});
		let buf = '';
		// hangup: what is owed so far, since the client's requests may arrive
		// in more than one chunk; the server hangs up once it owes two.
		const owed = [];
		socket.on('data', (chunk) => {
			// Bytes that cannot start JSON (a TLS ClientHello from a client
			// that ticked TLS) get the parse error a real server sends back
			// in plaintext, which is what fails that client's handshake.
			if (!buf && chunk.length && chunk[0] !== 0x7b) {
				if (mode !== 'silent') socket.write('{"id":null,"error":{"code":-32700,"message":"parse error"}}\n');
				return;
			}
			buf += chunk.toString('utf8');
			let nl;
			const replies = [];
			let dropped = false;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				state.lines.push(line);
				const msg = JSON.parse(line);
				if (mode === 'drop-features' && msg.method === 'server.features') {
					dropped = true;
					break;
				}
				replies.push(answer(msg));
			}
			if (dropped) {
				socket.end(replies.map((r) => `${JSON.stringify(r)}\n`).join(''));
				return;
			}
			if (mode === 'silent') return;
			if (mode === 'flood') {
				// Twice the bound, in one go, so the client must stop reading
				// long before any deadline.
				socket.write(Buffer.alloc(2 * MAX_REPLY_BYTES, 0x61));
				return;
			}
			if (!replies.length) return;
			const text = replies.map((r) => `${JSON.stringify(r)}\n`);
			if (mode === 'hangup') {
				owed.push(...text);
				if (owed.length >= 2) socket.end(owed.slice(0, 2).join(''));
				return;
			}
			if (mode === 'batched') {
				socket.write(text.reverse().join(''));
				return;
			}
			if (mode === 'split') {
				// Everything owed so far, cut in the middle of a reply and sent
				// in two writes a moment apart.
				const whole = text.join('');
				const cut = Math.floor(whole.length / 2);
				socket.write(whole.slice(0, cut));
				setTimeout(() => socket.write(whole.slice(cut)), 5);
				return;
			}
			for (const line of text) socket.write(line);
		});
	};
	const server = useTls ? tls.createServer({ key: KEY, cert: CERT }, onConnection) : net.createServer(onConnection);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	return { ...state, state, port: server.address().port, host: '127.0.0.1' };
}

test.beforeEach(() => clearProbeCache());

test('a genesis hash names its chain, and anything else is unknown', () => {
	assert.equal(chainOfGenesis(MAINNET), 'mainnet');
	assert.equal(chainOfGenesis(TESTNET), 'testnet');
	assert.equal(chainOfGenesis(TESTNET4), 'testnet4', 'testnet4 is not what beignet calls testnet');
	assert.equal(chainOfGenesis(SIGNET), 'signet');
	assert.equal(chainOfGenesis(REGTEST), 'regtest');
	assert.equal(chainOfGenesis(MAINNET.toUpperCase()), 'mainnet');
	assert.equal(chainOfGenesis(OTHER), 'unknown');
	assert.equal(chainOfGenesis(null), 'unknown');
	assert.equal(chainOfGenesis(undefined), 'unknown');
});

test('a plain TCP server reports its software, chain and tip', async (t) => {
	const s = await fakeElectrum(t);
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.software, 'electrs/0.10.9');
	assert.equal(r.protocol, '1.4');
	assert.equal(r.chain, 'mainnet');
	assert.equal(r.genesisHash, MAINNET);
	assert.equal(r.height, 840000);
	assert.equal(r.certificate, null);
	assert.equal(r.error, null);
	assert.ok(typeof r.probedAt === 'number');
	assert.match(s.state.lines[0], /server\.version/, 'the client introduces itself before asking anything else');
});

test('replies are matched by id, however the server frames them', async (t) => {
	const batched = await fakeElectrum(t, { mode: 'batched', genesis: TESTNET, height: 2500000 });
	const split = await fakeElectrum(t, { mode: 'split', genesis: TESTNET, height: 2500000 });
	for (const s of [batched, split]) {
		const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
		assert.equal(r.chain, 'testnet');
		assert.equal(r.height, 2500000);
		assert.equal(r.software, 'electrs/0.10.9');
		assert.equal(r.error, null);
	}
});

test("a block header's hash is the one the chain names it by", () => {
	for (const [genesis, header] of Object.entries(GENESIS_HEADERS)) assert.equal(headerHash(header), genesis);
	assert.equal(headerHash(GENESIS_HEADERS[MAINNET].toUpperCase()), MAINNET, 'hex in either case');
	assert.equal(headerHash(GENESIS_HEADERS[MAINNET].slice(2)), null, 'not 80 bytes');
	assert.equal(headerHash('zz'.repeat(80)), null, 'not hex');
	assert.equal(headerHash({ hex: GENESIS_HEADERS[MAINNET] }), null, 'not a string');
});

test('a server without server.features is placed on its chain by block 0', async (t) => {
	const s = await fakeElectrum(t, { mode: 'no-features', genesis: TESTNET });
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.chain, 'testnet');
	assert.equal(r.genesisHash, TESTNET);
	assert.equal(r.height, 840000);
	assert.equal(r.error, null);
});

test('a server that hangs up when asked server.features has answered everything else first', async (t) => {
	const s = await fakeElectrum(t, { mode: 'drop-features' });
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.error, null);
	assert.equal(r.software, 'electrs/0.10.9');
	assert.equal(r.chain, 'mainnet');
	assert.equal(r.height, 840000);
	assert.match(s.state.lines[s.state.lines.length - 1], /server\.features/, 'asked last, so nothing else is lost when it hangs up');
});

test('a server that names its chain neither way is reachable with an unknown chain', async (t) => {
	const s = await fakeElectrum(t, { mode: 'no-chain' });
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.chain, 'unknown');
	assert.equal(r.genesisHash, null);
	assert.equal(r.height, 840000);
	assert.equal(r.error, null);
});

test('server.features names the chain when it and block 0 disagree', async (t) => {
	// server.features names one genesis and block 0 hashes to another: the
	// claim stands, as it did before block 0 was asked for.
	const s = await fakeElectrum(t, { genesis: OTHER });
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.genesisHash, OTHER);
	assert.equal(r.chain, 'unknown');
});

test('a closed port is unreachable, quickly', async () => {
	const srv = net.createServer();
	await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
	const { port } = srv.address();
	await new Promise((resolve) => srv.close(resolve));
	const started = Date.now();
	const r = await probeElectrum({ host: '127.0.0.1', port, tls: false });
	assert.equal(r.reachable, false);
	assert.equal(r.error, 'unreachable');
	assert.equal(r.chain, 'unknown');
	assert.ok(Date.now() - started < 1000);
});

test('a server that connects but never answers times out within the bound', async (t) => {
	// Deliver connection deterministically before the timeout clock can fire.
	// A loaded CI runner can take more than 200 ms to dispatch a real loopback
	// connection, which would exercise the separate never-connected case below.
	const socket = new net.Socket();
	const requests = [];
	socket.write = (request) => { requests.push(request); return true; };
	t.after(() => socket.destroy());
	const transport = { net: { connect() {
		queueMicrotask(() => socket.emit('connect'));
		return socket;
	} } };
	const started = Date.now();
	const r = await probeElectrum({ host: '127.0.0.1', port: 50001, tls: false }, { timeoutMs: 200, transport });
	assert.equal(r.reachable, true);
	assert.equal(r.error, 'timeout');
	assert.equal(r.chain, 'unknown');
	assert.ok(requests.length > 0, 'the connected peer received requests but supplied no replies');
	assert.equal(socket.destroyed, true, 'the timed-out connection is released');
	assert.ok(Date.now() - started < 1000);
});

test('an address where the connection never completes is not reachable, even on timeout', async () => {
	// A socket that is never connected stands in for a LAN address that is
	// off, firewalled or wrong: no refusal, no answer, nothing until the
	// deadline. That is "not found", not a server that kept quiet.
	let made = 0;
	const transport = {
		net: {
			connect() {
				made += 1;
				return new net.Socket();
			}
		},
		tls: {
			connect() {
				made += 1;
				return new tls.TLSSocket(new net.Socket());
			}
		}
	};
	const plain = await probeElectrum({ host: '192.0.2.1', port: 50001, tls: false }, { timeoutMs: 150, transport });
	assert.equal(plain.reachable, false, 'nothing accepted the connection');
	assert.equal(plain.error, 'timeout');
	const secure = await probeElectrum({ host: '192.0.2.1', port: 50002, tls: true }, { timeoutMs: 150, transport });
	assert.equal(secure.reachable, false);
	assert.equal(secure.error, 'timeout');
	assert.equal(made, 2);
});

test('a peer that sends without end is cut off at the bound, not read until the deadline', async (t) => {
	const s = await fakeElectrum(t, { mode: 'flood' });
	const started = Date.now();
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false }, { timeoutMs: 5000 });
	assert.equal(r.reachable, true);
	assert.equal(r.error, 'bad-reply');
	assert.ok(Date.now() - started < 2000, 'stopped at the byte bound, well before the deadline');
});

test('a server that hangs up after saying which chain it is on is still on that chain', async (t) => {
	const s = await fakeElectrum(t, { mode: 'hangup', genesis: TESTNET });
	const r = await probeElectrum({ host: s.host, port: s.port, tls: false });
	assert.equal(r.reachable, true);
	assert.equal(r.error, null);
	assert.equal(r.software, 'electrs/0.10.9');
	assert.equal(r.chain, 'testnet', 'the chain guard must still see the mismatch');
	assert.equal(r.height, null, 'the reply that never came is simply absent');
});

test('the TLS box the wrong way round is reported as that, both ways', async (t) => {
	const plain = await fakeElectrum(t);
	const overTls = await probeElectrum({ host: plain.host, port: plain.port, tls: true }, { timeoutMs: 1000 });
	assert.equal(overTls.reachable, true, 'the server is there');
	assert.equal(overTls.error, 'tls-mismatch', 'a plaintext server cannot complete a TLS handshake');
	const secure = await fakeElectrum(t, { tls: true });
	const inPlain = await probeElectrum({ host: secure.host, port: secure.port, tls: false }, { timeoutMs: 1000 });
	assert.equal(inPlain.reachable, true);
	assert.equal(inPlain.error, 'tls-mismatch', 'a TLS server drops a plaintext client, with an alert or without a word');
	// A plaintext server that waits for a newline (electrs) never answers
	// the handshake at all: that stays a timeout, and the dashboard adds the
	// TLS hint to it.
	const quiet = await fakeElectrum(t, { mode: 'silent' });
	const quietOverTls = await probeElectrum({ host: quiet.host, port: quiet.port, tls: true }, { timeoutMs: 200 });
	assert.equal(quietOverTls.reachable, true);
	assert.equal(quietOverTls.error, 'timeout');
});

test('a TLS server is described with its certificate, by the wallet rule', async (t) => {
	const s = await fakeElectrum(t, { tls: true });
	const base = { host: s.host, port: s.port, tls: true };
	const loose = await probeElectrum(base);
	assert.equal(loose.reachable, true);
	assert.equal(loose.chain, 'mainnet');
	assert.deepEqual(loose.certificate, { accepted: true, authorized: false, fingerprint: PIN });
	const linesBefore = s.state.lines.length;
	const refused = await probeElectrum({ ...base, tlsVerify: true });
	assert.equal(refused.reachable, true);
	assert.equal(refused.error, 'tls-rejected');
	assert.equal(refused.chain, 'unknown');
	assert.deepEqual(refused.certificate, { accepted: false, authorized: false, fingerprint: PIN }, 'the fingerprint is reported so it can be pinned');
	assert.equal(s.state.lines.length, linesBefore, 'nothing was asked of a server the wallet would refuse');
	const pinned = await probeElectrum({ ...base, tlsVerify: true, tlsFingerprints: [PIN] });
	assert.equal(pinned.error, null);
	assert.equal(pinned.chain, 'mainnet');
	assert.equal(pinned.certificate.accepted, true);
	const wrongPin = await probeElectrum({ ...base, tlsVerify: true, tlsFingerprints: [OTHER] });
	assert.equal(wrongPin.error, 'tls-rejected');
});

test('discovery probes every preset at once and keeps their order and fields', async (t) => {
	const up = await fakeElectrum(t);
	const quiet = await fakeElectrum(t, { mode: 'silent' });
	const presets = [
		{ id: 'quiet', label: 'Quiet', host: quiet.host, port: quiet.port, tls: false, note: 'n' },
		{ id: 'up', label: 'Up', host: up.host, port: up.port, tls: false, note: 'n' }
	];
	const started = Date.now();
	const { at, servers } = await discoverServers(presets, { timeoutMs: 300 });
	assert.ok(Date.now() - started < 600, 'one bound, not one per preset');
	assert.ok(typeof at === 'number');
	assert.deepEqual(servers.map((s) => s.id), ['quiet', 'up']);
	assert.equal(servers[0].label, 'Quiet');
	assert.equal(servers[0].error, 'timeout');
	assert.equal(servers[1].chain, 'mainnet');
	assert.equal(servers[1].note, 'n');
});

test('a result stands for a few seconds, and refresh asks again', async (t) => {
	const s = await fakeElectrum(t);
	const electrum = { host: s.host, port: s.port, tls: false };
	const a = await cachedProbe(electrum);
	const b = await cachedProbe(electrum);
	assert.equal(s.state.connections, 1, 'one conversation answers both');
	assert.equal(a, b);
	await cachedProbe(electrum, { refresh: true });
	assert.equal(s.state.connections, 2);
	await cachedProbe({ ...electrum, tls: false, tlsVerify: true });
	assert.equal(s.state.connections, 3, 'a different record is a different question');
	clearProbeCache();
	await cachedProbe(electrum);
	assert.equal(s.state.connections, 4);
});

test('results past their time are dropped when a new one is filed', async (t) => {
	const s = await fakeElectrum(t);
	// Twenty different questions, each answer good for no time at all: every
	// new one sweeps the ones before it, so only the newest is ever held.
	for (let i = 0; i < 20; i++) {
		await cachedProbe({ host: s.host, port: s.port, tls: false, tlsFingerprints: [`pin${i}`] }, { ttlMs: 0 });
	}
	assert.equal(probeCacheSize(), 1, 'expired entries are swept as new ones arrive');
	await cachedProbe({ host: s.host, port: s.port, tls: false }, { ttlMs: 60000 });
	assert.equal(probeCacheSize(), 1, 'only the live entry remains');
	await cachedProbe({ host: s.host, port: s.port, tls: true }, { ttlMs: 60000 });
	assert.equal(probeCacheSize(), 2, 'a live entry is kept');
});

test("the manager's tip probe still reads a height through the shared socket code", async (t) => {
	const s = await fakeElectrum(t, { height: 912345 });
	const m = Object.create(WalletManager.prototype);
	assert.equal(await m._electrumTip({ host: s.host, port: s.port, tls: false }), 912345);
	const silent = await fakeElectrum(t, { mode: 'silent' });
	const started = Date.now();
	assert.equal(await m._electrumTip({ host: silent.host, port: silent.port, tls: false }), null);
	assert.ok(Date.now() - started < 4000);
});

test('an onion probe verifies the destination over the owned TCP bridge', async t => {
  const { EventEmitter } = require('node:events');
  const { configureDesktopNetwork } = require('./desktop-network');
  const previous = process.env.DESKTOP_TOR_MANAGED;
  process.env.DESKTOP_TOR_MANAGED = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DESKTOP_TOR_MANAGED;
    else process.env.DESKTOP_TOR_MANAGED = previous;
  });
  const remote = await fakeElectrum(t, { tls: true });
  const endpoint = { host: remote.host, port: remote.port };
  const host = 'a'.repeat(56) + '.onion';
  const channel = Object.assign(new EventEmitter(), { connected: true, send(message) {
    assert.equal(message.host, host);
    queueMicrotask(() => channel.emit('message', { type: 'tor:result', requestId: message.requestId, result: endpoint }));
  } });
  const desktop = configureDesktopNetwork({ transport: channel });
  t.after(() => desktop.close());
  const config = { host, port: 50002, tls: true, tlsVerify: true };
  assert.equal((await probeElectrum({ ...config, tlsFingerprints: [OTHER] })).error, 'tls-rejected');
  assert.deepEqual(remote.state.lines, []);
  assert.equal((await probeElectrum({ ...config, tlsFingerprints: [PIN] })).chain, 'mainnet');
});
