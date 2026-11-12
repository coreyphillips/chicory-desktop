'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The one contract that decides a wallet's Lightning posture, held without
 * spawning anything. On-chain only is real on the daemon side exactly insofar
 * as this environment says so: no BEIGNET_LISTEN_PORT (the daemon only starts
 * its Lightning listener when a port is configured) and
 * BEIGNET_AUTO_RECONNECT=false (or the daemon dials its channel partners back
 * and the channels quietly reestablish behind a dashboard that shows nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

// Prototype methods only: the constructor reads registry and settings files,
// none of which the env builder needs.
function bareManager() {
	return Object.create(WalletManager.prototype);
}

const PATHS = { home: '/tmp/x/home', data: '/tmp/x/data' };
const rec = (extra = {}) => ({
	id: 'w1',
	name: 'Test wallet',
	network: 'mainnet',
	electrum: { host: 'umbrel.local', port: 50001, tls: false },
	networkMode: 'hybrid',
	announce: false,
	port: 3001,
	...extra
});

test('a Lightning wallet listens, and is left to dial its peers', () => {
	const env = bareManager()._daemonEnv(rec(), PATHS, 'seed words', 'token');
	assert.equal(env.BEIGNET_LISTEN_PORT, String(3001 + 6000));
	assert.equal(env.BEIGNET_AUTO_RECONNECT, undefined);
});

test('desktop daemons receive required OS paths without the manager session capability', () => {
	const values = {
		SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
		TEMP: 'C:\\Temp', TMP: 'C:\\Temp', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD',
		DESKTOP_SESSION_TOKEN: 'private-desktop-capability'
	};
	const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
	Object.assign(process.env, values);
	try {
		const env = bareManager()._daemonEnv(rec(), PATHS, 'seed words', 'wallet-token');
		for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) assert.equal(env[key], values[key]);
		assert.equal(env.DESKTOP_SESSION_TOKEN, undefined);
		assert.equal(env.BEIGNET_API_TOKEN, 'wallet-token');
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test('an on-chain only wallet neither listens nor dials', () => {
	const env = bareManager()._daemonEnv(
		rec({ onchainOnly: true }),
		PATHS,
		'seed words',
		'token'
	);
	assert.equal(env.BEIGNET_LISTEN_PORT, undefined, 'no listener port, no listener');
	assert.equal(env.BEIGNET_AUTO_RECONNECT, 'false', 'and no dialing peers back');
	assert.equal(
		env.BEIGNET_ANNOUNCE_ADDRESSES,
		undefined,
		'nothing announced, there is nothing to reach'
	);
});

test('flipping the flag flips the whole posture, both directions', () => {
	const m = bareManager();
	const parked = m._daemonEnv(rec({ onchainOnly: true }), PATHS, 's', 't');
	const revived = m._daemonEnv(rec({ onchainOnly: false }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_LISTEN_PORT, undefined);
	assert.equal(revived.BEIGNET_LISTEN_PORT, String(9001));
	assert.equal(parked.BEIGNET_AUTO_RECONNECT, 'false');
	assert.equal(revived.BEIGNET_AUTO_RECONNECT, undefined);
});

// Channel backup (the Recovery Protocol, beignet 0.9.1+). The daemon refuses
// to start on a guardian list outside the guardian modes and on any profile
// but crash-v1, so the env is all or nothing per mode.
const G = [
	`${'a'.repeat(64)}@http://127.0.0.1:8101`,
	`${'b'.repeat(64)}@http://127.0.0.1:8102`,
	`${'c'.repeat(64)}@https://guardian.example`
];

test('a wallet without the field sends the env an older engine always saw', () => {
	const env = bareManager()._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(env.BEIGNET_RECOVERY_MODE, undefined);
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, undefined);
	assert.equal(env.BEIGNET_RECOVERY_PROFILE, undefined);
	const off = bareManager()._daemonEnv(rec({ recovery: { mode: 'off', guardians: [] } }), PATHS, 's', 't');
	assert.equal(off.BEIGNET_RECOVERY_MODE, undefined, 'off is the absence of the var');
});

test('peer storage sets the mode and nothing else', () => {
	const env = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'peer-storage', guardians: [] } }),
		PATHS,
		's',
		't'
	);
	assert.equal(env.BEIGNET_RECOVERY_MODE, 'peer-storage');
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, undefined, 'guardians outside a guardian mode refuse startup');
	assert.equal(env.BEIGNET_RECOVERY_PROFILE, undefined);
});

