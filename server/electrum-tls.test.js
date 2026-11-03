'use strict';

/**
 * Run with: npm test (from server/).
 *
 * Electrum TLS certificate verification (beignet #1776): what the manager
 * stores for it, what it hands the daemon, and how its own tip probe treats a
 * certificate the daemon would refuse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { WalletManager } = require('./wallet-manager');
const { normalizeFingerprints, certificateAccepted, MAX_FINGERPRINTS } = require('./electrum-tls');

// The self-signed certificate the probe tests share (fixtures/electrum-test-cert.js).
const { KEY, CERT, OPENSSL_LINE, PIN } = require('./fixtures/electrum-test-cert');
const OTHER = 'ff'.repeat(32);

function bareManager(supported = true) {
	const m = Object.create(WalletManager.prototype);
	m.electrumTlsVerifySupported = supported;
	return m;
}
const PATHS = { home: '/tmp/x/home', data: '/tmp/x/data' };
const rec = (electrum) => ({
	id: 'w1',
	name: 'Test wallet',
	network: 'mainnet',
	electrum,
	networkMode: 'hybrid',
	announce: false,
	port: 3001
});

test('pins are read as openssl prints them, with or without colons, and a bad one is refused', () => {
	assert.deepEqual(normalizeFingerprints(OPENSSL_LINE), [PIN]);
	assert.deepEqual(normalizeFingerprints(PIN.toUpperCase()), [PIN]);
	assert.deepEqual(normalizeFingerprints(`${OPENSSL_LINE}, ${OTHER}\n${PIN}`), [PIN, OTHER], 'one per certificate, in order');
	assert.deepEqual(normalizeFingerprints([PIN, ' ', OTHER]), [PIN, OTHER]);
	assert.deepEqual(normalizeFingerprints(''), []);
	assert.deepEqual(normalizeFingerprints(undefined), []);
	assert.throws(() => normalizeFingerprints('AC:46:DD'), (err) => err.code === 'BAD_ELECTRUM' && err.statusCode === 400);
	assert.throws(() => normalizeFingerprints([PIN, 42]), (err) => err.code === 'BAD_ELECTRUM');
	const many = Array.from({ length: MAX_FINGERPRINTS + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
	assert.throws(() => normalizeFingerprints(many), /At most/);
});

test('a record keeps verification only for a TLS server, and only when it is on', () => {
	const m = bareManager();
	assert.deepEqual(m._normalizeElectrum({ host: 'e.example', port: '50002', tls: true }), { host: 'e.example', port: 50002, tls: true }, 'off reads as it always did');
	assert.deepEqual(m._normalizeElectrum({ host: 'e.example', port: 50002, tls: true, tlsVerify: true }), {
		host: 'e.example',
		port: 50002,
		tls: true,
		tlsVerify: true
	});
	assert.deepEqual(m._normalizeElectrum({ host: 'e.example', port: 50002, tls: true, tlsVerify: true, tlsFingerprints: OPENSSL_LINE }), {
		host: 'e.example',
		port: 50002,
		tls: true,
		tlsVerify: true,
		tlsFingerprints: [PIN]
	});
	assert.deepEqual(m._normalizeElectrum({ host: 'e.example', port: 50001, tls: false, tlsVerify: true, tlsFingerprints: PIN }), { host: 'e.example', port: 50001, tls: false }, 'plain TCP has no certificate');
	assert.deepEqual(m._normalizeElectrum({ host: 'e.example', port: 50002, tls: true, tlsVerify: false, tlsFingerprints: PIN }), { host: 'e.example', port: 50002, tls: true }, 'pins without verification are dropped, not passed to a daemon that would refuse them');
	assert.throws(() => m._normalizeElectrum({ host: 'e.example', port: 50002, tls: true, tlsVerify: true, tlsFingerprints: 'nope' }), (err) => err.code === 'BAD_ELECTRUM');
	assert.throws(() => bareManager(false)._normalizeElectrum({ host: 'e.example', port: 50002, tls: true, tlsVerify: true }), (err) => err.code === 'BAD_ELECTRUM' && /cannot verify/.test(err.message), 'an engine without it would silently not verify');
	assert.deepEqual(bareManager(false)._normalizeElectrum({ host: 'e.example', port: 50002, tls: true }), { host: 'e.example', port: 50002, tls: true });
});

test('the daemon is told to verify only when the record asks, and gets the pins with it', () => {
	const m = bareManager();
	const off = m._daemonEnv(rec({ host: 'e.example', port: 50002, tls: true }), PATHS, 's', 't');
	assert.equal(off.BEIGNET_ELECTRUM_TLS_VERIFY, undefined, 'off contributes nothing');
	assert.equal(off.BEIGNET_ELECTRUM_TLS_FINGERPRINTS, undefined);
	const on = m._daemonEnv(rec({ host: 'e.example', port: 50002, tls: true, tlsVerify: true }), PATHS, 's', 't');
	assert.equal(on.BEIGNET_ELECTRUM_TLS_VERIFY, 'true');
	assert.equal(on.BEIGNET_ELECTRUM_TLS_FINGERPRINTS, undefined);
	const pinned = m._daemonEnv(rec({ host: 'e.example', port: 50002, tls: true, tlsVerify: true, tlsFingerprints: [PIN, OTHER] }), PATHS, 's', 't');
	assert.equal(pinned.BEIGNET_ELECTRUM_TLS_VERIFY, 'true');
	assert.equal(pinned.BEIGNET_ELECTRUM_TLS_FINGERPRINTS, `${PIN},${OTHER}`);
	const tcp = m._daemonEnv(rec({ host: 'e.example', port: 50001, tls: false, tlsVerify: true }), PATHS, 's', 't');
	assert.equal(tcp.BEIGNET_ELECTRUM_TLS_VERIFY, undefined, 'a hand-edited record on plain TCP verifies nothing');
});

test('the rule for a socket: a CA-verified certificate, or a pinned one', () => {
	const socket = (authorized, fingerprint256) => ({ authorized, getPeerCertificate: () => ({ fingerprint256 }) });
	const colons = PIN.toUpperCase().match(/../g).join(':');
	assert.equal(certificateAccepted(socket(false, colons), { tls: true }), true, 'verification off takes anything');
	assert.equal(certificateAccepted(socket(true, colons), { tls: true, tlsVerify: true }), true);
	assert.equal(certificateAccepted(socket(false, colons), { tls: true, tlsVerify: true }), false);
	assert.equal(certificateAccepted(socket(false, colons), { tls: true, tlsVerify: true, tlsFingerprints: [PIN] }), true);
	assert.equal(certificateAccepted(socket(false, colons), { tls: true, tlsVerify: true, tlsFingerprints: [OTHER] }), false);
	assert.equal(certificateAccepted(socket(false, undefined), { tls: true, tlsVerify: true, tlsFingerprints: [PIN] }), false);
});

test("the manager's tip probe refuses a self-signed server the wallet verifies, unless it is pinned", async (t) => {
	const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
		socket.on('data', () => socket.write(`${JSON.stringify({ id: 1, result: { height: 840000, hex: '' } })}\n`));
		socket.on('error', () => {});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => server.close());
	const { port } = server.address();
	const m = bareManager();
	const at = (extra) => m._electrumTip({ host: '127.0.0.1', port, tls: true, ...extra });
	assert.equal(await at({}), 840000, 'unverified, as before');
	assert.equal(await at({ tlsVerify: true }), null, 'no CA signed it');
	assert.equal(await at({ tlsVerify: true, tlsFingerprints: [OTHER] }), null, 'pinned, but to another certificate');
	assert.equal(await at({ tlsVerify: true, tlsFingerprints: [PIN] }), 840000);
});
