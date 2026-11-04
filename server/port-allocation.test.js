'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A wallet's ports used to be chosen only against this manager's own
 * registry, so a second Chicory manager on the same computer, or any other
 * program on that range, could already hold them. The daemon then failed to
 * bind on every start without saying why (issue #18).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const cp = require('node:child_process');

const spawned = [];
cp.spawn = (...args) => { spawned.push(args); throw new Error('no daemon is spawned in these tests'); };
const { config } = require('./config');
const { WalletManager } = require('./wallet-manager');

const LISTEN_OFFSET = 6000;

function listen(port, host) {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen({ port, host, exclusive: true }, () => resolve(server));
	});
}

const close = (server) => new Promise((resolve) => server.close(resolve));

async function bindable(port) {
	for (const host of ['127.0.0.1', '0.0.0.0']) {
		try { await close(await listen(port, host)); } catch { return false; }
	}
	return true;
}

/** A run of `count` wallet ports, with their listen ports, that nothing on this computer holds. */
async function freeRange(count) {
	for (let base = 41000 + Math.floor(Math.random() * 400) * 10; base < 49000; base += 10) {
		let free = true;
		for (let i = 0; i < count && free; i++) free = (await bindable(base + i)) && (await bindable(base + i + LISTEN_OFFSET));
		if (free) return base;
	}
	throw new Error('no free port range for the test');
}

function useRange(t, base, max) {
	const previous = { base: config.childPortBase, max: config.childPortMax };
	config.childPortBase = base;
	config.childPortMax = max;
	t.after(() => { config.childPortBase = previous.base; config.childPortMax = previous.max; });
}

function manager(records = []) {
	const m = Object.create(WalletManager.prototype);
	m.runtime = new Map();
	m.logs = [];
	m.registry = { list: () => records, get: (id) => records.find((rec) => rec.id === id), upsert: () => {} };
	m._log = (_id, line) => m.logs.push(line);
	return m;
}

test('a new wallet skips ports another program holds, on loopback or the listen port', async (t) => {
	const base = await freeRange(3);
	useRange(t, base, base + 2);
	const api = await listen(base, '127.0.0.1');
	const lightning = await listen(base + 1 + LISTEN_OFFSET, '0.0.0.0');
	t.after(() => Promise.all([close(api), close(lightning)]));
	const m = manager();
	assert.equal(await m._reservePort(), base + 2);
});

test('registry ports and concurrent reservations are never handed out twice', async (t) => {
	const base = await freeRange(4);
	useRange(t, base, base + 3);
	const m = manager([{ id: 'existing', port: base }]);
	const [first, second] = await Promise.all([m._reservePort(), m._reservePort()]);
	assert.notEqual(first, second);
	assert.ok(![first, second].includes(base), 'a port another wallet here holds is skipped');
	assert.deepEqual([...m._reserved()].sort(), [first, second].sort());
});

test('a full range is refused instead of reusing a held port', async (t) => {
	const base = await freeRange(1);
	useRange(t, base, base);
	const holder = await listen(base, '127.0.0.1');
	t.after(() => close(holder));
	await assert.rejects(manager()._reservePort(), { code: 'NO_PORT' });
});

test('a create releases its reservation whether it succeeds or fails', async (t) => {
	const base = await freeRange(2);
	useRange(t, base, base + 1);
	const m = manager();
	let seen;
	m._provisionOn = async (_input, port) => { seen = port; throw new Error('validation failed'); };
	await assert.rejects(m._provision({}), /validation failed/);
	assert.equal(seen, base);
	assert.equal(m._reserved().size, 0);
	m._provisionOn = async (_input, port) => ({ port });
	assert.deepEqual(await m._provision({}), { port: base });
	assert.equal(m._reserved().size, 0);
});

test('a busy port is retried briefly, and a port freed in time is not reported', async (t) => {
	const base = await freeRange(1);
	const m = manager();
	const rec = { id: 'w1', port: base };
	assert.equal(await m._busyPort(rec, { attempts: 2, delayMs: 5 }), null);
	const lightning = await listen(base + LISTEN_OFFSET, '0.0.0.0');
	assert.equal(await m._busyPort(rec, { attempts: 2, delayMs: 5 }), base + LISTEN_OFFSET);
	assert.equal(await m._busyPort({ ...rec, onchainOnly: true }, { attempts: 2, delayMs: 5 }), null,
		'an on-chain only wallet runs no Lightning listener');
	// A daemon from an earlier run that exits during the retry frees its port.
	const checking = m._busyPort(rec, { attempts: 20, delayMs: 20 });
	setTimeout(() => lightning.close(), 50);
	assert.equal(await checking, null);
});

