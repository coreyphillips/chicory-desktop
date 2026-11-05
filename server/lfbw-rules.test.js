'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The lightning-first rules, held without a registry or a daemon: who may
 * be a primary, what a liquidity provider's daemon runs with, what the
 * wallet arms as its direct-funding policy, where a payer can reach it, and
 * what channelize does with a given wallet state and quote.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lfbw = require('./lfbw');

const PK = '02' + 'ab'.repeat(32);
const PK2 = '03' + 'cd'.repeat(32);

const primaryRec = (extra = {}) => ({
	id: 'p1',
	name: 'Primary',
	network: 'regtest',
	nodeId: PK,
	onchainOnly: false,
	...extra
});

function normalize(input, extra = {}) {
	return lfbw.normalizeLfbw(input, {
		network: 'regtest',
		selfId: 'w1',
		available: true,
		getRecord: (id) => (id === 'p1' ? primaryRec() : extra.records && extra.records[id]),
		...extra
	});
}

test('parseNodeUri takes pubkey@host:port', () => {
	const parsed = lfbw.parseNodeUri(`${PK.toUpperCase()}@node.example:9735`);
	assert.deepEqual(parsed, { pubkey: PK, host: 'node.example', port: 9735, uri: `${PK}@node.example:9735` });
	assert.deepEqual(lfbw.parseNodeUri(`${PK}@[::1]:9735`), { pubkey: PK, host: '::1', port: 9735, uri: `${PK}@[::1]:9735` });
	for (const bad of ['', 'abc', `${PK}@host`, `${PK}@host:0`, `${PK}@host:70000`, `zz@host:9735`, `04${'ab'.repeat(32)}@host:9735`]) {
		assert.throws(() => lfbw.parseNodeUri(bad), /public key@host:port|between 1 and 65535/, bad);
	}
});

// The shape a phone pairs with: an Iroh endpoint id and the relay it sits
// on, here the public n0 relay with its fully qualified trailing dot.
const ENDPOINT = '8e'.repeat(32);
const RELAY = 'https://use1-1.relay.n0.iroh.link./';
const IROH_URI = `${PK2}@iroh:${ENDPOINT}?relay=${encodeURIComponent(RELAY)}`;
const ONION = 'a'.repeat(56) + '.onion';

test('parseNodeUri takes the Iroh link the phone accepts, relay and all', () => {
	assert.equal(IROH_URI, `${PK2}@iroh:${ENDPOINT}?relay=https%3A%2F%2Fuse1-1.relay.n0.iroh.link.%2F`);
	assert.deepEqual(lfbw.parseNodeUri(`  ${PK2.toUpperCase()}@IROH:${ENDPOINT.toUpperCase()}?relay=${encodeURIComponent(RELAY)}  `), {
		pubkey: PK2,
		host: ENDPOINT,
		port: 0,
		transport: { type: 'iroh', endpointId: ENDPOINT, relayUrl: RELAY },
		uri: IROH_URI
	});
	assert.deepEqual(lfbw.parseNodeUri(`${PK2}@iroh:${ENDPOINT}`), {
		pubkey: PK2,
		host: ENDPOINT,
		port: 0,
		transport: { type: 'iroh', endpointId: ENDPOINT },
		uri: `${PK2}@iroh:${ENDPOINT}`
	});
	assert.equal(
		lfbw.parseNodeUri(`${PK2}@iroh:r2hi5duor2hi5duor2hi5duor2hi5duor2hi5duor2hi5duor2ha`).uri,
		`${PK2}@iroh:${ENDPOINT}`,
		'a base32 endpoint id is the same endpoint in hex'
	);
	for (const bad of [
		`${PK2}@iroh:`,
		`${PK2}@iroh:${'8e'.repeat(31)}`,
		`${PK2}@iroh:${ENDPOINT}?relay=${encodeURIComponent(RELAY)}&relay=${encodeURIComponent(RELAY)}`,
		`${PK2}@iroh:${ENDPOINT}?via=${encodeURIComponent(RELAY)}`,
		`${PK2}@iroh:${ENDPOINT}?relay=${encodeURIComponent('ftp://relay.example/')}`,
		`${PK2}@iroh:${ENDPOINT}?relay=${encodeURIComponent('https://user:pw@relay.example/')}`
	]) {
		assert.throws(() => lfbw.parseNodeUri(bad), /Iroh|relay/i, bad);
	}
});

