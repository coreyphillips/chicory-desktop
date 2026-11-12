'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The network mode rules (umbrel #193): which mode a record runs in, what a
 * public address may be, where a listen port answers on the host, what goes
 * in the node_announcement, and which proxy env each mode gets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const nm = require('./network-mode');

const rejects = (fn, code, re) => {
	assert.throws(fn, (err) => {
		assert.equal(err.code, code);
		assert.equal(err.statusCode, 400);
		if (re) assert.match(err.message, re);
		return true;
	});
};

test('a record without the field reads by its old Tor flag: on is tor, off or absent is hybrid', () => {
	assert.equal(nm.networkMode({ tor: true }), 'tor');
	assert.equal(nm.networkMode({ tor: false }), 'hybrid');
	assert.equal(nm.networkMode({}), 'hybrid');
	assert.equal(nm.networkMode({ networkMode: 'clearnet', tor: true }), 'clearnet', 'the field wins over the flag');
	assert.equal(nm.networkMode({ networkMode: 'onion' }), 'hybrid', 'junk falls back');
	assert.equal(nm.networkMode(undefined), 'hybrid');
});

test('a request names its mode by the field, else by the legacy flag, else keeps the fallback', () => {
	assert.equal(nm.requestedMode({ networkMode: 'tor' }, 'hybrid'), 'tor');
	assert.equal(nm.requestedMode({ networkMode: 'clearnet', tor: true }, 'hybrid'), 'clearnet');
	assert.equal(nm.requestedMode({ tor: true }, 'hybrid'), 'tor');
	assert.equal(nm.requestedMode({ tor: false }, 'tor'), 'hybrid');
	assert.equal(nm.requestedMode({}, 'clearnet'), 'clearnet');
	assert.equal(nm.requestedMode({ networkMode: 'nope' }, 'tor'), 'nope', 'validated later, not silently replaced');
});

test('the modes say what they use', () => {
	assert.deepEqual(nm.MODES.map((m) => [m, nm.usesOnion(m), nm.usesPublic(m)]), [
		['tor', true, false],
		['clearnet', false, true],
		['hybrid', true, true]
	]);
});

test('a public host is an IPv4, an IPv6 or a domain name, and nothing else', () => {
	assert.equal(nm.normalizePublicHost(''), '');
	assert.equal(nm.normalizePublicHost('   '), '');
	assert.equal(nm.normalizePublicHost(undefined), '');
	assert.equal(nm.normalizePublicHost(null), '');
	assert.equal(nm.normalizePublicHost(' 203.0.113.4 '), '203.0.113.4');
	assert.equal(nm.normalizePublicHost('Node.Example.COM'), 'node.example.com', 'names are lowercased like the engine does');
	assert.equal(nm.normalizePublicHost('my-node.dyndns.org'), 'my-node.dyndns.org');
	assert.equal(nm.normalizePublicHost('umbrel'), 'umbrel', 'a bare name is a name');
	assert.equal(nm.normalizePublicHost('2001:DB8::1'), '2001:db8::1', 'IPv6 is kept bare');
	assert.equal(nm.normalizePublicHost('[2001:db8::1]'), '2001:db8::1', 'brackets are taken off');
	rejects(() => nm.normalizePublicHost('300.1.1.1'), 'BAD_PUBLIC_HOST', /IPv4/);
	rejects(() => nm.normalizePublicHost('203.0.113.4:9735'), 'BAD_PUBLIC_HOST', /port is fixed/);
	rejects(() => nm.normalizePublicHost('node.example.com:19101'), 'BAD_PUBLIC_HOST', /port is fixed/);
	rejects(() => nm.normalizePublicHost('[2001:db8::1]:9735'), 'BAD_PUBLIC_HOST', /port is fixed/);
	rejects(() => nm.normalizePublicHost('[2001:db8::1'), 'BAD_PUBLIC_HOST', /closing bracket/);
	rejects(() => nm.normalizePublicHost('[node.example.com]'), 'BAD_PUBLIC_HOST', /not an IPv6/);
	rejects(() => nm.normalizePublicHost('https://node.example.com'), 'BAD_PUBLIC_HOST', /scheme/);
	rejects(() => nm.normalizePublicHost('node.example.com/'), 'BAD_PUBLIC_HOST', /path/);
	rejects(() => nm.normalizePublicHost('02abc@node.example.com'), 'BAD_PUBLIC_HOST', /node id/);
	rejects(() => nm.normalizePublicHost('bad host'), 'BAD_PUBLIC_HOST', /spaces/);
	rejects(() => nm.normalizePublicHost(`${'a'.repeat(56)}.onion`), 'BAD_PUBLIC_HOST', /published by the app/);
	rejects(() => nm.normalizePublicHost('-node.example.com'), 'BAD_PUBLIC_HOST', /IP address or a domain name/);
	rejects(() => nm.normalizePublicHost('node_example.com'), 'BAD_PUBLIC_HOST', /IP address or a domain name/);
	rejects(() => nm.normalizePublicHost(`${'a'.repeat(256)}`), 'BAD_PUBLIC_HOST', /IP address or a domain name/);
	rejects(() => nm.normalizePublicHost('a:b:c'), 'BAD_PUBLIC_HOST', /IP address or a domain name/);
});