test('a wallet whose port is taken fails to start with PORT_IN_USE, and says so', async (t) => {
	const base = await freeRange(1);
	const holder = await listen(base, '127.0.0.1');
	t.after(() => close(holder));
	const rec = { id: 'w1', name: 'Fixture', network: 'regtest', port: base, onchainOnly: true,
		electrum: { host: '127.0.0.1', port: 50001, tls: false }, running: true };
	const m = manager([rec]);
	m.paths = () => ({ home: '/nonexistent', data: '/nonexistent', secrets: '/nonexistent', mnemonicFile: '/nonexistent/mnemonic' });
	m._probeElectrum = async () => true;
	m._busyPort = (row) => WalletManager.prototype._busyPort.call(m, row, { attempts: 2, delayMs: 5 });
	await assert.rejects(m.startWallet('w1'), (err) => {
		assert.equal(err.code, 'PORT_IN_USE');
		assert.equal(err.statusCode, 409);
		assert.match(err.message, new RegExp(`Port ${base} .*already in use`));
		return true;
	});
	const rt = m.runtimeState('w1');
	assert.equal(rt.status, 'error');
	assert.equal(rt.lastStartError.code, 'PORT_IN_USE');
	assert.ok(m.logs.some((line) => line.includes('PORT_IN_USE') || line.includes(`Port ${base}`)));
	assert.equal(rt.spawning, false);
	assert.equal(spawned.length, 0, 'no daemon is launched onto a port it cannot bind');
});

const http = require('node:http');

/** A stand-in daemon: /health for anyone, /info only for `token`. */
async function daemon(t, token, { info } = {}) {
	const calls = [];
	const server = http.createServer((req, res) => {
		calls.push(req.url);
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/health') return res.end(JSON.stringify({ ok: true, result: { running: true } }));
		if (req.url === '/info') {
			if (info) { res.statusCode = info; return res.end('{}'); }
			if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false })); }
			return res.end(JSON.stringify({ ok: true, result: {} }));
		}
		res.statusCode = 404; res.end('{}');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => close(server));
	return { port: server.address().port, calls };
}

test('a daemon that refuses this wallet\'s token is reported as foreign, and ours is trusted once', async (t) => {
	const foreign = await daemon(t, 'someone else');
	const ours = await daemon(t, 'ours');
	const booting = await daemon(t, 'ours', { info: 503 });
	const m = manager();
	m.token = () => 'ours';
	const proc = {};
	m.runtimeState('w1').proc = proc;
	assert.equal((await m._probeHealth({ id: 'w1', port: foreign.port }, 1000)).kind, 'foreign');
	assert.equal((await m._probeHealth({ id: 'w1', port: booting.port }, 1000)).kind, 'ok', 'an inconclusive check never rejects a booting daemon');
	assert.equal((await m._probeHealth({ id: 'w1', port: ours.port }, 1000)).kind, 'ok');
	assert.equal((await m._probeHealth({ id: 'w1', port: ours.port }, 1000)).kind, 'ok');
	assert.deepEqual(ours.calls, ['/health', '/info', '/health'], 'ownership is checked once per child process');
});

test('a wallet whose port another engine answers stops with PORT_IN_USE and is not restarted', async (t) => {
	const foreign = await daemon(t, 'someone else');
	const rec = { id: 'w1', name: 'Fixture', port: foreign.port, running: true };
	const m = manager([rec]);
	m.token = () => 'ours';
	const rt = m.runtimeState('w1');
	const proc = { exited: false };
	rt.proc = proc;
	rt.status = 'starting';
	let restarts = 0;
	m.startWallet = async () => { restarts += 1; };
	m._stopLfbwWatch = () => {}; m._stopDfWatch = () => {}; m._stopEvents = () => {};
	m._killProc = async (child) => { child.exited = true; m._onChildExit('w1', rt, child, null, 'SIGTERM'); };
	await m._pollHealth('w1');
	assert.equal(proc.exited, true, 'our daemon, which never bound the port, is stopped');
	assert.equal(rt.status, 'error');
	assert.equal(rt.healthy, false);
	assert.equal(rt.lastStartError.code, 'PORT_IN_USE');
	assert.match(rt.lastStartError.message, new RegExp(`Port ${foreign.port} .*another wallet engine`));
	assert.equal(rt.lastExit.expected, true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(restarts, 0, 'no restart loop against a port another engine holds');
	assert.ok(m.logs.some((line) => line.includes('another wallet engine')));
});
