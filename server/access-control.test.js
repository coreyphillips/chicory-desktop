'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The guard is given its lookups rather than asking the machine running the
 * tests, so each test sets up one kind of box: one where nothing resolves (a
 * developer's machine, or a DNS outage: the fail-open window), a legacy or
 * umbrelOS 1.x box with an app_proxy container, and an umbrelOS 2 box, where
 * umbreld's app gateway connects from the Docker bridge host and there is no
 * app_proxy at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.BEIGNET_TRUST_ALL;
delete process.env.APP_PROXY_HOST;
const { createAccessGuard, hostGateways } = require('./access-control');

const HOST = '10.21.0.1';
const PROXY = '10.21.0.7';
const OTHER_APP = '10.21.0.9';
const SELF = '10.21.0.5';

function fakeRes() {
	return {
		code: 0,
		body: null,
		status(c) {
			this.code = c;
			return this;
		},
		json(b) {
			this.body = b;
			return this;
		}
	};
}

/** Runs one request through the guard and settles on whichever way it went. */
function call(guard, ip) {
	return new Promise((resolve) => {
		const res = fakeRes();
		const json = res.json;
		res.json = (b) => {
			json.call(res, b);
			resolve({ passed: false, res });
			return res;
		};
		guard({ method: 'POST', url: '/export', socket: { remoteAddress: ip } }, res, () => resolve({ passed: true, res }));
	});
}

/** A Docker DNS that knows only the names in `names`, which a test may change. */
function dnsOf(names) {
	return async (host) => {
		if (!names[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
		return names[host];
	};
}

async function guardFor({ names = {}, gateways = [] } = {}) {
	const guard = createAccessGuard({ lookup: dnsOf(names), gateways: () => new Set(gateways) });
	await guard.ready;
	return guard;
}

test('an unresolved app_proxy leaves the dashboard open but not the backup routes', async () => {
	const guard = await guardFor();
	// The lockout safeguard: another app's IP still reaches the ordinary API.
	assert.equal((await call(guard, OTHER_APP)).passed, true);
	// The archive is every seed on the box, so it does not get that safeguard.
	const strict = await call(guard.strict, OTHER_APP);
	assert.equal(strict.passed, false);
	assert.equal(strict.res.code, 403);
	assert.equal(strict.res.body.error.code, 'FORBIDDEN');
	// Loopback is the manager talking to itself, and is always allowed.
	assert.equal((await call(guard.strict, '127.0.0.1')).passed, true);
	assert.equal((await call(guard.strict, '::ffff:127.0.0.1')).passed, true);
});

test('on umbrelOS 2 the app gateway on the host reaches every route and other apps reach none', async () => {
	const guard = await guardFor({ names: { 'chicory-wallet_manager_1': [SELF] }, gateways: [HOST] });
	// The recovery phrase and the backup, which were Forbidden here before.
	assert.equal((await call(guard.strict, HOST)).passed, true);
	assert.equal((await call(guard.strict, `::ffff:${HOST}`)).passed, true);
	assert.equal((await call(guard, HOST)).passed, true);
	// With no app_proxy to wait for, the ordinary API stops failing open.
	const other = await call(guard, OTHER_APP);
	assert.equal(other.passed, false);
	assert.equal(other.res.code, 403);
	assert.equal((await call(guard.strict, OTHER_APP)).passed, false);
});

test('a DNS outage is not taken for umbrelOS 2: the dashboard stays open until a name resolves', async () => {
	// The bridge host is known, but nothing resolves, not even this container.
	const guard = await guardFor({ gateways: [HOST] });
	assert.equal((await call(guard, OTHER_APP)).passed, true);
	assert.equal((await call(guard.strict, HOST)).passed, true);
	assert.equal((await call(guard.strict, OTHER_APP)).passed, false);
});

test('with app_proxy resolved, it and the host get in and other apps do not', async () => {
	const guard = await guardFor({
		names: { 'chicory-wallet_app_proxy_1': [PROXY], 'chicory-wallet_manager_1': [SELF] },
		gateways: [HOST]
	});
	assert.equal((await call(guard, PROXY)).passed, true);
	assert.equal((await call(guard.strict, PROXY)).passed, true);
	assert.equal((await call(guard.strict, HOST)).passed, true);
	assert.equal((await call(guard, OTHER_APP)).passed, false);
	assert.equal((await call(guard.strict, OTHER_APP)).passed, false);
});

test('an app_proxy that starts after the manager is let in on its first request', async () => {
	const names = { 'chicory-wallet_manager_1': [SELF] };
	const guard = await guardFor({ names, gateways: [HOST] });
	// The guard has settled on "no app_proxy here"; then the container comes up.
	names['chicory-wallet_app_proxy_1'] = [PROXY];
	assert.equal((await call(guard, PROXY)).passed, true);
	assert.equal((await call(guard.strict, PROXY)).passed, true);
	assert.equal((await call(guard, OTHER_APP)).passed, false);
});

test('the host is read from the default route in /proc/net/route', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-route-'));
	const file = path.join(dir, 'route');
	fs.writeFileSync(
		file,
		[
			'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
			'eth0\t00000000\t0100150A\t0003\t0\t0\t0\t00000000\t0\t0\t0',
			'eth0\t0000150A\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
			''
		].join('\n')
	);
	try {
		assert.deepEqual([...hostGateways(file)], ['10.21.0.1']);
		assert.deepEqual([...hostGateways(path.join(dir, 'missing'))], []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