test('an Iroh primary may fall back to an onion for the same node key, and nothing else may', () => {
	const iroh = lfbw.parseNodeUri(IROH_URI);
	assert.equal(lfbw.parsePrimaryFallback(iroh, ''), undefined);
	assert.equal(lfbw.parsePrimaryFallback(iroh, null), undefined);
	assert.deepEqual(lfbw.parsePrimaryFallback(iroh, `${PK2}@${ONION}:9735`), {
		pubkey: PK2,
		host: ONION,
		port: 9735,
		uri: `${PK2}@${ONION}:9735`
	});
	for (const [primary, fallback] of [
		[iroh, `${PK}@${ONION}:9735`],
		[iroh, `${PK2}@lsp.example:9735`],
		[iroh, IROH_URI],
		[lfbw.parseNodeUri(`${PK2}@lsp.example:9735`), `${PK2}@${ONION}:9735`]
	]) {
		assert.throws(() => lfbw.parsePrimaryFallback(primary, fallback), /onion address for the same primary node key/, fallback);
	}
});

test('a wallet that is not lightning-first normalizes to null', () => {
	assert.equal(normalize(undefined), null);
	assert.equal(normalize({ enabled: false, primaryWalletId: 'p1' }), null);
});

test('an engine without the surface refuses, before anything else is checked', () => {
	assert.throws(
		() => normalize({ enabled: true, primaryWalletId: 'nope' }, { available: false }),
		(err) => err.status === 400 && err.code === 'LFBW_UNSUPPORTED'
	);
});

