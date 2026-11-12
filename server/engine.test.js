'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The dashboard hides channel backup controls when the bundled engine
 * predates the feature; the version comes from the package the daemon
 * binary belongs to, found by walking up from BEIGNET_BIN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engineVersion, recoveryAvailable, lfbwAvailable, jitQuoteAvailable, recoveryAutoApplyAvailable,
	guardianHostingAvailable,
	guardianRotationAvailable,
	fforAvailable
} = require('./engine');

function fakeInstall(version) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-engine-'));
	const pkg = path.join(root, 'node_modules', 'beignet');
	fs.mkdirSync(path.join(pkg, 'dist', 'cli'), { recursive: true });
	fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'beignet', version }));
	// A nested manifest that is not beignet's must not be mistaken for it.
	fs.writeFileSync(path.join(pkg, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
	fs.writeFileSync(path.join(pkg, 'dist', 'cli', 'cli.js'), '');
	return { root, bin: path.join(pkg, 'dist', 'cli', 'cli.js') };
}

test('the version is read from the package the binary belongs to', () => {
	const { root, bin } = fakeInstall('0.9.2');
	try {
		assert.equal(engineVersion(bin), '0.9.2');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('no binary, or a binary outside any beignet package, is an unknown version', () => {
	assert.equal(engineVersion(undefined), null);
	assert.equal(engineVersion(''), null);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-engine-'));
	try {
		fs.writeFileSync(path.join(root, 'beignet'), '');
		assert.equal(engineVersion(path.join(root, 'beignet')), null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('recovery needs 0.9.1 or later', () => {
	assert.equal(recoveryAvailable('0.9.0'), false);
	assert.equal(recoveryAvailable('0.9.1'), true);
	assert.equal(recoveryAvailable('0.9.2'), true);
	assert.equal(recoveryAvailable('0.10.0'), true);
	assert.equal(recoveryAvailable('1.0.0'), true);
	assert.equal(recoveryAvailable(null), false);
	assert.equal(recoveryAvailable('garbage'), false);
});

// Lightning-first wallets need routes the engine gained after its last
// release; the only honest source is the OpenAPI module beside the binary.
test('lightning-first support is probed on the engine, not its version', () => {
	const { root, bin } = fakeInstall('0.9.3');
	try {
		assert.equal(lfbwAvailable(bin), false, 'no openapi module at all');
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/invoice/create': {}, '/jit/invoice': {} }");
		assert.equal(lfbwAvailable(bin), false, 'JIT alone is not the whole surface');
		fs.writeFileSync(
			openapi,
			"paths: { '/jit/invoice': {}, '/direct-funding/send': {} }, allowSplice: 'boolean?'"
		);
		assert.equal(lfbwAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(lfbwAvailable(undefined), false);
});

test('the JIT quote and the automatic checkpoint restore are probed the same way', () => {
	const { root, bin } = fakeInstall('0.10.0');
	try {
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/jit/invoice': {}, '/jit/status': {} }");
		assert.equal(jitQuoteAvailable(bin), false, '0.10.0 has status and invoice, no quote');
		fs.writeFileSync(openapi, "paths: { '/jit/invoice': {}, '/jit/status': {}, '/jit/quote': {} }");
		assert.equal(jitQuoteAvailable(bin), true);

		assert.equal(recoveryAutoApplyAvailable(bin), false, 'no config module at all');
		const config = path.join(path.dirname(bin), 'config.js');
		fs.writeFileSync(config, "env.BEIGNET_RECOVERY_MODE; env.BEIGNET_RECOVERY_GUARDIANS;");
		assert.equal(recoveryAutoApplyAvailable(bin), false);
		fs.writeFileSync(config, "env.BEIGNET_RECOVERY_MODE; env.BEIGNET_RECOVERY_AUTO_APPLY;");
		assert.equal(recoveryAutoApplyAvailable(bin), true);
		fs.writeFileSync(config, "env.BEIGNET_RECOVERY_MODE;");
		fs.writeFileSync(openapi, "description: 'BEIGNET_RECOVERY_AUTO_APPLY applies the newest capsule'");
		assert.equal(recoveryAutoApplyAvailable(bin), true, 'the OpenAPI module documenting the env is proof too');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(jitQuoteAvailable(undefined), false);
	assert.equal(recoveryAutoApplyAvailable(undefined), false);
});

test('guardian hosting is probed on the OpenAPI module (beignet #699)', () => {
	const { root, bin } = fakeInstall('0.11.0');
	try {
		assert.equal(guardianHostingAvailable(bin), false, 'no openapi module at all');
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/recovery/status': {}, '/guardian/status': {} }");
		assert.equal(guardianHostingAvailable(bin), false, 'the status route alone is not the whole surface');
		fs.writeFileSync(openapi, "paths: { '/guardian/status': {}, '/recovery/resolve-guardian': {} }");
		assert.equal(guardianHostingAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(guardianHostingAvailable(undefined), false);
});

test('guardian rotation is probed on the OpenAPI module (beignet #701)', () => {
	const { root, bin } = fakeInstall('0.12.0');
	try {
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/guardian/status': {}, '/recovery/resolve-guardian': {} }");
		assert.equal(guardianRotationAvailable(bin), false, '0.12.0 hosts guardians but cannot rotate');
		fs.writeFileSync(openapi, "paths: { '/recovery/resolve-guardian': {}, '/recovery/rotate-guardians': {} }");
		assert.equal(guardianRotationAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(guardianRotationAvailable(undefined), false);
});

test('FFOR needs the routes and the role wiring, which arrived in different releases (beignet #865)', () => {
	const { root, bin } = fakeInstall('0.21.3');
	try {
		const dir = path.dirname(bin);
		assert.equal(fforAvailable(bin), false, 'no openapi module at all');
		fs.writeFileSync(path.join(dir, 'openapi.js'), "paths: { '/ffor/epoch/start': {}, '/ffor/recover': {} }");
		assert.equal(fforAvailable(bin), false, '0.15.0 to 0.21.3: the routes exist but the role env is dropped');
		fs.writeFileSync(path.join(dir, 'daemon-options.js'), 'fforSettle: config.fforSettle,');
		assert.equal(fforAvailable(bin), true);
		fs.writeFileSync(path.join(dir, 'openapi.js'), "paths: { '/ffor/epoch/start': {} }");
		assert.equal(fforAvailable(bin), false, 'the start route alone is not the whole surface');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(fforAvailable(undefined), false);
});

test('automatic receive capability needs all daemon routes and funding configuration', () => {
	const { offlineReceiveAvailable } = require('./engine');
	const { root, bin } = fakeInstall('0.21.8');
	const dir = path.dirname(bin);
	try {
		fs.writeFileSync(path.join(dir, 'openapi.js'), "'/receive/status' '/receive/quote' '/receive/invoice'");
		assert.equal(offlineReceiveAvailable(bin), false);
		fs.writeFileSync(path.join(dir, 'config.js'), 'BEIGNET_FFOR_RECEIVE_FUNDING');
		assert.equal(offlineReceiveAvailable(bin), true);
		fs.writeFileSync(path.join(dir, 'openapi.js'), "'/receive/status'");
		assert.equal(offlineReceiveAvailable(bin), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the onion-only Tor proxy scope is read off the config module that parses it (beignet #963)', () => {
	const { torProxyScopeAvailable } = require('./engine');
	const { root, bin } = fakeInstall('0.22.0');
	const dir = path.dirname(bin);
	try {
		assert.equal(torProxyScopeAvailable(bin), false, 'no config module at all');
		fs.writeFileSync(path.join(dir, 'config.js'), 'torProxy: process.env.BEIGNET_TOR_PROXY');
		assert.equal(torProxyScopeAvailable(bin), false, '0.21.x parses the proxy but not the scope');
		fs.writeFileSync(path.join(dir, 'config.js'), "process.env.BEIGNET_TOR_PROXY_ONION_ONLY === 'true'");
		assert.equal(torProxyScopeAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(torProxyScopeAvailable(undefined), false);
});

/**
 * @number0/iroh beside a fake engine, the way npm lays it out: the loader
 * package and, when `target` is given, the one addon package for a platform.
 * `nested` puts them under the engine itself, as a global install does.
 */
function fakeIroh(root, { target, nested = false, addonFile = true } = {}) {
	const modules = nested ? path.join(root, 'node_modules', 'beignet', 'node_modules') : path.join(root, 'node_modules');
	const loader = path.join(modules, '@number0', 'iroh');
	fs.mkdirSync(loader, { recursive: true });
	fs.writeFileSync(path.join(loader, 'package.json'), JSON.stringify({ name: '@number0/iroh', version: '1.1.0', main: 'index.js' }));
	fs.writeFileSync(path.join(loader, 'index.js'), '');
	if (target) {
		const addon = path.join(modules, '@number0', `iroh-${target}`);
		fs.mkdirSync(addon, { recursive: true });
		fs.writeFileSync(path.join(addon, 'package.json'), JSON.stringify({ name: `@number0/iroh-${target}`, version: '1.1.0', main: `iroh.${target}.node` }));
		if (addonFile) fs.writeFileSync(path.join(addon, `iroh.${target}.node`), '');
	}
	return loader;
}

function irohEngine(bin) {
	fs.writeFileSync(path.join(path.dirname(bin), 'config.js'), 'BEIGNET_IROH');
	fs.writeFileSync(path.join(path.dirname(bin), 'iroh-config.js'), 'BEIGNET_IROH_RELAYS');
	fs.writeFileSync(path.join(path.dirname(bin), 'beignet-node.js'), 'listenIroh( irohUri');
}

const MAC_ARM = { platform: 'darwin', arch: 'arm64' };
const MAC_INTEL = { platform: 'darwin', arch: 'x64' };

test('the engine knows Iroh when its listener and configuration are both there', () => {
	const { irohEngineAvailable, irohAvailable } = require('./engine');
	const { root, bin } = fakeInstall('0.26.0');
	try {
		assert.equal(irohEngineAvailable(bin), false);
		fs.writeFileSync(path.join(path.dirname(bin), 'config.js'), 'BEIGNET_IROH');
		fs.writeFileSync(path.join(path.dirname(bin), 'iroh-config.js'), 'BEIGNET_IROH_RELAYS');
		assert.equal(irohEngineAvailable(bin), false);
		fs.writeFileSync(path.join(path.dirname(bin), 'beignet-node.js'), 'listenIroh( irohUri');
		assert.equal(irohEngineAvailable(bin), true);
		// The engine alone opens no Iroh connection: that takes its native module.
		assert.equal(irohAvailable(bin, MAC_ARM), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
	assert.equal(irohEngineAvailable(undefined), false);
});

test('Iroh takes the native module for this platform and architecture, which an Intel Mac has none of (issue #80)', () => {
	const { irohModuleAvailable, irohAvailable } = require('./engine');
	// Each state gets its own install: Node remembers a path it resolved.
	const state = (options, check) => {
		const { root, bin } = fakeInstall('0.38.1');
		try {
			irohEngine(bin);
			const loader = options === null ? null : fakeIroh(root, options);
			check(bin, loader);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	};

	state(null, (bin) => {
		assert.equal(irohModuleAvailable(bin, MAC_ARM), false, 'no @number0/iroh at all');
		assert.equal(irohAvailable(bin, MAC_ARM), false);
	});
	state({}, (bin) => assert.equal(irohModuleAvailable(bin, MAC_ARM), false, 'the loader without an addon'));
	// What an Apple Silicon build carries, and the same tree seen from an
	// Intel Mac, where npm installs no addon because none is published.
	state({ target: 'darwin-arm64' }, (bin) => {
		assert.equal(irohModuleAvailable(bin, MAC_ARM), true);
		assert.equal(irohAvailable(bin, MAC_ARM), true);
		assert.equal(irohModuleAvailable(bin, MAC_INTEL), false);
		assert.equal(irohAvailable(bin, MAC_INTEL), false);
		assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'arm64' }), false);
	});
	state({ target: 'darwin-universal' }, (bin) => assert.equal(irohModuleAvailable(bin, MAC_INTEL), true, 'a universal addon serves both'));
	state({ target: 'win32-x64-msvc' }, (bin) => {
		assert.equal(irohModuleAvailable(bin, { platform: 'win32', arch: 'x64' }), true);
		assert.equal(irohModuleAvailable(bin, { platform: 'win32', arch: 'arm64' }), false);
	});
	state({ target: 'linux-x64-gnu' }, (bin) => assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'x64' }), true));
	state({ target: 'linux-x64-musl' }, (bin) => assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'x64' }), true));
	// arm and arm64 are different targets, in both directions.
	state({ target: 'linux-arm64-gnu' }, (bin) => {
		assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'arm64' }), true);
		assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'arm' }), false);
	});
	state({ target: 'linux-arm-gnueabihf' }, (bin) => {
		assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'arm' }), true);
		assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'arm64' }), false);
	});
	// An addon package whose binary did not arrive is no module.
	state({ target: 'darwin-arm64', addonFile: false }, (bin) => assert.equal(irohModuleAvailable(bin, MAC_ARM), false));
	// A local build sits beside the loader instead of in a package of its own.
	state({}, (bin, loader) => {
		fs.writeFileSync(path.join(loader, 'iroh.darwin-x64.node'), '');
		assert.equal(irohModuleAvailable(bin, MAC_INTEL), true);
		assert.equal(irohModuleAvailable(bin, MAC_ARM), false);
	});
	// A global install keeps the packages under the engine itself.
	state({ target: 'linux-x64-gnu', nested: true }, (bin) => assert.equal(irohModuleAvailable(bin, { platform: 'linux', arch: 'x64' }), true));
	// The engine has to know Iroh as well.
	const { root, bin } = fakeInstall('0.20.0');
	try {
		fakeIroh(root, { target: 'darwin-arm64' });
		assert.equal(irohModuleAvailable(bin, MAC_ARM), true);
		assert.equal(irohAvailable(bin, MAC_ARM), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
	assert.equal(irohModuleAvailable(undefined), false);
});

test('a refusal names the computer the Iroh module is missing for', () => {
	const { irohModuleMissing } = require('./engine');
	assert.equal(irohModuleMissing(MAC_INTEL), 'This app has no Iroh module for this computer (macOS on x64)');
	assert.equal(irohModuleMissing({ platform: 'win32', arch: 'arm64' }), 'This app has no Iroh module for this computer (Windows on arm64)');
	assert.equal(irohModuleMissing({ platform: 'freebsd', arch: 'x64' }), 'This app has no Iroh module for this computer (freebsd on x64)');
});

test('Electrum certificate verification needs the env parser and the option wiring (beignet #1776)', () => {
	const { electrumTlsVerifyAvailable } = require('./engine');
	const { root, bin } = fakeInstall('0.31.0');
	const dir = path.dirname(bin);
	try {
		assert.equal(electrumTlsVerifyAvailable(bin), false, '0.30.2 has neither module');
		fs.writeFileSync(path.join(dir, 'electrum-tls-config.js'), 'process.env.BEIGNET_ELECTRUM_TLS_VERIFY process.env.BEIGNET_ELECTRUM_TLS_FINGERPRINTS');
		assert.equal(electrumTlsVerifyAvailable(bin), false, 'parsed but never handed to the node');
		fs.writeFileSync(path.join(dir, 'daemon-options.js'), 'electrumTlsVerify: config.electrumTlsVerify, electrumTlsFingerprints: config.electrumTlsFingerprints,');
		assert.equal(electrumTlsVerifyAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(electrumTlsVerifyAvailable(undefined), false);
});

test('ranked primaries and the channel send are probed on the daemon module (coreyphillips/beignet#1924)', () => {
	const { primariesAvailable, channelSendAvailable, PRIMARIES_ROUTE_MARKERS, CHANNEL_SEND_ROUTE_MARKERS } = require('./engine');
	const { root, bin } = fakeInstall('0.38.1');
	const dir = path.dirname(bin);
	try {
		assert.equal(primariesAvailable(bin), false, 'no daemon module at all');
		assert.equal(channelSendAvailable(bin), false);
		fs.writeFileSync(path.join(dir, 'daemon.js'), PRIMARIES_ROUTE_MARKERS.slice(0, -1).join(' '));
		assert.equal(primariesAvailable(bin), false, 'every route, not most of them');
		fs.writeFileSync(path.join(dir, 'daemon.js'), PRIMARIES_ROUTE_MARKERS.join(' '));
		assert.equal(primariesAvailable(bin), true);
		assert.equal(channelSendAvailable(bin), false, 'the two surfaces are probed apart');
		fs.writeFileSync(path.join(dir, 'daemon.js'), [...PRIMARIES_ROUTE_MARKERS, ...CHANNEL_SEND_ROUTE_MARKERS].join(' '));
		assert.equal(channelSendAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(primariesAvailable(undefined), false);
	assert.equal(channelSendAvailable(undefined), false);
});

