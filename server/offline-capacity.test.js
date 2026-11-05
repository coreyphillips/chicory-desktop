'use strict';

/**
 * GET /receive/offline: the most one offline receive can take, worked out
 * with the daemon's own channel rule, so the Receive screen can say it
 * before an amount over it is refused.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { offlineCapacity, createOfflineCapacity, HEADROOM_SATS, MINIMUM_SATS } = require('./offline-capacity');
const { mountBrowserWalletApi } = require('./browser-wallet');

const primary = '02' + 'ab'.repeat(32);
const channel = (over = {}) => ({
	channelId: 'aa'.repeat(32), peerPubkey: primary, state: 'NORMAL', htlcUsable: true,
	localBalanceSats: 0, remoteBalanceSats: 200000, ...over
});

test('the most one eligible channel holds beyond the daemon margin', () => {
	const empty = channel({ channelId: '01'.repeat(32), remoteBalanceSats: 120000 });
	const larger = channel({ channelId: '02'.repeat(32), remoteBalanceSats: 300000 });
	assert.equal(offlineCapacity({ channels: [empty, larger], primary, concurrent: false }), 300000 - HEADROOM_SATS);
	// Each refusal the daemon makes takes a channel out.
	for (const [over, epochs, reserved] of [
		[{ peerPubkey: '03' + 'cd'.repeat(32) }],
		[{ state: 'AWAITING_REESTABLISH' }],
		[{ htlcUsable: false }],
		[{ localBalanceSats: 1 }],
		[{}, [{ role: 'R', channelId: larger.channelId, state: 'ACTIVE' }]],
		[{}, [], [larger.channelId]],
	]) assert.equal(offlineCapacity({ channels: [{ ...larger, ...over }], epochs, reservedChannelIds: reserved, primary, concurrent: false }), 0, JSON.stringify(over));
	// A closed receiving epoch, or a sending one, leaves the channel eligible.
	assert.equal(offlineCapacity({ channels: [larger], epochs: [{ role: 'R', channelId: larger.channelId, state: 'CLOSED' }, { role: 'S', channelId: larger.channelId, state: 'ACTIVE' }], primary }), 250000);
	// A funded channel counts only when the primary settles concurrently.
	const funded = channel({ localBalanceSats: 40000 });
	assert.equal(offlineCapacity({ channels: [funded], primary, concurrent: false }), 0);
	assert.equal(offlineCapacity({ channels: [funded], primary, concurrent: true }), 150000);
	// Less than the least an offline request takes is nothing.
	assert.equal(offlineCapacity({ channels: [channel({ remoteBalanceSats: HEADROOM_SATS + MINIMUM_SATS - 1 })], primary }), 0);
	assert.equal(offlineCapacity({ channels: [channel({ remoteBalanceSats: HEADROOM_SATS + MINIMUM_SATS })], primary }), MINIMUM_SATS);
});

function harness({ quote = async () => ({ mode: 'bolt11' }), channels = [channel()], held = false, supported = true } = {}) {
	const record = { id: 'w1', lfbw: { enabled: true, primaryPubkey: primary } };
	const calls = [];
	let time = 1000;
	const manager = {
		registry: { get: id => (id === 'w1' ? record : undefined) },
		offlineReceiveAvailable: () => supported,
		channelizeHeld: () => held,
		_daemonCall: async (_record, method, route) => {
			calls.push(route.split('?')[0]);
			if (route.startsWith('/receive/quote')) {
				assert.equal(route, `/receive/quote?peer=${primary}&amountSats=${MINIMUM_SATS}`);
				return quote();
			}
			if (route === '/channels') return channels;
			if (route === '/receive/status') return { reservedChannelIds: [] };
			if (route === '/ffor/epochs') return [];
			throw new Error(`unexpected ${method} ${route}`);
		}
	};
	const offline = createOfflineCapacity(manager, { now: () => time, wait: 50 });
	return { offline, calls, quotes: () => calls.filter(route => route === '/receive/quote').length, advance: ms => { time += ms; } };
}

test('the primary is asked once a minute whether it settles concurrently', async () => {
	const funded = channel({ channelId: '01'.repeat(32), localBalanceSats: 30000, remoteBalanceSats: 400000 });
	const empty = channel({ channelId: '02'.repeat(32), remoteBalanceSats: 100000 });
	let concurrent = false;
	const h = harness({ channels: [funded, empty], quote: async () => ({ mode: 'bolt11', ...(concurrent ? { concurrent: true, concurrentVersion: 2 } : {}) }) });
	assert.deepEqual(await h.offline('w1'), { maxSats: 50000 });
	concurrent = true;
	assert.deepEqual(await h.offline('w1'), { maxSats: 50000 });
	assert.equal(h.quotes(), 1);
	h.advance(60000);
	assert.deepEqual(await h.offline('w1'), { maxSats: 350000 });
	assert.equal(h.quotes(), 2);
});

test('a primary that cannot be asked gives no figure, and is asked again later', async () => {
	let fail = true;
	const h = harness({ quote: async () => { if (fail) throw Object.assign(new Error('Connect to your node'), { code: 'RECEIVE_UNAVAILABLE' }); return { mode: 'bolt11' }; } });
	assert.deepEqual(await h.offline('w1'), {});
	fail = false;
	h.advance(5000);
	assert.deepEqual(await h.offline('w1'), {});
	assert.equal(h.quotes(), 1);
	h.advance(15000);
	assert.deepEqual(await h.offline('w1'), { maxSats: 150000 });
});

test('a slow primary never holds up a refresh, and its answer is used once it comes', async () => {
	let answer;
	const h = harness({ quote: () => new Promise(resolve => { answer = resolve; }) });
	assert.deepEqual(await h.offline('w1'), {});
	// A refresh while the question is out asks nothing more.
	assert.deepEqual(await h.offline('w1'), {});
	assert.equal(h.quotes(), 1);
	answer({ mode: 'bolt11' });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(await h.offline('w1'), { maxSats: 150000 });
	assert.equal(h.quotes(), 1);
});

test('nothing a channel can hold is no figure above zero, and is checked again soon', async () => {
	const h = harness({ channels: [channel({ remoteBalanceSats: 20000 })], quote: async () => ({ mode: 'direct-funding' }) });
	assert.deepEqual(await h.offline('w1'), { maxSats: 0 });
	h.advance(15000);
	await h.offline('w1');
	assert.equal(h.quotes(), 2);
});

test('a wallet being emptied, or an engine without offline receive, can take nothing', async () => {
	for (const options of [{ held: true }, { supported: false }]) {
		const h = harness(options);
		assert.deepEqual(await h.offline('w1'), { maxSats: 0 });
		assert.deepEqual(h.calls, []);
	}
});

test('the host answers the route the wallet client reads', async t => {
	const manager = {
		registry: { get: id => (id === 'w1' ? { id: 'w1', lfbw: { enabled: true, primaryPubkey: primary } } : undefined) },
		paths: () => ({ base: '/nonexistent' }),
		offlineReceiveAvailable: () => true,
		_daemonCall: async (_record, _method, route) => route.startsWith('/receive/quote') ? { mode: 'bolt11' }
			: route === '/channels' ? [channel()] : route === '/receive/status' ? { reservedChannelIds: [] } : []
	};
	const app = express();
	mountBrowserWalletApi(app, manager);
	const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
	t.after(() => new Promise(resolve => server.close(resolve)));
	const reply = await fetch(`http://127.0.0.1:${server.address().port}/wallets/w1/api/receive/offline`).then(result => result.json());
	assert.deepEqual(reply, { ok: true, result: { maxSats: 150000 } });
});