test('an internal primary is a sibling on the same network that runs Lightning and is not itself lightning-first', () => {
	const block = normalize({ enabled: true, primaryWalletId: 'p1', initialChannelSats: '250000' });
	assert.equal(block.mode, 'internal');
	assert.equal(block.primaryWalletId, 'p1');
	assert.equal(block.primaryPubkey, PK, 'the pubkey is known already when the primary has reported it');
	assert.equal(block.trusted, true, 'zero-conf both ways is the default for your own node');
	assert.equal(block.initialChannelSats, 250000);
	assert.equal(block.initialChannelOpened, false);
	assert.equal(block.setup, 'pending');

	const refused = (input, records) =>
		assert.throws(() => normalize(input, records ? { records } : {}), (err) => err.status === 400 && err.code === 'BAD_LFBW_PEER');
	refused({ enabled: true, primaryWalletId: 'missing' });
	refused({ enabled: true, primaryWalletId: 'w1' }, { w1: primaryRec({ id: 'w1' }) });
	refused({ enabled: true, primaryWalletId: 'x' }, { x: primaryRec({ id: 'x', network: 'mainnet' }) });
	refused({ enabled: true, primaryWalletId: 'x' }, { x: primaryRec({ id: 'x', onchainOnly: true }) });
	refused(
		{ enabled: true, primaryWalletId: 'x' },
		{ x: primaryRec({ id: 'x', lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1' } }) }
	);
});

test('trust can be switched off for an internal primary', () => {
	assert.equal(normalize({ enabled: true, primaryWalletId: 'p1', trusted: false }).trusted, false);
});

test('an external primary is a node URI, trusted for zero-conf unless declined, with no starting channel', () => {
	const block = normalize({ enabled: true, primaryUri: `${PK2}@lsp.example:9735`, initialChannelSats: 50000 });
	assert.equal(block.mode, 'external');
	assert.equal(block.primaryUri, `${PK2}@lsp.example:9735`);
	assert.equal(block.primaryPubkey, PK2);
	assert.equal(block.trusted, true, 'a JIT open from the primary is refused by a wallet that does not trust it');
	assert.equal(block.initialChannelSats, 0, 'a starting channel is opened FROM the primary, which we do not command');
	assert.equal(normalize({ enabled: true, primaryUri: `${PK2}@lsp.example:9735`, trusted: false }).trusted, false);
	assert.throws(
		() => normalize({ enabled: true, primaryUri: 'garbage' }),
		(err) => err.code === 'BAD_LFBW_PEER' && /public key@host:port/.test(err.message)
	);
});

test('an external Iroh primary is stored with its onion fallback, and refused by an engine without Iroh', () => {
	const block = normalize({ enabled: true, primaryUri: IROH_URI }, { irohAvailable: true });
	assert.equal(block.mode, 'external');
	assert.equal(block.primaryUri, IROH_URI);
	assert.equal(block.primaryPubkey, PK2);
	assert.equal(block.primaryFallbackUri, null);
	assert.equal(lfbw.isIrohPrimary(block), true);
	assert.equal(lfbw.isIrohPrimary(normalize({ enabled: true, primaryUri: `${PK2}@lsp.example:9735` })), false);
	assert.equal(lfbw.isIrohPrimary(normalize({ enabled: true, primaryWalletId: 'p1' })), false);

	const withFallback = normalize(
		{ enabled: true, primaryUri: IROH_URI, primaryFallbackUri: `${PK2}@${ONION}:9735` },
		{ irohAvailable: true }
	);
	assert.equal(withFallback.primaryFallbackUri, `${PK2}@${ONION}:9735`);
	// An edit naming the same primary and no fallback keeps the stored one;
	// null clears it, and a different primary does not inherit it.
	const kept = normalize({ enabled: true, primaryUri: IROH_URI, trusted: false }, { irohAvailable: true, existing: withFallback });
	assert.equal(kept.primaryFallbackUri, `${PK2}@${ONION}:9735`);
	const cleared = normalize(
		{ enabled: true, primaryUri: IROH_URI, primaryFallbackUri: null },
		{ irohAvailable: true, existing: withFallback }
	);
	assert.equal(cleared.primaryFallbackUri, null);
	const moved = normalize(
		{ enabled: true, primaryUri: `${PK2}@iroh:${'9f'.repeat(32)}` },
		{ irohAvailable: true, existing: withFallback }
	);
	assert.equal(moved.primaryFallbackUri, null);

	const refused = (input, extra) =>
		assert.throws(() => normalize(input, extra), (err) => err.status === 400 && err.code === 'BAD_LFBW_PEER');
	refused({ enabled: true, primaryUri: IROH_URI, primaryFallbackUri: `${PK}@${ONION}:9735` }, { irohAvailable: true });
	refused({ enabled: true, primaryUri: `${PK2}@lsp.example:9735`, primaryFallbackUri: `${PK2}@${ONION}:9735` }, { irohAvailable: true });
	assert.throws(
		() => normalize({ enabled: true, primaryUri: IROH_URI }, { irohAvailable: false }),
		(err) => err.status === 400 && err.code === 'IROH_UNSUPPORTED'
	);
	assert.equal(
		normalize({ enabled: true, primaryUri: `${PK2}@lsp.example:9735` }, { irohAvailable: false }).primaryUri,
		`${PK2}@lsp.example:9735`,
		'a TCP primary needs no Iroh'
	);
});

test('re-normalizing against the same primary keeps setup state; a new primary starts over', () => {
	const existing = {
		enabled: true,
		mode: 'internal',
		primaryWalletId: 'p1',
		primaryUri: null,
		initialChannelOpened: true,
		setup: 'ready',
		setupError: null,
		setupAt: '2026-09-01T00:00:00.000Z'
	};
	const same = normalize({ enabled: true, primaryWalletId: 'p1', trusted: false }, { existing });
	assert.equal(same.initialChannelOpened, true, 'a first open must never run twice');
	assert.equal(same.setup, 'ready');
	assert.equal(same.trusted, false, 'while the edited field takes');
	const moved = normalize({ enabled: true, primaryUri: `${PK2}@lsp.example:9735` }, { existing });
	assert.equal(moved.initialChannelOpened, false);
	assert.equal(moved.setup, 'pending');
});

test('dependentsOf finds the lightning-first wallets whose internal primary a wallet is', () => {
	const records = [
		primaryRec(),
		{ id: 'a', lfbw: { enabled: true, mode: 'internal', primaryWalletId: 'p1' } },
		{ id: 'b', lfbw: { enabled: true, mode: 'external', primaryUri: 'x', primaryWalletId: null } },
		{ id: 'c', lfbw: { enabled: false, mode: 'internal', primaryWalletId: 'p1' } },
		{ id: 'd', lfbw: null }
	];
	assert.deepEqual(
		lfbw.dependentsOf(primaryRec(), records).map((r) => r.id),
		['a']
	);
	assert.deepEqual(lfbw.dependentsOf({ id: 'a' }, records), []);
});

test('normalizeSwaps fills defaults, validates whole numbers and keeps the caps consistent', () => {
	assert.deepEqual(lfbw.normalizeSwaps(undefined), { ...lfbw.SWAP_DEFAULTS });
	// Umbrel #117: the engine's quote never prices the provider's refund
	// transaction, so a zero flat fee subsidises every small swap.
	assert.ok(lfbw.SWAP_DEFAULTS.flatFeeSat > 0, 'the default flat fee covers the refund transaction');
	assert.equal(lfbw.SWAP_DEFAULTS.flatFeeSat, 500);
	assert.equal(lfbw.normalizeSwaps({ enabled: true }).flatFeeSat, 500);
	const edited = lfbw.normalizeSwaps({ enabled: true, flatFeeSat: '250', maxSat: 200000 }, { feePpm: 500 });
	assert.equal(edited.enabled, true);
	assert.equal(edited.flatFeeSat, 250);
	assert.equal(edited.feePpm, 500);
	assert.equal(edited.maxSat, 200000);
	assert.throws(() => lfbw.normalizeSwaps({ flatFeeSat: '1.5' }), /whole number/);
	assert.throws(() => lfbw.normalizeSwaps({ maxConcurrent: 0 }), /between/);
	assert.throws(() => lfbw.normalizeSwaps({ minSat: 5000, maxSat: 4000 }), /minSat/);
	assert.throws(() => lfbw.normalizeSwaps({ maxSat: 6000000 }), /maxExposureSat/);
	assert.throws(() => lfbw.normalizeSwaps('yes'), /object/);
	// The submarine direction (beignet #743): off by default, a boolean of
	// its own, with its two margins bounded like the rest.
	assert.equal(lfbw.SWAP_DEFAULTS.submarine, false);
	const sub = lfbw.normalizeSwaps({ submarine: 1, claimSafetyBlocks: '36', paymentMaxFeePpm: 0 }, edited);
	assert.equal(sub.submarine, true);
	assert.equal(sub.claimSafetyBlocks, 36);
	assert.equal(sub.paymentMaxFeePpm, 0);
	assert.equal(sub.enabled, true, 'the rest of the block is kept');
	assert.equal(lfbw.normalizeSwaps({ submarine: false }, sub).submarine, false);
	assert.throws(() => lfbw.normalizeSwaps({ claimSafetyBlocks: 0 }), /between 1 and 2016/);
	assert.throws(() => lfbw.normalizeSwaps({ paymentMaxFeePpm: 1000001 }), /between/);
	assert.throws(() => lfbw.normalizeSwaps({ claimSafetyBlocks: '2.5' }), /whole number/);
});

test('normalizeJit fills defaults, validates whole numbers, and lets the lifetime budget be unset', () => {
	assert.deepEqual(lfbw.normalizeJit(undefined), { ...lfbw.JIT_DEFAULTS });
	const edited = lfbw.normalizeJit({ flatFeeSat: '100', maxConcurrentFundings: 1, maxTotalFundingSats: '' }, { feePpm: 500 });
	assert.deepEqual(edited, {
		waiveClientReserve: true,
		flatFeeSat: 100,
		feePpm: 500,
		maxClientFundingSats: 1000000,
		maxConcurrentFundings: 1,
		maxTotalFundingSats: null
	});
	for (const bad of [{ flatFeeSat: 1.5 }, { feePpm: 2000000 }, { maxConcurrentFundings: -1 }, { maxClientFundingSats: 'lots' }, { flatFeeSat: null }]) {
		assert.throws(() => lfbw.normalizeJit(bad), (err) => err.status === 400 && err.code === 'BAD_JIT', JSON.stringify(bad));
	}
});

test('only a liquidity provider runs the JIT role and the relay, with its caps written out', () => {
	assert.deepEqual(lfbw.providerEnv({ liquidityProvider: false }), {});
	assert.deepEqual(lfbw.providerEnv({ lfbw: { enabled: true } }), {});
	assert.deepEqual(lfbw.providerEnv({ liquidityProvider: true, onchainOnly: true }), {}, 'an on-chain only wallet fronts nothing');
	assert.deepEqual(lfbw.providerEnv({ liquidityProvider: true }), {
		BEIGNET_JIT_RECEIVE: 'true',
		BEIGNET_WAIVE_CLIENT_RESERVE: 'true',
		BEIGNET_JIT_FLAT_FEE_SAT: '0',
		BEIGNET_JIT_FEE_PPM: '0',
		BEIGNET_JIT_MAX_CLIENT_FUNDING_SAT: '1000000',
		BEIGNET_JIT_MAX_CONCURRENT_FUNDINGS: '3',
		BEIGNET_DF_RELAY: 'true'
	});
	const budgeted = lfbw.providerEnv({
		liquidityProvider: true,
		jit: { flatFeeSat: 250, feePpm: 1500, maxTotalFundingSats: 5000000 }
	});
	assert.equal(budgeted.BEIGNET_JIT_FLAT_FEE_SAT, '250');
	assert.equal(budgeted.BEIGNET_JIT_FEE_PPM, '1500');
	assert.equal(budgeted.BEIGNET_JIT_MAX_TOTAL_FUNDING_SAT, '5000000');
});

test('client reserve waiver accepts only booleans and follows provider role changes', () => {
	const on = lfbw.normalizeJit({ waiveClientReserve: true });
	assert.equal(on.waiveClientReserve, true);
	assert.equal(lfbw.normalizeJit({ feePpm: 5 }, on).waiveClientReserve, true);
	assert.equal(lfbw.normalizeJit({ waiveClientReserve: false }, on).waiveClientReserve, false);
	for (const value of ['true', 'false', 1, 0, null, {}]) {
		assert.throws(() => lfbw.normalizeJit({ waiveClientReserve: value }), (error) => error.code === 'BAD_JIT');
	}
	assert.equal(lfbw.normalizeJit(undefined, { waiveClientReserve: 'false' }).waiveClientReserve, false);
	const provider = { liquidityProvider: true, jit: on };
	assert.equal(lfbw.providerEnv(provider).BEIGNET_WAIVE_CLIENT_RESERVE, 'true');
	assert.equal(lfbw.providerRoleChanged(lfbw.providerEnv(provider), { ...provider, jit: { waiveClientReserve: false } }), true);
	assert.equal(lfbw.providerEnv({ ...provider, liquidityProvider: false }).BEIGNET_WAIVE_CLIENT_RESERVE, undefined);
});

test('operator policy passes through from the manager env only when set', () => {
	assert.deepEqual(lfbw.operatorEnv({}), {});
	assert.deepEqual(lfbw.operatorEnv({ BEIGNET_FEE_PPM: '100', BEIGNET_LEASE_RATES: '', BEIGNET_OTHER: 'x' }), {
		BEIGNET_FEE_PPM: '100'
	});
});

test('providerRoleChanged compares what a running daemon was spawned with against what the record wants', () => {
	const provider = { liquidityProvider: true };
	assert.equal(lfbw.providerRoleChanged({}, provider), true, 'spawned plain, now a provider');
	assert.equal(lfbw.providerRoleChanged(lfbw.providerEnv(provider), provider), false);
	assert.equal(lfbw.providerRoleChanged(lfbw.providerEnv(provider), { liquidityProvider: false }), true, 'role dropped');
	assert.equal(
		lfbw.providerRoleChanged(lfbw.providerEnv(provider), { liquidityProvider: true, jit: { flatFeeSat: 5 } }),
		true,
		'a fee edit'
	);
	assert.equal(lfbw.providerRoleChanged({ BEIGNET_NETWORK: 'regtest' }, { liquidityProvider: false }), false);
});

test('the direct-funding policy names the primary as liquidity peer and relay, splice on, zero-conf only when trusted', () => {
	const primary = { pubkey: PK, relayHost: 'abc.onion', relayPort: 9101 };
	assert.deepEqual(lfbw.directFundingConfig({ mode: 'internal', trusted: true }, primary), {
		lspPubkey: PK,
		lspHost: 'abc.onion',
		lspPort: 9101,
		targetInboundSat: 0,
		trusted: true,
		allowSplice: true,
		allowUnpairedSplice: true
	});
	const external = lfbw.directFundingConfig({ mode: 'external', trusted: false }, primary);
	assert.equal(external.targetInboundSat, lfbw.DEFAULT_INBOUND_SATS);
	assert.equal(external.trusted, false);
	assert.equal(
		'allowSplice' in lfbw.directFundingConfig({ mode: 'internal', trusted: true }, primary, { allowSpliceSupported: false }),
		false,
		'an engine without the field is not sent it'
	);
	assert.equal(
		'allowUnpairedSplice' in lfbw.directFundingConfig({ mode: 'internal', trusted: true }, primary, { allowSpliceSupported: false }),
		false,
		'not sent to an engine that lacks the field'
	);
});

test('an Iroh primary is signed in as the relay only through its onion fallback', () => {
	const bare = lfbw.directFundingConfig({ mode: 'external', trusted: true }, { pubkey: PK2, relayHost: null, relayPort: 0 });
	assert.equal(bare.lspPubkey, PK2);
	assert.equal('lspHost' in bare, false, 'the engine fails the call on a null host, so the key is left out');
	assert.equal('lspPort' in bare, false);
	const fallback = lfbw.directFundingConfig({ mode: 'external', trusted: true }, { pubkey: PK2, relayHost: ONION, relayPort: 9735 });
	assert.equal(fallback.lspHost, ONION);
	assert.equal(fallback.lspPort, 9735);
});


test('a payer reaches the wallet at its public address, else its onion, else not directly at all', () => {
	assert.deepEqual(lfbw.walletReach({ onionAddress: 'abcd.onion:9101', listenPort: 9101 }), { host: 'abcd.onion', port: 9101 });
	assert.deepEqual(lfbw.walletReach({ listenPort: 9101, publicHost: '192.168.50.20' }), { host: '192.168.50.20', port: 9101 });
	assert.deepEqual(
		lfbw.walletReach({ onionAddress: 'abcd.onion:9101', listenPort: 9101, publicHost: '203.0.113.4', publicPort: 19101 }),
		{ host: '203.0.113.4', port: 19101 },
		'the public address wins: faster, and a phone payer rarely has Tor'
	);
	assert.deepEqual(
		lfbw.walletReach({ listenPort: 9101, publicHost: '203.0.113.4', publicPort: 19101 }),
		{ host: '203.0.113.4', port: 19101 },
		'at the published host port, not the container port'
	);
	assert.equal(lfbw.walletReach({ listenPort: 9101 }), null);
	assert.equal(lfbw.walletReach({ listenPort: 9101, publicHost: '  ' }), null);
});

test('perkwFromSatVb converts at 250 sat/kw per sat/vB and never goes under the floor', () => {
	assert.equal(lfbw.perkwFromSatVb(7), 1750);
	assert.equal(lfbw.perkwFromSatVb(1), 253);
	assert.equal(lfbw.perkwFromSatVb(0), 253);
	assert.equal(lfbw.perkwFromSatVb('x'), 253);
});

const ch = (extra) => ({ channelId: 'c1', peerPubkey: PK, state: 'NORMAL', htlcUsable: true, ...extra });
const confirmed = [{ height: 100 }, { height: 120 }];

test('channelize waits below the floor, on any unconfirmed UTXO, on a pending or splicing channel', () => {
	const base = { onchainSats: 50000, utxos: confirmed, channels: [], primaryPubkey: PK };
	assert.deepEqual(lfbw.channelizeTarget({ ...base, onchainSats: 24999 }), { action: 'wait', reason: 'below-floor' });
	assert.deepEqual(lfbw.channelizeTarget({ ...base, utxos: [{ height: 100 }, { height: null }] }), { action: 'wait', reason: 'unconfirmed' });
	assert.deepEqual(lfbw.channelizeTarget({ ...base, utxos: [{ height: 0 }] }), { action: 'wait', reason: 'unconfirmed' });
	assert.deepEqual(lfbw.channelizeTarget({ ...base, utxos: null }), { action: 'wait', reason: 'no-utxos' });
	assert.deepEqual(
		lfbw.channelizeTarget({ ...base, channels: [ch({ state: 'OPENING', htlcUsable: false })] }),
		{ action: 'wait', reason: 'channel-pending' }
	);
	assert.deepEqual(
		lfbw.channelizeTarget({ ...base, channels: [ch({ state: 'SPLICING' })] }),
		{ action: 'wait', reason: 'splicing' }
	);
});

test('channelize splices into the home channel, or opens the first one', () => {
	const base = { onchainSats: 50000, utxos: confirmed, primaryPubkey: PK };
	assert.deepEqual(lfbw.channelizeTarget({ ...base, channels: [ch()] }), { action: 'splice-in', channelId: 'c1' });
	assert.deepEqual(
		lfbw.channelizeTarget({ ...base, channels: [ch({ peerPubkey: PK2 }), ch({ channelId: 'old', state: 'CLOSED' })] }),
		{ action: 'open' },
		'channels with other peers and closed channels do not count'
	);
});

test('a splice order uses the daemon quote, net of fee, at the converted rate', () => {
	const target = { action: 'splice-in', channelId: 'c1' };
	assert.deepEqual(lfbw.channelizeOrder(target, { spliceQuote: { maxAmountSats: 48000 }, feeNormal: 7 }), {
		action: 'splice-in',
		body: { channelId: 'c1', amountSats: 48000, feeratePerkw: 1750 }
	});
	assert.deepEqual(lfbw.channelizeOrder(target, { spliceQuote: { maxAmountSats: 22000 }, feeNormal: 7 }), {
		action: 'wait',
		reason: 'quote-too-small'
	});
	assert.deepEqual(lfbw.channelizeOrder(target, { spliceQuote: null, feeNormal: 7 }), { action: 'wait', reason: 'quote-too-small' });
});

test('an open order sweeps the quoted max into a channel with the primary, zero-conf only for a trusted internal pair', () => {
	const primary = { pubkey: PK, connectHost: '127.0.0.1', connectPort: 9101 };
	const internal = lfbw.channelizeOrder({ action: 'open' }, { txQuote: { maxSendSats: 48000 }, feeNormal: 7, mode: 'internal', trusted: true, primary });
	assert.deepEqual(internal, {
		action: 'open',
		path: '/channel/connect-and-open',
		body: { pubkey: PK, host: '127.0.0.1', port: 9101, amountSats: 48000, satsPerVbyte: 7, max: true, trusted: true }
	});
	const untrusted = lfbw.channelizeOrder({ action: 'open' }, { txQuote: { maxSendSats: 48000 }, feeNormal: 0, mode: 'internal', trusted: false, primary });
	assert.equal(untrusted.body.trusted, false);
	assert.equal(untrusted.body.satsPerVbyte, 2, 'a missing fee estimate falls back to 2 sat/vB');
	assert.deepEqual(lfbw.channelizeOrder({ action: 'open' }, { txQuote: { maxSendSats: 19999 }, feeNormal: 7, mode: 'internal', trusted: true, primary }), {
		action: 'wait',
		reason: 'quote-too-small'
	});
});

test('an external primary is first asked to sell inbound in a dual-funded open, with a plain open as fallback', () => {
	const primary = { pubkey: PK2, connectHost: 'lsp.example', connectPort: 9735 };
	const order = lfbw.channelizeOrder(
		{ action: 'open' },
		{ txQuote: { maxSendSats: 200000 }, feeNormal: 7, mode: 'external', trusted: false, blockHeight: 500, primary }
	);
	assert.equal(order.action, 'open-v2');
	// requested = min(200000, 100000) = 100000; lease fee ceiling = 10000 + 1% = 11000; margin 2000.
	assert.deepEqual(order.body, {
		pubkey: PK2,
		amountSats: 200000 - 11000 - 2000,
		requestFunds: { requestedSats: 100000, blockheight: 500 },
		maxLeaseRates: { ...lfbw.MAX_LEASE_RATES }
	});
	assert.equal(order.fallback.action, 'open');
	assert.equal(order.fallback.body.trusted, false);
	const noHeight = lfbw.channelizeOrder(
		{ action: 'open' },
		{ txQuote: { maxSendSats: 200000 }, feeNormal: 7, mode: 'external', blockHeight: 0, primary }
	);
	assert.equal(noHeight.action, 'open', 'no block height, no liquidity ad: a plain open');
	const small = lfbw.channelizeOrder(
		{ action: 'open' },
		{ txQuote: { maxSendSats: 30000 }, feeNormal: 7, mode: 'external', blockHeight: 500, primary }
	);
	assert.equal(small.action, 'open', 'too small to buy inbound alongside: a plain open');
});

test('an Iroh primary opens on the live connection, having no host and port to dial', () => {
	const primary = {
		pubkey: PK2,
		connectHost: ENDPOINT,
		connectPort: 0,
		transport: { type: 'iroh', endpointId: ENDPOINT, relayUrl: RELAY }
	};
	const plain = lfbw.channelizeOrder(
		{ action: 'open' },
		{ txQuote: { maxSendSats: 30000 }, feeNormal: 7, mode: 'external', trusted: true, blockHeight: 500, primary }
	);
	assert.deepEqual(plain, {
		action: 'open',
		path: '/channel/open',
		body: { pubkey: PK2, amountSats: 30000, satsPerVbyte: 7, max: true }
	});
	const v2 = lfbw.channelizeOrder(
		{ action: 'open' },
		{ txQuote: { maxSendSats: 200000 }, feeNormal: 7, mode: 'external', trusted: true, blockHeight: 500, primary }
	);
	assert.equal(v2.action, 'open-v2');
	assert.equal(v2.fallback.path, '/channel/open');
	assert.deepEqual(v2.fallback.body, { pubkey: PK2, amountSats: 200000, satsPerVbyte: 7, max: true });
});

test('a wait target passes through an order unchanged', () => {
	assert.deepEqual(lfbw.channelizeOrder({ action: 'wait', reason: 'below-floor' }, {}), { action: 'wait', reason: 'below-floor' });
});

test('a move waits while the quoted fee is more than a twentieth of the amount, unless forced', () => {
	const target = { action: 'splice-in', channelId: 'c1' };
	const pricey = { maxAmountSats: 48000, feeSats: 3000 };
	assert.deepEqual(lfbw.channelizeOrder(target, { spliceQuote: pricey, feeNormal: 40 }), {
		action: 'wait',
		reason: 'fee-too-high',
		feeSats: 3000,
		amountSats: 48000
	});
	assert.equal(lfbw.CHANNELIZE_FEE_MULTIPLE, 20);
	assert.equal(lfbw.channelizeOrder(target, { spliceQuote: { maxAmountSats: 60000, feeSats: 3000 }, feeNormal: 40 }).action, 'splice-in', 'exactly twenty times passes');
	assert.equal(lfbw.channelizeOrder(target, { spliceQuote: pricey, feeNormal: 40, force: true }).action, 'splice-in', 'the owner can override the wait');
	assert.equal(lfbw.channelizeOrder(target, { spliceQuote: { maxAmountSats: 48000 }, feeNormal: 40 }).action, 'splice-in', 'a quote without a fee cannot be judged');
	const primary = { pubkey: PK, connectHost: '127.0.0.1', connectPort: 9101 };
	const open = lfbw.channelizeOrder({ action: 'open' }, { txQuote: { maxSendSats: 30000, feeSats: 2000 }, feeNormal: 40, mode: 'internal', trusted: true, primary });
	assert.deepEqual(open, { action: 'wait', reason: 'fee-too-high', feeSats: 2000, amountSats: 30000 });
	assert.equal(
		lfbw.channelizeOrder({ action: 'open' }, { txQuote: { maxSendSats: 30000, feeSats: 2000 }, feeNormal: 40, mode: 'internal', trusted: true, primary, force: true }).action,
		'open'
	);
	// Forcing skips the fee wait, never the channel minimums.
	assert.deepEqual(
		lfbw.channelizeOrder({ action: 'open' }, { txQuote: { maxSendSats: 19999, feeSats: 100 }, feeNormal: 40, mode: 'internal', trusted: true, primary, force: true }),
		{ action: 'wait', reason: 'quote-too-small' }
	);
	assert.deepEqual(lfbw.channelizeOrder(target, { spliceQuote: { maxAmountSats: 22000, feeSats: 100 }, feeNormal: 7, force: true }), {
		action: 'wait',
		reason: 'quote-too-small'
	});
});
