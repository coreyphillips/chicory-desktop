'use strict';

/**
 * The desktop drain (issue #29) as the app reaches it: the routes the shared
 * wallet client calls, served over a fake daemon and a fake Electrum. The
 * drain's own rules are covered by drain.test.js, the portable engine's suite
 * run against the port. These cover what this host adds around them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { payments, networks, Transaction, address: bitcoinAddress } = require('bitcoinjs-lib');
const { createDesktopDrains, channelUntouched } = require('./desktop-drain');
const { mountBrowserWalletApi, atomicSave } = require('./browser-wallet');
const { drainAvailable, DRAIN_ROUTE_MARKERS } = require('./engine');

const destination = payments.p2wpkh({ hash: Buffer.alloc(20, 7), network: networks.regtest }).address;
const fundingTxid = 'cd'.repeat(32);
const coin = { txid: 'ab'.repeat(32), vout: 1, valueSats: 2000, frozen: false };

function closeTransaction(valueSats) {
	const tx = new Transaction();
	tx.addInput(Buffer.from(fundingTxid, 'hex').reverse(), 0);
	tx.addOutput(bitcoinAddress.toOutputScript(destination, networks.regtest), valueSats);
	return tx;
}

async function harness(t, { syncMs = 60000 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-drain-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const close = closeTransaction(9000);
	const closeTxid = close.getId();
	const sweepTxid = 'ef'.repeat(32);
	const state = {
		channel: {
			channelId: 'aa'.repeat(32), peerPubkey: 'primary', fundingTxid, fundingOutputIndex: 0,
			localBalanceSats: 9300, state: 'NORMAL', htlcUsable: true, htlcCount: 0
		},
		coins: [{ ...coin }], transactions: [], sweep: null, tip: 100,
		closeSeen: false, closeHeight: 0, sweepStatus: 'submitted', calls: []
	};
	const record = { id: 'w1', network: 'regtest', electrum: { host: '127.0.0.1', port: 1 }, lfbw: { enabled: true, setup: 'ready', primaryPubkey: 'primary' } };
	const rt = { proc: { pid: 1 }, healthy: true, stopping: false, lfbwBusy: false };
	const daemon = async (method, route, body) => {
		state.calls.push(`${method} ${route.split('?')[0]}`);
		switch (`${method} ${route.split('?')[0]}`) {
			case 'GET /peers': return [{ pubkey: 'primary', connected: true }];
			case 'GET /payments': return [];
			case 'GET /channels': return [state.channel];
			case 'GET /utxos': return state.coins;
			case 'GET /transactions': return state.transactions;
			case 'GET /info': return { blockHeight: state.tip };
			case 'GET /fees/estimates': return { normal: 2 };
			case 'POST /channel/close-quote': return { amountSats: 9000, feeSats: 300 };
			case 'POST /tx/quote': return { maxSendSats: 1800, feeSats: 200 };
			case 'POST /onchain/sweep/prepare':
				assert.deepEqual(body.inputOutpoints, [{ txid: coin.txid, vout: coin.vout }]);
				state.sweep = { requestId: body.requestId, txid: sweepTxid, amountSats: 1800, feeSats: 200 };
				state.coins = state.coins.map(item => ({ ...item, frozen: true }));
				return { ...state.sweep };
			case 'POST /onchain/sweep/submit':
				return { ...state.sweep, status: state.sweepStatus };
			case 'GET /onchain/sweep':
				if (!state.sweep) throw Object.assign(new Error('Sweep not found'), { code: 'NOT_FOUND' });
				return state.sweep;
			case 'POST /channel/close':
				assert.equal(body.address, destination);
				state.channel = { ...state.channel, state: 'SHUTTING_DOWN' };
				state.transactions = [{ txid: closeTxid, source: 'cooperative-close', channelId: state.channel.channelId, address: destination, valueSats: 9000, feeSats: 300 }];
				return { closed: true };
			default: throw Object.assign(new Error(`unexpected ${method} ${route}`), { code: 'UNEXPECTED' });
		}
	};
	const electrum = async (_server, [request]) => {
		if (request.method === 'blockchain.scripthash.get_history') {
			const script = bitcoinAddress.toOutputScript(destination, networks.regtest);
			assert.equal(request.params[0], crypto.createHash('sha256').update(script).digest().reverse().toString('hex'));
			return { replies: { 1: { result: state.closeSeen ? [{ tx_hash: closeTxid, height: state.closeHeight }] : [] } } };
		}
		if (request.method === 'blockchain.transaction.get') return { replies: { 1: { result: close.toHex() } } };
		throw new Error('unexpected Electrum call');
	};
	const manager = {
		registry: { get: id => (id === 'w1' ? record : undefined), list: () => [record] },
		paths: () => ({ base: dir }),
		runtimeState: () => rt,
		_daemonCall: (_record, method, route, body) => daemon(method, route, body),
		drainAvailable: () => true,
		offlineReceiveAvailable: () => false
	};
	const start = () => {
		const drains = createDesktopDrains(manager, { atomicSave, electrum, syncMs });
		t.after(() => drains.close());
		const app = express();
		drains.mount(app);
		drains.useWallets(mountBrowserWalletApi(app, manager, { drainActivity: id => drains.activity(id) }));
		// Stands in for the daemon proxy behind the fence.
		app.post('/wallets/:id/api/invoice/pay-safe', (_req, res) => res.json({ ok: true, result: 'paid' }));
		app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ ok: false, error: { code: err.code, message: err.message } }));
		return new Promise(resolve => {
			const server = app.listen(0, '127.0.0.1', () => {
				t.after(() => new Promise(done => server.close(done)));
				resolve({ drains, url: `http://127.0.0.1:${server.address().port}` });
			});
		});
	};
	const { drains, url } = await start();
	const request = async (route, body, base = url) => {
		const reply = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		return { status: reply.status, ...(await reply.json()) };
	};
	return { state, manager, rt, drains, request, start, dir, closeTxid, sweepTxid };
}

test('a reviewed drain holds the wallet until its close is seen, then sweeps and completes', async t => {
	const h = await harness(t);
	const quote = await h.request('/wallets/w1/api/drain/quote', { requestId: 'drain-request-01', address: destination });
	assert.equal(quote.ok, true);
	assert.equal(quote.result.phase, 'review');
	assert.equal(quote.result.debitSats, 9300 + 2000);
	assert.equal(quote.result.amountSats + quote.result.feeSats, quote.result.debitSats);
	// A review holds nothing.
	assert.equal(h.manager.channelizeHeld('w1'), false);
	assert.equal((await h.request('/wallets/w1/api/invoice/pay-safe', {})).result, 'paid');

	// The close is signed, but the chain has not shown it at the address yet.
	const sent = await h.request('/wallets/w1/api/drain/send', { requestId: 'drain-request-01' });
	assert.equal(sent.ok, true);
	assert.equal(sent.result.phase, 'closing');
	// The signed close, and the prepared sweep that waits for it.
	assert.deepEqual(sent.result.txids, [h.closeTxid, h.sweepTxid]);
	assert.equal(h.state.calls.includes('POST /onchain/sweep/submit'), false);
	assert.equal(h.state.calls.filter(call => call === 'POST /channel/close').length, 1);
	assert.equal(h.manager.channelizeHeld('w1'), true);
	const fenced = await h.request('/wallets/w1/api/invoice/pay-safe', {});
	assert.equal(fenced.status, 409);
	assert.equal(fenced.error.code, 'DRAIN_IN_PROGRESS');
	const holding = await h.request('/api/wallets/w1/activity');
	assert.equal(holding.result[0].id, 'drain:drain-request-01');
	assert.equal(holding.result[0].status, 'pending');
	assert.equal(holding.result[0].title, 'Emptying wallet');

	// Seen at the destination: the sweep is submitted and the hold lifts.
	h.state.closeSeen = true;
	const seen = await h.request('/wallets/w1/api/drain?requestId=drain-request-01');
	assert.equal(seen.result.phase, 'pending');
	assert.deepEqual(seen.result.txids, [h.closeTxid, h.sweepTxid]);
	assert.equal(h.manager.channelizeHeld('w1'), false);
	assert.equal((await h.request('/wallets/w1/api/invoice/pay-safe', {})).result, 'paid');
	// Resuming never closes twice.
	assert.equal(h.state.calls.filter(call => call === 'POST /channel/close').length, 1);

	// Both legs confirm.
	h.state.closeHeight = 101; h.state.tip = 101; h.state.sweepStatus = 'confirmed';
	h.state.coins = [];
	const done = await h.request('/wallets/w1/api/drain?requestId=drain-request-01');
	assert.equal(done.result.phase, 'completed');
	assert.equal(done.result.residualSats, 0);
	const activity = await h.request('/api/wallets/w1/activity');
	assert.equal(activity.result[0].title, 'Wallet emptied');
	assert.equal(activity.result[0].status, 'completed');

	// The journal outlives the manager.
	const restarted = await h.start();
	const listed = await h.request('/wallets/w1/api/drain', undefined, restarted.url);
	assert.equal(listed.result.length, 1);
	assert.equal(listed.result[0].phase, 'completed');
});

test('a drain keeps moving with no screen asking about it', async t => {
	const h = await harness(t, { syncMs: 20 });
	await h.request('/wallets/w1/api/drain/quote', { requestId: 'drain-request-02', address: destination });
	await h.request('/wallets/w1/api/drain/send', { requestId: 'drain-request-02' });
	h.state.closeSeen = true;
	const deadline = Date.now() + 3000;
	while (h.manager.channelizeHeld('w1') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(h.manager.channelizeHeld('w1'), false);
	assert.ok(h.state.calls.includes('POST /onchain/sweep/submit'));
});

test('a wallet that is stopped or not ready refuses a review, and the routes need the engine', async t => {
	const h = await harness(t);
	h.rt.healthy = false;
	const refused = await h.request('/wallets/w1/api/drain/quote', { requestId: 'drain-request-03', address: destination });
	assert.equal(refused.status, 409);
	assert.equal(refused.error.code, 'DRAIN_UNAVAILABLE');
	h.rt.healthy = true;
	h.manager.drainAvailable = () => false;
	const unsupported = await h.request('/wallets/w1/api/drain/quote', { requestId: 'drain-request-03', address: destination });
	assert.equal(unsupported.error.code, 'DRAIN_UNAVAILABLE');
	assert.equal((await h.request('/wallets/nobody/api/drain')).status, 404);
	assert.equal(h.state.calls.includes('POST /channel/close'), false);
});

test('an unreadable journal fences the wallet instead of reading as empty', async t => {
	const h = await harness(t);
	fs.writeFileSync(path.join(h.dir, 'drains.json'), '{not json');
	const fenced = await h.request('/wallets/w1/api/invoice/pay-safe', {});
	assert.equal(fenced.error.code, 'DRAIN_JOURNAL_INVALID');
	assert.equal(h.manager.channelizeHeld('w1'), true);
});

test('only an untouched NORMAL channel counts as a close that never started', () => {
	const id = 'aa'.repeat(32);
	const channel = { channelId: id, state: 'NORMAL', fundingTxid, fundingOutputIndex: 0 };
	assert.equal(channelUntouched(channel, id), true);
	assert.equal(channelUntouched({ ...channel, state: 'AWAITING_REESTABLISH', preReestablishState: 'NORMAL' }, id), true);
	for (const changed of [
		{ state: 'SHUTTING_DOWN' }, { state: 'NEGOTIATING_CLOSING' }, { state: 'CLOSED' },
		{ state: 'AWAITING_REESTABLISH', preReestablishState: 'SHUTTING_DOWN' },
		{ closeStatus: { closer: 'cooperative' } }, { restoreRecencyUnproven: true },
		{ reestablishRecencyUnproven: true }, { reestablishSecretMissing: true },
		{ restoreRevokedRisk: true }, { fundingUnaccounted: true }, { fundingTxid: undefined }
	]) assert.equal(channelUntouched({ ...channel, ...changed }, id), false, JSON.stringify(changed));
	assert.equal(channelUntouched(undefined, id), false);
	assert.equal(channelUntouched(channel, 'bb'.repeat(32)), false);
});

test('the drain is offered only when the bundled daemon serves every route it drives', t => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-drain-probe-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const bin = path.join(dir, 'cli.js');
	fs.writeFileSync(path.join(dir, 'daemon.js'), DRAIN_ROUTE_MARKERS.join('\n'));
	assert.equal(drainAvailable(bin), true);
	fs.writeFileSync(path.join(dir, 'daemon.js'), DRAIN_ROUTE_MARKERS.slice(1).join('\n'));
	assert.equal(drainAvailable(bin), false);
	const bundled = path.join(__dirname, '..', '.runtime/engine/node_modules/beignet/dist/cli/cli.js');
	if (fs.existsSync(bundled)) assert.equal(drainAvailable(bundled), true);
});
