'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A server on another chain than the wallet is refused at save time, with the
 * reason, unless the user says to save anyway. Only a confirmed mismatch is
 * refused: a server that is down, slow, unverified or silent about its chain
 * is saved as before and waited for.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WalletManager } = require('./wallet-manager');
const { Settings } = require('./settings');

const result = (extra) => ({
	reachable: true,
	software: 'electrs/0.10.9',
	protocol: '1.4',
	chain: 'mainnet',
	genesisHash: null,
	height: 840000,
	certificate: null,
	error: null,
	probedAt: Date.now(),
	...extra
});

function bareManager(probe) {
	const m = Object.create(WalletManager.prototype);
	m.electrumTlsVerifySupported = true;
	m.probes = 0;
	m._probeForGuard = async (electrum) => {
		m.probes += 1;
		return typeof probe === 'function' ? probe(electrum) : probe;
	};
	return m;
}

const electrum = { host: '10.21.21.10', port: 50001, tls: false };
const wrongChain = (err) => err.code === 'ELECTRUM_WRONG_CHAIN' && err.statusCode === 400;

test('a confirmed mismatch is refused with the reason', async () => {
	const m = bareManager(result({ chain: 'testnet' }));
	await assert.rejects(m._refuseWrongChain(electrum, 'mainnet'), (err) => {
		assert.ok(wrongChain(err));
		assert.match(err.message, /serves testnet, but this wallet is on mainnet/);
		assert.deepEqual(err.details, { host: '10.21.21.10', port: 50001, chain: 'testnet', network: 'mainnet', software: 'electrs/0.10.9' });
		return true;
	});
	await assert.rejects(bareManager(result({ chain: 'testnet4' }))._refuseWrongChain(electrum, 'testnet'), wrongChain, 'testnet4 is not testnet');
	await assert.rejects(bareManager(result({ chain: 'mainnet' }))._refuseWrongChain(electrum, 'regtest'), wrongChain);
});

test('anything short of a confirmed mismatch passes', async () => {
	await bareManager(result({ chain: 'mainnet' }))._refuseWrongChain(electrum, 'mainnet');
	await bareManager(result({ reachable: false, chain: 'unknown', error: 'unreachable' }))._refuseWrongChain(electrum, 'mainnet');
	await bareManager(result({ chain: 'unknown', error: 'timeout' }))._refuseWrongChain(electrum, 'mainnet');
	await bareManager(result({ chain: 'unknown', error: 'tls-rejected' }))._refuseWrongChain(electrum, 'mainnet');
	await bareManager(result({ chain: 'unknown' }))._refuseWrongChain(electrum, 'mainnet');
	await bareManager(null)._refuseWrongChain(electrum, 'mainnet');
});

test('save anyway skips the probe altogether', async () => {
	const m = bareManager(result({ chain: 'testnet' }));
	await m._refuseWrongChain(electrum, 'mainnet', { allow: true });
	assert.equal(m.probes, 0);
	await assert.rejects(m._refuseWrongChain(electrum, 'mainnet', { allow: 'yes' }), wrongChain, 'only a real true is an override');
});

test('what counts as a changed server', () => {
	const m = bareManager(null);
	const a = { host: 'e.example', port: 50002, tls: true, tlsVerify: true, tlsFingerprints: ['ab'.repeat(32)] };
	assert.equal(m._electrumChanged(a, { ...a }), false);
	assert.equal(m._electrumChanged(a, { ...a, tlsFingerprints: [...a.tlsFingerprints] }), false);
	assert.equal(m._electrumChanged(a, { ...a, host: 'f.example' }), true);
	assert.equal(m._electrumChanged(a, { ...a, port: 50001 }), true);
	assert.equal(m._electrumChanged(a, { ...a, tls: false }), true);
	assert.equal(m._electrumChanged(a, { ...a, tlsVerify: undefined }), true);
	assert.equal(m._electrumChanged(a, { ...a, tlsFingerprints: ['cd'.repeat(32)] }), true);
	assert.equal(m._electrumChanged(a, null), true);
	assert.equal(m._electrumChanged({ host: 'e', port: 1, tls: false }, { host: 'e', port: 1, tls: false }), false);
});

test('the default server is held to the default network when either changes', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-chain-guard-'));
	const m = bareManager((e) => result({ chain: e.host.includes('testnet') ? 'testnet' : 'mainnet' }));
	m.settings = new Settings(path.join(dir, 'settings.json'), { defaultNetwork: 'mainnet', defaultElectrum: null });
	m.settings.load();
	const testnetServer = { host: 'testnet.example', port: 50001, tls: false };
	await assert.rejects(m.updateSettings({ defaultElectrum: testnetServer }), (err) => {
		assert.ok(wrongChain(err));
		assert.match(err.message, /serves testnet, but the default network is mainnet/, 'Settings has no wallet to speak of');
		return true;
	});
	assert.equal(m.defaultElectrum(), null, 'a refused server is not saved');
	const saved = await m.updateSettings({ defaultElectrum: testnetServer, allowChainMismatch: true });
	assert.equal(saved.defaultElectrum.host, 'testnet.example');
	const probes = m.probes;
	await m.updateSettings({ defaultElectrum: testnetServer });
	assert.equal(m.probes, probes, 'the same server again is not probed again');
	await m.updateSettings({ recoveryGuardians: [] });
	assert.equal(m.probes, probes, 'an unrelated setting does not probe');
	await m.updateSettings({ defaultNetwork: 'testnet' });
	assert.equal(m.probes, probes + 1, 'a new network holds the server to it');
	assert.equal(m.defaultNetwork(), 'testnet');
	await assert.rejects(m.updateSettings({ defaultNetwork: 'mainnet' }), wrongChain, 'back to mainnet with a testnet server');
	await m.updateSettings({ defaultElectrum: null, defaultNetwork: 'mainnet' });
	assert.equal(m.defaultElectrum(), null);
	await m.updateSettings({ defaultElectrum: { host: 'main.example', port: 50001, tls: false } });
	assert.equal(m.defaultElectrum().host, 'main.example');
});
