'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The public Electrum servers the dashboard offers when no preset answers:
 * which are offered for which chain, and that each is one a wallet can hold
 * to its certificate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SUPPORTED_NETWORKS, ELECTRUM_PRESETS, PUBLIC_ELECTRUM_SERVERS, publicElectrumServers } = require('./config');

test('every public server is TLS with verification on, for chains this app runs', () => {
	const ids = new Set();
	for (const s of PUBLIC_ELECTRUM_SERVERS) {
		assert.ok(!ids.has(s.id), `${s.id} is listed once`);
		ids.add(s.id);
		assert.ok(!ELECTRUM_PRESETS.some((p) => p.id === s.id), `${s.id} is not also a preset id`);
		assert.equal(s.tls, true, `${s.id} is TLS: it is reached over the internet`);
		assert.equal(s.tlsVerify, true, `${s.id} turns certificate verification on`);
		assert.ok(Number.isInteger(s.port) && s.port > 0 && s.port <= 65535, `${s.id} has a port`);
		assert.ok(s.host && s.label && s.note, `${s.id} has a host, label and note`);
		assert.ok(Array.isArray(s.networks) && s.networks.length > 0, `${s.id} names its chains`);
		for (const n of s.networks) assert.ok(SUPPORTED_NETWORKS.includes(n), `${s.id}: ${n} is a chain this app runs`);
	}
});

test('a chain is offered only its own public servers', () => {
	for (const network of SUPPORTED_NETWORKS) {
		const servers = publicElectrumServers(network);
		assert.ok(servers.length > 0, `${network} has at least one`);
		for (const s of servers) assert.ok(s.networks.includes(network), `${s.id} serves ${network}`);
	}
	assert.deepEqual(
		publicElectrumServers('mainnet').map((s) => s.id),
		['public-bitkit', 'public-bluewallet', 'public-blockstream', 'public-acinq']
	);
});

test('a chain this app does not know is offered every public server', () => {
	assert.deepEqual(publicElectrumServers(null), PUBLIC_ELECTRUM_SERVERS);
	assert.deepEqual(publicElectrumServers('signet'), PUBLIC_ELECTRUM_SERVERS);
});
