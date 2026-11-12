'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The gate ahead of the daemon proxy for POST /primaries/add
 * (coreyphillips/beignet#1980): invisible on an engine that routes a Porch
 * link's dial, and a refusal before the engine holds the link on one that
 * would not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPorchGate } = require('./porch-gate');

const PK = '02' + 'ab'.repeat(32);
const PORCH = `${PK}@wss://relay.example/v1/p/${'a'.repeat(32)}`;

async function fixture(t, { available, daemon } = {}) {
	const seen = { proxied: [], daemon: [], synced: [], logs: [] };
	const manager = {
		porchPrimaryAvailable: () => available,
		registry: { get: (id) => (id === 'w1' ? { id: 'w1' } : null) },
		_daemonCall: async (rec, method, route, body) => {
			seen.daemon.push({ wallet: rec.id, method, route, body });
			if (daemon instanceof Error) throw daemon;
			return { primaries: [{ pubkey: body.pubkey }] };
		},
		syncPrimaries: async (id) => {
			seen.synced.push(id);
		},
		recordLog: (id, line) => seen.logs.push([id, line])
	};
	const app = express();
	app.post('/wallets/:id/api/primaries/add', createPorchGate(manager));
	// The proxy's stand-in: it must be handed the request with its body unread.
	app.use('/wallets/:id/api', (req, res) => {
		let raw = '';
		req.on('data', (chunk) => {
			raw += chunk;
		});
		req.on('end', () => {
			seen.proxied.push({ path: req.path, raw, parsed: req.body });
			res.json({ ok: true, result: 'proxied' });
		});
	});
	const server = await new Promise((resolve) => {
		const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
	});
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const post = async (body, id = 'w1', route = 'primaries/add') => {
		const response = await fetch(`http://127.0.0.1:${server.address().port}/wallets/${id}/api/${route}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		return { status: response.status, json: await response.json() };
	};
	return { seen, post };
}

test('on an engine that routes the dial the gate reads nothing: the proxy gets the request whole', async (t) => {
	const { seen, post } = await fixture(t, { available: true });
	const body = { pubkey: PK, uri: PORCH, rank: 2 };
	const out = await post(body);
	assert.deepEqual(out, { status: 200, json: { ok: true, result: 'proxied' } });
	assert.deepEqual(seen.proxied, [{ path: '/primaries/add', raw: JSON.stringify(body), parsed: undefined }]);
	assert.deepEqual(seen.daemon, []);
	assert.deepEqual(seen.synced, []);
});

test('on an engine that would dial the relay directly a Porch link is refused before the engine holds it', async (t) => {
	const { seen, post } = await fixture(t, { available: false });
	for (const uri of [PORCH, PORCH.replace('@wss://', '@WSS://'), ` ${PK}@ws://127.0.0.1:2114/v1/p/${'a'.repeat(32)}`]) {
		const out = await post({ pubkey: PK, uri });
		assert.equal(out.status, 400, uri);
		assert.deepEqual(out.json, {
			ok: false,
			error: { code: 'PORCH_UNSUPPORTED', message: 'The bundled engine does not support Porch links, so it cannot reach this primary node.' }
		});
	}
	assert.deepEqual(seen.daemon, [], 'the engine was never asked');
	assert.deepEqual(seen.proxied, []);
	assert.deepEqual(seen.synced, []);
});

test('on such an engine any other primary is still added, and the record follows it', async (t) => {
	const { seen, post } = await fixture(t, { available: false });
	const tcp = { pubkey: PK, host: 'lsp.example', port: 9735 };
	const out = await post(tcp);
	assert.deepEqual(out, { status: 200, json: { ok: true, result: { primaries: [{ pubkey: PK }] } } });
	assert.deepEqual(seen.daemon, [{ wallet: 'w1', method: 'POST', route: '/primaries/add', body: tcp }]);
	assert.deepEqual(seen.synced, ['w1']);
	assert.deepEqual(seen.proxied, [], 'a body that was read is not proxied');
	// An Iroh link is no Porch link.
	const iroh = { pubkey: PK, uri: `${PK}@iroh:${'8e'.repeat(32)}` };
	assert.equal((await post(iroh)).status, 200);
	assert.deepEqual(seen.daemon[1].body, iroh);
	// A wallet that does not exist, and the other routes, are not the gate's.
	assert.deepEqual(await post(tcp, 'nope'), { status: 404, json: { ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } } });
	assert.deepEqual((await post({ pubkey: PK }, 'w1', 'primaries/remove')).json, { ok: true, result: 'proxied' });
});

test('on such an engine the daemon\'s refusal of another primary keeps its code', async (t) => {
	const { seen, post } = await fixture(t, { available: false, daemon: Object.assign(new Error('already a primary'), { code: 'INVALID_PARAMS' }) });
	const out = await post({ pubkey: PK, host: 'lsp.example', port: 9735 });
	assert.deepEqual(out, { status: 400, json: { ok: false, error: { code: 'INVALID_PARAMS', message: 'already a primary' } } });
	assert.deepEqual(seen.synced, []);
});