test('a guardian mode carries the pinned set in order and the crash-v1 profile', () => {
	const env = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'quorum', guardians: G } }),
		PATHS,
		's',
		't'
	);
	assert.equal(env.BEIGNET_RECOVERY_MODE, 'quorum');
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, G.join(','));
	assert.equal(env.BEIGNET_RECOVERY_PROFILE, 'crash-v1');
});

test('a parked quorum wallet still boots with its barrier', () => {
	// The journal of a wallet that promised quorum refuses to run without an
	// enforcing barrier, so on-chain only must not strip the recovery env.
	const env = bareManager()._daemonEnv(
		rec({ onchainOnly: true, recovery: { mode: 'quorum', guardians: G } }),
		PATHS,
		's',
		't'
	);
	assert.equal(env.BEIGNET_LISTEN_PORT, undefined);
	assert.equal(env.BEIGNET_RECOVERY_MODE, 'quorum');
	assert.equal(env.BEIGNET_RECOVERY_GUARDIANS, G.join(','));
});

// Lightning-first: a wallet that provides liquidity to lightning-first
// siblings runs the engine's JIT role and the direct-funding relay; the
// lightning-first wallet itself, and everyone else, sees nothing new.
test('only a liquidity provider gets the JIT role and the relay', () => {
	const m = bareManager();
	const plain = m._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(plain.BEIGNET_JIT_RECEIVE, undefined);
	assert.equal(plain.BEIGNET_DF_RELAY, undefined);
	const client = m._daemonEnv(
		rec({ lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1' } }),
		PATHS,
		's',
		't'
	);
	assert.equal(client.BEIGNET_JIT_RECEIVE, undefined, 'a lightning-first wallet is a client, not an LSP');
	assert.equal(client.BEIGNET_LISTEN_PORT, String(3001 + 6000), 'and it listens like any Lightning wallet');
	const provider = m._daemonEnv(
		rec({ liquidityProvider: true, jit: { flatFeeSat: 100, maxTotalFundingSats: 2000000 } }),
		PATHS,
		's',
		't'
	);
	assert.equal(provider.BEIGNET_JIT_RECEIVE, 'true');
	assert.equal(provider.BEIGNET_WAIVE_CLIENT_RESERVE, 'true');
	const waiving = m._daemonEnv(rec({ liquidityProvider: true, jit: { waiveClientReserve: true } }), PATHS, 's', 't');
	assert.equal(waiving.BEIGNET_WAIVE_CLIENT_RESERVE, 'true');
	assert.equal(client.BEIGNET_WAIVE_CLIENT_RESERVE, undefined);
	assert.equal(provider.BEIGNET_DF_RELAY, 'true');
	assert.equal(provider.BEIGNET_JIT_FLAT_FEE_SAT, '100');
	assert.equal(provider.BEIGNET_JIT_FEE_PPM, '0');
	assert.equal(provider.BEIGNET_JIT_MAX_CLIENT_FUNDING_SAT, '1000000');
	assert.equal(provider.BEIGNET_JIT_MAX_CONCURRENT_FUNDINGS, '3');
	assert.equal(provider.BEIGNET_JIT_MAX_TOTAL_FUNDING_SAT, '2000000');
	const parkedProvider = m._daemonEnv(rec({ liquidityProvider: true, onchainOnly: true }), PATHS, 's', 't');
	assert.equal(parkedProvider.BEIGNET_JIT_RECEIVE, undefined, 'an on-chain only wallet fronts nothing');
});

// Reverse swaps (beignet #737): off by default, and only a Lightning-running
// liquidity provider that switched them on runs the role.
test('only a liquidity provider that opted in serves reverse swaps', () => {
	const m = bareManager();
	const provider = m._daemonEnv(rec({ liquidityProvider: true }), PATHS, 's', 't');
	assert.equal(provider.BEIGNET_SWAPS, undefined, 'off until the operator switches it on');
	const serving = m._daemonEnv(
		rec({ liquidityProvider: true, swaps: { enabled: true, flatFeeSat: 250, maxSat: 200000, maxExposureSat: 400000 } }),
		PATHS,
		's',
		't'
	);
	assert.equal(serving.BEIGNET_SWAPS, 'true');
	assert.equal(serving.BEIGNET_SWAP_FLAT_FEE_SAT, '250');
	assert.equal(serving.BEIGNET_SWAP_FEE_PPM, '1000');
	assert.equal(serving.BEIGNET_SWAP_MIN_SAT, '10000');
	assert.equal(serving.BEIGNET_SWAP_MAX_SAT, '200000');
	assert.equal(serving.BEIGNET_SWAP_MAX_EXPOSURE_SAT, '400000');
	assert.equal(serving.BEIGNET_SWAP_MAX_CONCURRENT, '8');
	assert.equal(serving.BEIGNET_SWAP_SUBMARINE, undefined, 'the submarine direction is its own opt-in');
	// Umbrel #117: a provider that left the fee alone still charges for its
	// own refund transaction, which the engine's quote never prices.
	const untouched = m._daemonEnv(rec({ liquidityProvider: true, swaps: { enabled: true } }), PATHS, 's', 't');
	assert.ok(Number(untouched.BEIGNET_SWAP_FLAT_FEE_SAT) > 0, 'the default flat fee is not zero');
	assert.equal(untouched.BEIGNET_SWAP_FLAT_FEE_SAT, '500');
	assert.equal(serving.BEIGNET_SWAP_CLAIM_SAFETY_BLOCKS, undefined);
	assert.equal(serving.BEIGNET_SWAP_PAYMENT_MAX_FEE_PPM, undefined);
	const notProvider = m._daemonEnv(rec({ swaps: { enabled: true } }), PATHS, 's', 't');
	assert.equal(notProvider.BEIGNET_SWAPS, undefined, 'the role rides the liquidity provider switch');
	const parked = m._daemonEnv(rec({ liquidityProvider: true, onchainOnly: true, swaps: { enabled: true } }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_SWAPS, undefined, 'an on-chain only wallet has no Lightning side to swap');
});

// Submarine swaps (beignet #743): the second direction rides the swaps
// switch and adds only its own two margins, so a reverse-only provider's
// env is unchanged and a provider with swaps off serves neither.
test('the submarine direction is served only with swaps on, with its own margins', () => {
	const m = bareManager();
	const both = m._daemonEnv(
		rec({ liquidityProvider: true, swaps: { enabled: true, submarine: true, claimSafetyBlocks: 36, paymentMaxFeePpm: 2500 } }),
		PATHS,
		's',
		't'
	);
	assert.equal(both.BEIGNET_SWAPS, 'true');
	assert.equal(both.BEIGNET_SWAP_SUBMARINE, 'true');
	assert.equal(both.BEIGNET_SWAP_CLAIM_SAFETY_BLOCKS, '36');
	assert.equal(both.BEIGNET_SWAP_PAYMENT_MAX_FEE_PPM, '2500');
	assert.equal(both.BEIGNET_SWAP_FEE_PPM, '1000', 'the shared caps apply to both directions');
	const defaults = m._daemonEnv(rec({ liquidityProvider: true, swaps: { enabled: true, submarine: true } }), PATHS, 's', 't');
	assert.equal(defaults.BEIGNET_SWAP_CLAIM_SAFETY_BLOCKS, '24');
	assert.equal(defaults.BEIGNET_SWAP_PAYMENT_MAX_FEE_PPM, '5000');
	const swapsOff = m._daemonEnv(rec({ liquidityProvider: true, swaps: { enabled: false, submarine: true } }), PATHS, 's', 't');
	assert.equal(swapsOff.BEIGNET_SWAPS, undefined, 'submarine without swaps is nothing');
	assert.equal(swapsOff.BEIGNET_SWAP_SUBMARINE, undefined);
	const notProvider = m._daemonEnv(rec({ swaps: { enabled: true, submarine: true } }), PATHS, 's', 't');
	assert.equal(notProvider.BEIGNET_SWAP_SUBMARINE, undefined, 'the role rides the liquidity provider switch');
});

test('operator engine policy passes through from the manager env', () => {
	const prev = { ...process.env };
	process.env.BEIGNET_FEE_PPM = '250';
	process.env.BEIGNET_DF_MIN_AMOUNT = '';
	try {
		const env = bareManager()._daemonEnv(rec(), PATHS, 's', 't');
		assert.equal(env.BEIGNET_FEE_PPM, '250');
		assert.equal(env.BEIGNET_DF_MIN_AMOUNT, undefined, 'an empty value is not a policy');
	} finally {
		delete process.env.BEIGNET_FEE_PPM;
		delete process.env.BEIGNET_DF_MIN_AMOUNT;
		Object.assign(process.env, prev);
	}
});

test('the automatic checkpoint restore rides with peer storage only', () => {
	const on = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'peer-storage', guardians: [], autoApply: true } }),
		PATHS,
		's',
		't'
	);
	assert.equal(on.BEIGNET_RECOVERY_MODE, 'peer-storage');
	assert.equal(on.BEIGNET_RECOVERY_AUTO_APPLY, 'true');
	const off = bareManager()._daemonEnv(rec({ recovery: { mode: 'peer-storage', guardians: [] } }), PATHS, 's', 't');
	assert.equal(off.BEIGNET_RECOVERY_AUTO_APPLY, undefined, 'absent unless answered');
	const G = [`${'a'.repeat(64)}@http://127.0.0.1:8101`, `${'b'.repeat(64)}@http://127.0.0.1:8102`, `${'c'.repeat(64)}@https://g.example`];
	const quorum = bareManager()._daemonEnv(
		rec({ recovery: { mode: 'quorum', guardians: G, autoApply: true } }),
		PATHS,
		's',
		't'
	);
	assert.equal(quorum.BEIGNET_RECOVERY_AUTO_APPLY, undefined, 'the daemon refuses the flag under a guardian mode');
});

