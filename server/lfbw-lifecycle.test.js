'use strict';

/**
 * Run with: npm test (from server/).
 *
 * What the record model refuses: a primary in use cannot be deleted, made
 * on-chain only, or stop providing liquidity; a lightning-first block is
 * validated on create and on edit; and the public record carries what the
 * dashboard needs to name siblings and advertise a reachable address.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

const PK_P = '03' + '22'.repeat(32);

function managerWith(records) {
	const m = Object.create(WalletManager.prototype);
	const store = { ...records };
	m.registry = {
		get: (id) => store[id],
		list: () => Object.values(store),
		upsert: (r) => {
			store[r.id] = r;
		},
		remove: (id) => {
			delete store[id];
		}
	};
	m.runtime = new Map();
	m.channelLogs = new Map();
	m.fallbackLogs = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.lfbwSupported = true;
	m.engineVersion = '0.10.0';
	m.settings = { get: () => ({ defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: [] }) };
	m.onion = null;
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	m._restartWallet = async () => {};
	m.stopWallet = async () => {};
	m.paths = () => ({ base: '/nonexistent' });
	return { m, store };
}

const primary = () => ({
	id: 'p1',
	name: 'Primary',
	network: 'regtest',
	port: 3901,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	liquidityProvider: true,
	nodeId: PK_P,
	recovery: { mode: 'off', guardians: [] }
});
const dependent = () => ({
	id: 'w1',
	name: 'Spending',
	network: 'regtest',
	port: 3902,
	electrum: { host: 'h', port: 1, tls: false },
	onchainOnly: false,
	recovery: { mode: 'off', guardians: [] },
	lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1', primaryUri: null, setup: 'ready' }
});

const refused = (p, code) => assert.rejects(p, (err) => err.code === code && err.statusCode === 409);

test('a primary in use cannot be deleted, and the refusal names its dependents', async () => {
	const { m } = managerWith({ p1: primary(), w1: dependent() });
	await assert.rejects(m.deleteWallet('p1'), (err) => {
		assert.equal(err.code, 'PRIMARY_IN_USE');
		assert.equal(err.statusCode, 409);
		assert.deepEqual(err.details, { dependents: [{ id: 'w1', name: 'Spending' }] });
		assert.match(err.message, /"Spending"/);
		return true;
	});
});

test('once its dependents are gone the primary can go too', async () => {
	const { m, store } = managerWith({ p1: primary(), w1: dependent() });
	await m.deleteWallet('w1');
	await m.deleteWallet('p1');
	assert.deepEqual(Object.keys(store), []);
});

test('a primary in use cannot be made on-chain only or stop providing liquidity', async () => {
	const { m } = managerWith({ p1: primary(), w1: dependent() });
	await refused(m.updateWallet('p1', { onchainOnly: true }), 'PRIMARY_IN_USE');
	await refused(m.updateWallet('p1', { liquidityProvider: false }), 'PRIMARY_IN_USE');
	// Other edits are fine.
	const out = await m.updateWallet('p1', { name: 'Hub', jit: { flatFeeSat: 50 } });
	assert.equal(out.name, 'Hub');
	assert.equal(out.jit.flatFeeSat, 50);
});

test('a wallet with no dependents may drop the provider role, and the env follows', async () => {
	const { m, store } = managerWith({ p1: primary() });
	await m.updateWallet('p1', { liquidityProvider: false });
	assert.equal(store.p1.liquidityProvider, false);
	const env = m._daemonEnv(store.p1, { home: '/h', data: '/d' }, 's', 't');
	assert.equal(env.BEIGNET_JIT_RECEIVE, undefined);
});

test('editing the client reserve policy persists it and restarts the provider with the new policy', async () => {
	const { m, store } = managerWith({ p1: primary() });
	let restarts = 0;
	m._restartWallet = async () => { restarts++; };
	m.runtimeState('p1').proc = { pid: 1 };
	const enabled = await m.updateWallet('p1', { jit: { waiveClientReserve: true } });
	assert.equal(enabled.jit.waiveClientReserve, true);
	assert.equal(store.p1.jit.waiveClientReserve, true);
	assert.equal(m._daemonEnv(store.p1, { home: '/h', data: '/d' }, 's', 't').BEIGNET_WAIVE_CLIENT_RESERVE, 'true');
	assert.equal(restarts, 1);
	await m.updateWallet('p1', { name: 'Hub' });
	assert.equal(store.p1.jit.waiveClientReserve, true);
	assert.equal(restarts, 2);
	await m.updateWallet('p1', { jit: { waiveClientReserve: false } });
	assert.equal(m.publicRecord('p1').jit.waiveClientReserve, false);
	assert.equal(m._daemonEnv(store.p1, { home: '/h', data: '/d' }, 's', 't').BEIGNET_WAIVE_CLIENT_RESERVE, 'false');
	assert.equal(restarts, 3);
	await assert.rejects(m.updateWallet('p1', { jit: { waiveClientReserve: 'true' } }), (err) => err.code === 'BAD_JIT');
	assert.equal(store.p1.jit.waiveClientReserve, false);
	assert.equal(restarts, 3);
});

test('an edit can make an ordinary wallet lightning-first, and an on-chain only one cannot be', async () => {
	const { m, store } = managerWith({ p1: primary(), w2: { ...dependent(), id: 'w2', lfbw: null } });
	const out = await m.updateWallet('w2', { lfbw: { enabled: true, primaryWalletId: 'p1' } });
	assert.equal(out.lfbw.mode, 'internal');
	assert.equal(out.lfbw.primaryPubkey, PK_P, 'the primary has reported its node id already');
	assert.equal(out.lfbw.setup, 'pending');
	await assert.rejects(
		m.updateWallet('w2', { onchainOnly: true, lfbw: { enabled: true, primaryWalletId: 'p1' } }),
		(err) => err.code === 'BAD_LFBW_PEER'
	);
	// Turning it off clears the block; the wallet keeps its channels.
	await m.updateWallet('w2', { lfbw: { enabled: false } });
	assert.equal(store.w2.lfbw, null);
	// Going on-chain only clears it too.
	await m.updateWallet('w2', { lfbw: { enabled: true, primaryWalletId: 'p1' } });
	await m.updateWallet('w2', { onchainOnly: true });
	assert.equal(store.w2.lfbw, null);
});

test('an edit that keeps the primary keeps the setup state; a bad primary leaves the record untouched', async () => {
	const { m, store } = managerWith({ p1: primary(), w1: dependent() });
	store.w1.lfbw.initialChannelOpened = true;
	await m.updateWallet('w1', { lfbw: { enabled: true, primaryWalletId: 'p1', trusted: false } });
	assert.equal(store.w1.lfbw.setup, 'ready');
	assert.equal(store.w1.lfbw.initialChannelOpened, true);
	assert.equal(store.w1.lfbw.trusted, false);
	await assert.rejects(
		m.updateWallet('w1', { name: 'Renamed', lfbw: { enabled: true, primaryWalletId: 'nope' } }),
		(err) => err.code === 'BAD_LFBW_PEER'
	);
	assert.equal(store.w1.name, 'Spending');
});

test('the public record names the node, the listen port, the reach, and who depends on whom', () => {
	const { m } = managerWith({ p1: primary(), w1: dependent() });
	const p = m.publicRecord('p1');
	assert.equal(p.nodeId, PK_P);
	assert.equal(p.listenPort, 3901 + 6000);
	assert.equal(p.reach, null, 'no onion, no PUBLIC_HOST: nothing to advertise');
	assert.equal(p.liquidityProvider, true);
	assert.deepEqual(p.jit, { waiveClientReserve: true, flatFeeSat: 0, feePpm: 0, maxClientFundingSats: 1000000, maxConcurrentFundings: 3, maxTotalFundingSats: null });
	assert.deepEqual(p.lfbwDependents, [{ id: 'w1', name: 'Spending' }]);
	const w = m.publicRecord('w1');
	assert.equal(w.lfbw.primaryWalletId, 'p1');
	assert.deepEqual(w.lfbwDependents, []);
	m.onionAddress = () => 'abcd.onion:9902';
	assert.deepEqual(m.publicRecord('w1').reach, { host: 'abcd.onion', port: 9902 });
});

test('an on-chain only wallet advertises no Lightning at all', () => {
	const { m } = managerWith({ p1: { ...primary(), onchainOnly: true } });
	const p = m.publicRecord('p1');
	assert.equal(p.listenPort, null);
	assert.equal(p.reach, null);
	assert.equal(p.liquidityProvider, false);
});

// The network mode (umbrel #193) on the record model: what the public record
// says, what an edit refuses, and what it writes.
test('the public record carries the mode, the public address and the port peers dial', () => {
	const { m, store } = managerWith({ p1: primary() });
	const p = m.publicRecord('p1');
	assert.equal(p.networkMode, 'hybrid', 'a record without the field is hybrid');
	assert.equal(p.publicHost, '');
	assert.equal(p.publicPort, 3901 + 6000, 'no published window: the listen port itself');
	assert.equal(p.publicAddress, null);
	assert.equal('tor' in p, false, 'the old flag is gone from the record');
	store.p1.networkMode = 'clearnet';
	store.p1.publicHost = '203.0.113.4';
	assert.equal(m.publicRecord('p1').publicAddress, null, 'not announced, not advertised');
	store.p1.announce = true;
	const announced = m.publicRecord('p1');
	assert.equal(announced.publicAddress, '203.0.113.4:9901');
	assert.deepEqual(announced.reach, { host: '203.0.113.4', port: 9901 }, 'and it is where payers are sent');
	store.p1.publicHost = '2001:db8::7';
	assert.equal(m.publicRecord('p1').publicAddress, '[2001:db8::7]:9901');
	store.p1.networkMode = 'tor';
	assert.equal(m.publicRecord('p1').publicAddress, null, 'a tor wallet announces no public address');
});

test('the public address beats the onion in reach when both are announced', () => {
	const { m, store } = managerWith({ p1: primary() });
	store.p1.networkMode = 'hybrid';
	store.p1.publicHost = '203.0.113.4';
	store.p1.announce = true;
	m.onionAddress = () => 'abcd.onion:9901';
	assert.deepEqual(m.publicRecord('p1').reach, { host: '203.0.113.4', port: 9901 });
	store.p1.publicHost = '';
	assert.deepEqual(m.publicRecord('p1').reach, { host: 'abcd.onion', port: 9901 }, 'hybrid with no address yet reaches on the onion');
});

test('an edit refuses a bad public address, and clearnet without one, leaving the record as it was', async () => {
	const { m, store } = managerWith({ p1: primary() });
	let restarts = 0;
	m._restartWallet = async () => {
		restarts++;
	};
	m.runtimeState('p1').proc = { pid: 1 };
	await assert.rejects(m.updateWallet('p1', { networkMode: 'hybrid', publicHost: 'bad host!' }), (err) => err.code === 'BAD_PUBLIC_HOST');
	await assert.rejects(m.updateWallet('p1', { networkMode: 'clearnet', publicHost: '' }), (err) => err.code === 'PUBLIC_HOST_REQUIRED');
	await assert.rejects(m.updateWallet('p1', { networkMode: 'onion' }), (err) => err.code === 'BAD_NETWORK_MODE');
	assert.equal(store.p1.networkMode, undefined, 'nothing written');
	assert.equal(store.p1.publicHost, undefined);
	assert.equal(restarts, 0, 'nothing restarted');
	await m.updateWallet('p1', { networkMode: 'clearnet', publicHost: ' Node.Example.com ' });
	assert.equal(store.p1.networkMode, 'clearnet');
	assert.equal(store.p1.publicHost, 'node.example.com', 'trimmed and lowercased');
	assert.equal(restarts, 1, 'the daemon comes up with the new announcement');
	await m.updateWallet('p1', { name: 'Still primary' });
	assert.equal(store.p1.networkMode, 'clearnet', 'an edit that says nothing about the network keeps it');
	assert.equal(store.p1.publicHost, 'node.example.com');
	await m.updateWallet('p1', { networkMode: 'clearnet', publicHost: '', onchainOnly: true });
	assert.equal(store.p1.publicHost, '', 'clearnet without an address is fine for a wallet that runs no Lightning');
});

test('an edit maps the legacy flag and drops it from the record', async () => {
	const { m, store } = managerWith({ p1: { ...primary(), tor: true } });
	assert.equal(m.publicRecord('p1').networkMode, 'tor');
	await m.updateWallet('p1', { name: 'Renamed' });
	assert.equal(store.p1.networkMode, 'tor', 'the mode the flag meant, now written');
	assert.equal('tor' in store.p1, false, 'the flag is gone');
	await m.updateWallet('p1', { tor: false });
	assert.equal(store.p1.networkMode, 'hybrid', 'a caller still sending the flag gets its meaning');
	await m.updateWallet('p1', { tor: true, networkMode: 'clearnet', publicHost: '203.0.113.4' });
	assert.equal(store.p1.networkMode, 'clearnet', 'the field wins over the flag');
});