test('IPv6 is held to the engine rule, narrower than Node: no zone id, no embedded IPv4, eight groups', () => {
	// What Node's net.isIPv6 accepts and the engine's expandIpv6 refuses would
	// fail the daemon's boot, so it is refused here first.
	for (const host of ['fe80::1%eth0', '::ffff:192.0.2.1', '2001:db8::192.0.2.1', '[fe80::1%eth0]', '[::ffff:192.0.2.1]']) {
		rejects(() => nm.normalizePublicHost(host), 'BAD_PUBLIC_HOST', /zone id or embedded IPv4/);
	}
	assert.equal(nm.normalizePublicHost('1:2:3:4:5:6:7:8'), '1:2:3:4:5:6:7:8');
	assert.equal(nm.normalizePublicHost('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:0db8:0000:0000:0000:0000:0000:0001');
	assert.equal(nm.normalizePublicHost('::1'), '::1');
	assert.equal(nm.isEngineIpv6('2001:db8::1'), true);
	assert.equal(nm.isEngineIpv6('2001:db8:::1'), false, 'a triple colon is two double colons');
	assert.equal(nm.isEngineIpv6('1:2:3:4:5:6:7'), false, 'seven groups');
	assert.equal(nm.isEngineIpv6('1:2:3:4:5:6:7:8:9'), false, 'nine groups');
	assert.equal(nm.isEngineIpv6('2001:db8::12345'), false, 'a five-digit group');
	assert.equal(nm.isEngineIpv6('1:2:3:4::5:6:7:8'), false, 'a :: that expands to nothing');
	assert.equal(nm.isEngineIpv6('node.example.com'), false);
});

test('a host meets a port in brackets when it is IPv6', () => {
	assert.equal(nm.hostForUri('203.0.113.4'), '203.0.113.4');
	assert.equal(nm.hostForUri('node.example.com'), 'node.example.com');
	assert.equal(nm.hostForUri('2001:db8::1'), '[2001:db8::1]');
});

test('the public port is the listen port shifted into the published window, and nothing past it', () => {
	const window = { windowStart: 9101, windowCount: 30, publishedBase: 19101 };
	assert.equal(nm.publicPort({ listenPort: 9101, ...window }), 19101);
	assert.equal(nm.publicPort({ listenPort: 9130, ...window }), 19130);
	assert.equal(nm.publicPort({ listenPort: 9131, ...window }), null, 'the thirty-first wallet is not published');
	assert.equal(nm.publicPort({ listenPort: 9100, ...window }), null);
	assert.equal(nm.publicPort({ listenPort: 9131, windowStart: 9101, windowCount: 30, publishedBase: null }), 9131, 'no base: the listen port is reachable itself');
	assert.equal(nm.publicPort({ listenPort: null, ...window }), null);
});

test('the announcement carries the onion, the public address or both by mode, and nothing without announce', () => {
	const base = { onion: 'x'.repeat(56) + '.onion', listenPort: 9101, onionMapped: true, publicHost: '203.0.113.4', publicPort: 19101, announce: true };
	assert.deepEqual(nm.announceList({ ...base, mode: 'tor' }), ['x'.repeat(56) + '.onion:9101']);
	assert.deepEqual(nm.announceList({ ...base, mode: 'clearnet' }), ['203.0.113.4:19101']);
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid' }), ['x'.repeat(56) + '.onion:9101', '203.0.113.4:19101']);
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', publicHost: '' }), ['x'.repeat(56) + '.onion:9101'], 'hybrid without a host is the onion alone');
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', onion: null }), ['203.0.113.4:19101'], 'no onion published yet');
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', onionMapped: false }), ['203.0.113.4:19101'], 'an onion that does not forward the port is not advertised');
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', publicPort: null }), ['x'.repeat(56) + '.onion:9101'], 'a host with no published port is not advertised');
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', publicHost: '2001:db8::1' }), ['x'.repeat(56) + '.onion:9101', '[2001:db8::1]:19101']);
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', announce: false }), []);
	assert.deepEqual(nm.announceList({ ...base, mode: 'hybrid', onchainOnly: true }), []);
	assert.deepEqual(nm.announceList({ ...base, mode: 'tor', publicHost: '', onion: null }), []);
});

test('tor mode gets the proxy alone, the direct modes the proxy with its onion-only scope, or nothing on an engine without it', () => {
	assert.deepEqual(nm.proxyEnv({ mode: 'tor', torProxy: 'tor:9050', scopeSupported: true }), { BEIGNET_TOR_PROXY: 'tor:9050' });
	assert.deepEqual(nm.proxyEnv({ mode: 'tor', torProxy: 'tor:9050', scopeSupported: false }), { BEIGNET_TOR_PROXY: 'tor:9050' });
	for (const mode of ['clearnet', 'hybrid']) {
		assert.deepEqual(nm.proxyEnv({ mode, torProxy: 'tor:9050', scopeSupported: true }), {
			BEIGNET_TOR_PROXY: 'tor:9050',
			BEIGNET_TOR_PROXY_ONION_ONLY: 'true'
		});
		assert.deepEqual(nm.proxyEnv({ mode, torProxy: 'tor:9050', scopeSupported: false }), {}, `${mode} without the scope dials as it always did`);
	}
	assert.deepEqual(nm.proxyEnv({ mode: 'hybrid', torProxy: '', scopeSupported: true }), {}, 'no proxy, no scope: the engine refuses the scope alone');
	assert.deepEqual(nm.proxyEnv({ mode: 'tor', torProxy: '' }), {});
});

test('clearnet needs a public address unless the wallet runs no Lightning; an unknown mode is refused', () => {
	assert.doesNotThrow(() => nm.validateNetworkChoice({ mode: 'tor', publicHost: '' }));
	assert.doesNotThrow(() => nm.validateNetworkChoice({ mode: 'hybrid', publicHost: '' }));
	assert.doesNotThrow(() => nm.validateNetworkChoice({ mode: 'clearnet', publicHost: '203.0.113.4' }));
	assert.doesNotThrow(() => nm.validateNetworkChoice({ mode: 'clearnet', publicHost: '', onchainOnly: true }));
	rejects(() => nm.validateNetworkChoice({ mode: 'clearnet', publicHost: '' }), 'PUBLIC_HOST_REQUIRED', /Hybrid/);
	rejects(() => nm.validateNetworkChoice({ mode: 'onion', publicHost: '' }), 'BAD_NETWORK_MODE');
	rejects(() => nm.validateNetworkChoice({ mode: undefined }), 'BAD_NETWORK_MODE');
});

test('Iroh defaults off, validates relay choices and retains settings on unrelated edits', () => {
	assert.deepEqual(nm.normalizeIroh(), { enabled: false });
	const existing = { enabled: true, relays: ['https://relay.example/'] };
	assert.deepEqual(nm.normalizeIroh(undefined, { existing, available: true }), existing);
	assert.deepEqual(nm.normalizeIroh({ enabled: true, relays: null }, { existing, available: true }), { enabled: true });
	assert.deepEqual(nm.normalizeIroh(undefined, { existing, onchainOnly: true }), { ...existing, enabled: false });
	assert.throws(() => nm.normalizeIroh({ enabled: true }), { code: 'IROH_UNSUPPORTED', message: 'The bundled engine does not support Iroh.' });
	// The engine knows Iroh and this computer has no native module for it (issue #80).
	assert.throws(() => nm.normalizeIroh({ enabled: true }, { available: false, engineAvailable: true }), { code: 'IROH_UNSUPPORTED', message: /^This app has no Iroh module for this computer \(.+ on .+\)\.$/ });
	assert.deepEqual(nm.normalizeIroh(undefined, { existing, available: false, engineAvailable: true }), existing, 'an edit of something else keeps the block');
	for (const relays of ['https://relay.example', ['ftp://relay.example'], ['https://user:pass@relay.example'], ['https://relay.example/?key=x'], ['https://relay.example/#x'], ['https://relay.example/,https://other.example']]) {
		assert.throws(() => nm.normalizeIroh({ enabled: true, relays }, { available: true }), { code: 'BAD_IROH' });
	}
	assert.throws(() => nm.normalizeIroh({ enabled: 'true' }), { code: 'BAD_IROH' });
});


test('empty relay lists use defaults and hidden relay input cannot prevent disabling', () => {
	assert.deepEqual(
		nm.normalizeIroh({ enabled: true, relays: [] }, { available: true }),
		{ enabled: true }
	);
	const existing = { enabled: true, relays: ['https://relay.example/'] };
	for (const onchainOnly of [false, true]) {
		assert.deepEqual(
			nm.normalizeIroh(
				{ enabled: onchainOnly, relays: ['invalid'] },
				{ onchainOnly, existing, available: true }
			),
			{ ...existing, enabled: false }
		);
	}
	assert.deepEqual(nm.irohEnv({ iroh: { enabled: true, relays: [] } }, true), {
		BEIGNET_IROH: 'true',
		BEIGNET_IROH_DISCOVERY: 'true'
	});
	assert.deepEqual(nm.irohEnv({ iroh: existing }, true), {
		BEIGNET_IROH: 'true',
		BEIGNET_IROH_DISCOVERY: 'false',
		BEIGNET_IROH_RELAYS: 'https://relay.example/'
	});
});