test('serving as a guardian rides the Lightning listener (beignet #699)', () => {
	const m = bareManager();
	const serving = m._daemonEnv(rec({ guardianServe: true }), PATHS, 's', 't');
	assert.equal(serving.BEIGNET_GUARDIAN_SERVE, 'true');
	assert.equal(serving.BEIGNET_LISTEN_PORT, String(3001 + 6000), 'a guardian is reached at the listen port');
	assert.equal(serving.BEIGNET_GUARDIAN_TOKEN, undefined, 'open by default: the pool needs strangers to register');
	const quiet = m._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(quiet.BEIGNET_GUARDIAN_SERVE, undefined, 'off contributes nothing an older engine would trip on');
	const parked = m._daemonEnv(rec({ guardianServe: true, onchainOnly: true }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_GUARDIAN_SERVE, undefined, 'no listener, no guardian');
});

test('settling offline receives rides the Lightning listener (FFOR, beignet #729)', () => {
	const m = bareManager();
	const settling = m._daemonEnv(rec({ ffor: { settle: { enabled: true, maxBudgetMsat: 5000000, feePpm: 100 } } }), PATHS, 's', 't');
	assert.equal(settling.BEIGNET_FFOR_SETTLE, 'true', 'the daemon reads exactly the string true');
	assert.equal(settling.BEIGNET_FFOR_MAX_BUDGET_MSAT, '5000000');
	assert.equal(settling.BEIGNET_FFOR_MAX_EPOCH_BLOCKS, undefined, 'an unset cap is not sent');
	assert.equal(settling.BEIGNET_FFOR_FEE_BASE_MSAT, '0');
	assert.equal(settling.BEIGNET_FFOR_FEE_PPM, '100');
	assert.equal(settling.BEIGNET_LISTEN_PORT, String(3001 + 6000));
	const quiet = m._daemonEnv(rec(), PATHS, 's', 't');
	assert.equal(quiet.BEIGNET_FFOR_SETTLE, undefined, 'off contributes nothing an older engine would trip on');
	const parked = m._daemonEnv(rec({ ffor: { settle: { enabled: true } }, onchainOnly: true }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_FFOR_SETTLE, undefined, 'no listener, no settlement');
});

test('witnessing and issuing ride the Lightning listener too, the issuer never without the witness', () => {
	const m = bareManager();
	const both = m._daemonEnv(rec({ ffor: { witness: { enabled: true, maxBytes: 4096 }, issuer: { enabled: true } } }), PATHS, 's', 't');
	assert.equal(both.BEIGNET_FFOR_WITNESS, 'true');
	assert.equal(both.BEIGNET_FFOR_WITNESS_MAX_BYTES, '4096');
	assert.equal(both.BEIGNET_FFOR_WITNESS_MAX_MAILBOXES, undefined);
	assert.equal(both.BEIGNET_FFOR_ISSUER, 'true');
	assert.equal(both.BEIGNET_FFOR_SETTLE, undefined);
	const parked = m._daemonEnv(rec({ ffor: { witness: { enabled: true }, issuer: { enabled: true } }, onchainOnly: true }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_FFOR_WITNESS, undefined);
	assert.equal(parked.BEIGNET_FFOR_ISSUER, undefined);
});

// The network mode (umbrel #193). Tor mode proxies every peer. Clearnet and
// Hybrid dial clearnet peers directly and keep the proxy for .onion peers,
// which is the engine's onion-only scope; an engine without it gets no proxy
// for those two modes, the direct dials they always made.
const { config } = require('./config');

function withTor(fn, { scope = true, proxy = 'chicory-wallet_tor_1:9050', publicPortBase = null } = {}) {
	const prev = { torProxy: config.torProxy, publicPortBase: config.publicPortBase };
	config.torProxy = proxy;
	config.publicPortBase = publicPortBase;
	const m = bareManager();
	m.torProxyScopeSupported = scope;
	try {
		return fn(m);
	} finally {
		Object.assign(config, prev);
	}
}

test('tor mode sends every peer through the app proxy and nothing else', () => {
	withTor((m) => {
		const env = m._daemonEnv(rec({ networkMode: 'tor' }), PATHS, 's', 't');
		assert.equal(env.BEIGNET_TOR_PROXY, 'chicory-wallet_tor_1:9050');
		assert.equal(env.BEIGNET_TOR_PROXY_ONION_ONLY, undefined, 'the scope is for the direct modes');
	});
});

test('clearnet and hybrid keep the proxy for onion peers only, when the engine can', () => {
	withTor((m) => {
		for (const networkMode of ['clearnet', 'hybrid']) {
			const env = m._daemonEnv(rec({ networkMode, publicHost: '203.0.113.4' }), PATHS, 's', 't');
			assert.equal(env.BEIGNET_TOR_PROXY, 'chicory-wallet_tor_1:9050', networkMode);
			assert.equal(env.BEIGNET_TOR_PROXY_ONION_ONLY, 'true', networkMode);
		}
	});
	withTor(
		(m) => {
			for (const networkMode of ['clearnet', 'hybrid']) {
				const env = m._daemonEnv(rec({ networkMode, publicHost: '203.0.113.4' }), PATHS, 's', 't');
				assert.equal(env.BEIGNET_TOR_PROXY, undefined, `${networkMode}: no scope, no proxy, the direct dials it always made`);
				assert.equal(env.BEIGNET_TOR_PROXY_ONION_ONLY, undefined, 'never the scope alone: the engine refuses to boot on it');
			}
			const tor = m._daemonEnv(rec({ networkMode: 'tor' }), PATHS, 's', 't');
			assert.equal(tor.BEIGNET_TOR_PROXY, 'chicory-wallet_tor_1:9050', 'tor mode never needed the scope');
		},
		{ scope: false }
	);
});

test('a record from before the mode existed reads by its old flag', () => {
	withTor((m) => {
		const on = m._daemonEnv(rec({ networkMode: undefined, tor: true }), PATHS, 's', 't');
		assert.equal(on.BEIGNET_TOR_PROXY, 'chicory-wallet_tor_1:9050');
		assert.equal(on.BEIGNET_TOR_PROXY_ONION_ONLY, undefined, 'Tor on was every peer over Tor, and still is');
		const off = m._daemonEnv(rec({ networkMode: undefined, tor: false }), PATHS, 's', 't');
		assert.equal(off.BEIGNET_TOR_PROXY, 'chicory-wallet_tor_1:9050', 'Tor off becomes hybrid: direct dials, with the proxy its onion peers never had');
		assert.equal(off.BEIGNET_TOR_PROXY_ONION_ONLY, 'true');
	});
});

test('an on-chain only wallet keeps the proxy for its onion guardians and announces nothing', () => {
	withTor((m) => {
		const env = m._daemonEnv(
			rec({ networkMode: 'hybrid', publicHost: '203.0.113.4', announce: true, onchainOnly: true }),
			PATHS,
			's',
			't'
		);
		assert.equal(env.BEIGNET_TOR_PROXY, 'chicory-wallet_tor_1:9050');
		assert.equal(env.BEIGNET_LISTEN_PORT, undefined);
		assert.equal(env.BEIGNET_ANNOUNCE_ADDRESSES, undefined);
	});
});

test('the announcement follows the mode: the onion, the public address at its published port, or both', () => {
	const onion = `${'o'.repeat(56)}.onion`;
	withTor(
		(m) => {
			m.onion = onion;
			const at = (extra) =>
				m._daemonEnv(rec({ port: 3102, announce: true, publicHost: '203.0.113.4', ...extra }), PATHS, 's', 't')
					.BEIGNET_ANNOUNCE_ADDRESSES;
			assert.equal(at({ networkMode: 'tor' }), `${onion}:9102`);
			assert.equal(at({ networkMode: 'clearnet' }), '203.0.113.4:19102', 'the host port, not the container port');
			assert.equal(at({ networkMode: 'hybrid' }), `${onion}:9102,203.0.113.4:19102`);
			assert.equal(at({ networkMode: 'hybrid', publicHost: '' }), `${onion}:9102`, 'hybrid with no address yet is the onion alone');
			assert.equal(at({ networkMode: 'hybrid', publicHost: '2001:db8::7' }), `${onion}:9102,[2001:db8::7]:19102`);
			assert.equal(at({ networkMode: 'hybrid', announce: false }), undefined, 'announcing off announces nothing');
			assert.equal(at({ networkMode: 'clearnet', port: 3131 }), undefined, 'the thirty-first wallet has no published port');
			assert.equal(at({ networkMode: 'hybrid', port: 3131 }), undefined, 'and the onion does not forward it either');
		},
		{ publicPortBase: 19101 }
	);
});

test('with no published window the listen port is the public port, as on a native run', () => {
	withTor((m) => {
		const env = m._daemonEnv(rec({ networkMode: 'clearnet', publicHost: '127.0.0.1', announce: true }), PATHS, 's', 't');
		assert.equal(env.BEIGNET_ANNOUNCE_ADDRESSES, '127.0.0.1:9001');
	});
});

test('Iroh is isolated per wallet, independent of network mode and never enabled for parked wallets', () => {
	const manager = bareManager();
	manager.irohSupported = true;
	for (const networkMode of ['tor', 'clearnet', 'hybrid']) {
		const enabled = rec({ networkMode, iroh: { enabled: true } });
		const env = manager._daemonEnv(enabled, PATHS, 'seed words', 'token');
		assert.equal(env.BEIGNET_IROH, 'true');
		assert.equal(env.BEIGNET_IROH_RELAYS, undefined);
		assert.equal(manager._daemonEnv({ ...enabled, onchainOnly: true }, PATHS, 'seed words', 'token').BEIGNET_IROH, undefined);
	}
	assert.equal(manager._daemonEnv(rec(), PATHS, 'seed words', 'token').BEIGNET_IROH, undefined);
	assert.equal(manager._daemonEnv(rec({ iroh: { enabled: true, relays: ['https://relay.example/'] } }), PATHS, 'seed words', 'token').BEIGNET_IROH_RELAYS, 'https://relay.example/');
	manager.irohSupported = false;
	assert.equal(manager._daemonEnv(rec({ iroh: { enabled: true } }), PATHS, 'seed words', 'token').BEIGNET_IROH, undefined);
});

test('a lightning-first wallet whose primary is an Iroh link gets the endpoint it dials by, as the phone runs it', () => {
	const manager = bareManager();
	manager.irohSupported = true;
	const pk = '02' + '33'.repeat(32);
	const lf = (primaryUri) => ({ enabled: true, mode: 'external', primaryWalletId: null, primaryUri, primaryPubkey: pk });
	const iroh = rec({ lfbw: lf(`${pk}@iroh:${'8e'.repeat(32)}?relay=${encodeURIComponent('https://use1-1.relay.n0.iroh.link./')}`) });
	const env = manager._daemonEnv(iroh, PATHS, 'seed words', 'token');
	assert.equal(env.BEIGNET_IROH, 'true');
	assert.equal(env.BEIGNET_IROH_DISCOVERY, 'false', 'nothing about the wallet is published');
	assert.equal(env.BEIGNET_IROH_RELAYS, undefined, 'the default relays, as on the phone');
	// The opt-in listener keeps its own settings when both apply.
	const both = manager._daemonEnv({ ...iroh, iroh: { enabled: true, relays: ['https://relay.example/'] } }, PATHS, 'seed words', 'token');
	assert.equal(both.BEIGNET_IROH_RELAYS, 'https://relay.example/');
	assert.equal(manager._daemonEnv(rec({ lfbw: lf(`${pk}@lsp.example:9735`) }), PATHS, 'seed words', 'token').BEIGNET_IROH, undefined, 'a TCP primary needs no Iroh');
	assert.equal(manager._daemonEnv({ ...iroh, lfbw: { ...iroh.lfbw, enabled: false } }, PATHS, 'seed words', 'token').BEIGNET_IROH, undefined);
	assert.equal(manager._daemonEnv({ ...iroh, onchainOnly: true }, PATHS, 'seed words', 'token').BEIGNET_IROH, undefined);
	// With no native module for this platform (issue #80) the engine still
	// needs Iroh on to dial the link: it then takes the onion fallback.
	manager.irohModuleSupported = false;
	assert.equal(manager._daemonEnv(iroh, PATHS, 'seed words', 'token').BEIGNET_IROH, 'true');
	manager.irohSupported = false;
	assert.equal(manager._daemonEnv(iroh, PATHS, 'seed words', 'token').BEIGNET_IROH, undefined);
});
