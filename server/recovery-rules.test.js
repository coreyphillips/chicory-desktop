'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The manager's own rules for channel backup, the ones a refused daemon
 * start would otherwise teach the user through a restart loop: a guardian
 * set is three entries or none, a wallet pins the set it first registers
 * with, and strict quorum is never left once entered.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');
const {
	validateGuardianDraft,
	validateGuardianSet,
	parseGuardianEntry,
	sameGuardianSet,
	recoveryEnv,
	isNodeUri
} = require('./recovery');

const K = (c) => c.repeat(64);
const G = [`${K('a')}@http://127.0.0.1:8101`, `${K('b')}@http://127.0.0.1:8102`, `${K('c')}@https://g.example`];
const OTHER = [`${K('d')}@http://127.0.0.1:8201`, `${K('e')}@http://127.0.0.1:8202`, `${K('f')}@https://h.example`];

function managerWith({ guardians = [], engine = '0.9.2', records = {}, autoApply = true } = {}) {
	const m = Object.create(WalletManager.prototype);
	const data = { defaultNetwork: 'regtest', defaultElectrum: null, recoveryGuardians: guardians };
	m.settings = {
		get: () => data,
		update: (patch) => Object.assign(data, patch)
	};
	m.engineVersion = engine;
	m.recoveryAutoApplySupported = autoApply;
	m.registry = {
		get: (id) => records[id],
		list: () => Object.values(records),
		upsert: (rec) => {
			records[rec.id] = rec;
		}
	};
	m.runtime = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m._killProc = async () => {};
	m.startWallet = async () => {};
	m.onionAddress = () => null;
	m.torCircuitOk = null;
	return m;
}

const rejects = (fn, code) => {
	try {
		fn();
	} catch (err) {
		assert.equal(err.code, code, err.message);
		return err;
	}
	assert.fail(`expected ${code}`);
};

// updateSettings is async since the default server is probed for its chain.
const rejectsAsync = async (promise, code) => {
	try {
		await promise;
	} catch (err) {
		assert.equal(err.code, code, err.message);
		return err;
	}
	return assert.fail(`expected ${code}`);
};

test('guardian entries are pubkey@url with an http(s) or bolt8 URL', () => {
	assert.equal(parseGuardianEntry(` ${K('A')}@http://127.0.0.1:8101 `).pubkey, K('a'));
	assert.equal(parseGuardianEntry(`${K('a')}@http://127.0.0.1:8101`).bolt8, false);
	assert.throws(() => parseGuardianEntry(`${K('a')}http://x`), /separator/);
	assert.throws(() => parseGuardianEntry(`abc@http://x`), /64-hex/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@not a url`), /not a valid URL/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@ftp://x`), /http, https or bolt8/);
});

test('a bolt8 entry names a beignet node by its Lightning address (beignet #699)', () => {
	const node = '02' + K('B');
	const parsed = parseGuardianEntry(`${K('A')}@bolt8://${node}@Guardian.Example:9735`);
	assert.equal(parsed.pubkey, K('a'));
	assert.equal(parsed.bolt8, true);
	assert.equal(parsed.url, `bolt8://${node.toLowerCase()}@guardian.example:9735`);
	assert.equal(parsed.entry, `${K('a')}@${parsed.url}`);
	// The onion form a pool of Umbrels actually uses.
	assert.equal(parseGuardianEntry(`${K('a')}@bolt8://${node}@${'a'.repeat(56)}.onion:9101`).bolt8, true);
	assert.throws(() => parseGuardianEntry(`${K('a')}@bolt8://${K('b')}@h:1`), /66-hex node id/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@bolt8://${node}:secret@h:1`), /nothing else/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@bolt8://${node}@h`), /host and a port/);
	assert.throws(() => parseGuardianEntry(`${K('a')}@bolt8://${node}@h:1/path`), /must not carry a path/);
	// A plain node URI is not an entry yet: it resolves to one through the daemon.
	assert.equal(isNodeUri(`${node}@umbrel.local:9101`), true);
	assert.equal(isNodeUri(`${node}@${'a'.repeat(56)}.onion:9101`), true);
	assert.equal(isNodeUri(`${K('a')}@http://x`), false);
	assert.equal(isNodeUri(`${K('a')}@bolt8://${node}@h:1`), false);
	// Drafts and sets accept bolt8 entries beside http ones.
	const mixed = [G[0], `${K('b')}@bolt8://${node}@h:9735`, G[2]];
	assert.deepEqual(validateGuardianSet(mixed), [G[0], `${K('b')}@bolt8://${node.toLowerCase()}@h:9735`, G[2]]);
});

test('serving as a guardian needs the engine surface and a Lightning listener', () => {
	const m = managerWith({});
	m.guardianHostingSupported = false;
	assert.equal(m._normalizeGuardianServe(undefined, false), false);
	assert.equal(m._normalizeGuardianServe(false, false), false);
	rejects(() => m._normalizeGuardianServe(true, false), 'GUARDIAN_HOSTING_UNSUPPORTED');
	m.guardianHostingSupported = true;
	assert.equal(m._normalizeGuardianServe(true, false), true);
	rejects(() => m._normalizeGuardianServe(true, true), 'GUARDIAN_SERVE_NEEDS_LIGHTNING');
});

test('guardian candidates are the serving wallets with the addresses to reach them', () => {
	const node = '02' + K('c');
	const m = managerWith({
		records: {
			a: { id: 'a', name: 'Main', network: 'mainnet', port: 3101, running: true, guardianServe: true, nodeId: node, announce: true, networkMode: 'hybrid', publicHost: '203.0.113.4' },
			b: { id: 'b', name: 'Quiet', network: 'mainnet', port: 3102, running: true, guardianServe: false, nodeId: node },
			c: { id: 'c', name: 'Parked', network: 'mainnet', port: 3103, running: true, guardianServe: true, onchainOnly: true, nodeId: node },
			d: { id: 'd', name: 'Fresh', network: 'mainnet', port: 3104, running: true, guardianServe: true }
		}
	});
	m.listenPort = (rec) => rec.port + 6000;
	m.runtimeState = () => ({ healthy: true });
	m.onionAddress = (rec) => (rec.announce ? `${'x'.repeat(56)}.onion:${rec.port + 6000}` : null);
	const candidates = m.guardianCandidates();
	assert.deepEqual(
		candidates.map((c) => c.id),
		['a'],
		'not serving, on-chain only, and no node id yet are all left out'
	);
	assert.equal(candidates[0].onionUri, `${node}@${'x'.repeat(56)}.onion:9101`);
	assert.equal(candidates[0].publicUri, `${node}@203.0.113.4:9101`, 'the announced public address, at the port peers dial');
	assert.equal(candidates[0].localUri, `${node}@127.0.0.1:9101`);
	assert.equal(candidates[0].running, true);
});

test('a guardian draft is up to three distinct entries', () => {
	assert.deepEqual(validateGuardianDraft([]), []);
	assert.deepEqual(validateGuardianDraft(G.slice(0, 1)), G.slice(0, 1));
	assert.deepEqual(validateGuardianDraft(['', G[0], ' ']), [G[0]], 'blank slots are not entries');
	assert.throws(() => validateGuardianDraft([G[0], G[0]]), /distinct/);
	assert.throws(() => validateGuardianDraft([...G, OTHER[0]]), /at most 3/);
	assert.throws(() => validateGuardianDraft([G[0], 'junk']), /separator/);
	assert.throws(() => validateGuardianDraft('nope'), /list/);
});

test('a guardian set is three distinct entries or none', () => {
	assert.deepEqual(validateGuardianSet([]), []);
	assert.deepEqual(validateGuardianSet(['', ' ']), [], 'blank entries are no entries');
	assert.equal(validateGuardianSet(G).length, 3);
	assert.throws(() => validateGuardianSet(G.slice(0, 2)), /exactly 3/);
	assert.throws(() => validateGuardianSet([G[0], G[0], G[1]]), /distinct/);
	assert.throws(() => validateGuardianSet('nope'), /list/);
	assert.ok(sameGuardianSet(G, [G[2], G[0], G[1]]), 'order does not make a different set');
	assert.ok(!sameGuardianSet(G, OTHER));
});

test('recoveryEnv is empty for off and whole for a guardian mode', () => {
	assert.deepEqual(recoveryEnv(undefined), {});
	assert.deepEqual(recoveryEnv({ mode: 'off' }), {});
	assert.deepEqual(recoveryEnv({ mode: 'peer-storage' }), { BEIGNET_RECOVERY_MODE: 'peer-storage' });
	assert.deepEqual(
		recoveryEnv({ mode: 'peer-storage', autoApply: true }),
		{ BEIGNET_RECOVERY_MODE: 'peer-storage', BEIGNET_RECOVERY_AUTO_APPLY: 'true' },
		'the automatic checkpoint restore rides only with peer storage'
	);
	assert.equal(recoveryEnv({ mode: 'quorum', guardians: G, autoApply: true }).BEIGNET_RECOVERY_AUTO_APPLY, undefined);
	assert.equal(recoveryEnv({ mode: 'off', autoApply: true }).BEIGNET_RECOVERY_AUTO_APPLY, undefined);
	assert.deepEqual(recoveryEnv({ mode: 'async-remote', guardians: G }), {
		BEIGNET_RECOVERY_MODE: 'async-remote',
		BEIGNET_RECOVERY_GUARDIANS: G.join(','),
		BEIGNET_RECOVERY_PROFILE: 'crash-v1'
	});
});

test('settings save a partial draft, refuse a malformed one, and clear on empty', async () => {
	const m = managerWith();
	assert.deepEqual((await m.updateSettings({ recoveryGuardians: G })).recoveryGuardians, G);
	assert.deepEqual(
		(await m.updateSettings({ recoveryGuardians: G.slice(0, 1) })).recoveryGuardians,
		G.slice(0, 1),
		'one guardian saves as one guardian, to be finished later'
	);
	assert.deepEqual((await m.updateSettings({ recoveryGuardians: G.slice(0, 2) })).recoveryGuardians, G.slice(0, 2));
	await rejectsAsync(m.updateSettings({ recoveryGuardians: [G[0], G[1], 'junk'] }), 'BAD_GUARDIANS');
	await rejectsAsync(m.updateSettings({ recoveryGuardians: [G[0], G[0]] }), 'BAD_GUARDIANS');
	await rejectsAsync(m.updateSettings({ recoveryGuardians: [...G, OTHER[0]] }), 'BAD_GUARDIANS');
	assert.deepEqual(
		m.getSettings().recoveryGuardians,
		G.slice(0, 2),
		'a refused patch leaves the draft alone'
	);
	assert.deepEqual((await m.updateSettings({ recoveryGuardians: [] })).recoveryGuardians, []);
	assert.deepEqual((await m.updateSettings({ recoveryGuardians: null })).recoveryGuardians, []);
});

test('a guardian mode needs the draft finished', () => {
	rejects(() => managerWith({ guardians: G.slice(0, 2) })._normalizeRecovery('quorum', null), 'NO_GUARDIANS');
	assert.deepEqual(managerWith({ guardians: G })._normalizeRecovery('quorum', null), {
		mode: 'quorum',
		guardians: G
	});
});

test('an unknown mode, an old engine, and a guardian mode with no set are refused', () => {
	rejects(() => managerWith()._normalizeRecovery('sometimes', null), 'BAD_RECOVERY_MODE');
	rejects(() => managerWith({ engine: '0.9.0' })._normalizeRecovery('peer-storage', null), 'RECOVERY_UNSUPPORTED');
	rejects(() => managerWith({ engine: null })._normalizeRecovery('quorum', null), 'RECOVERY_UNSUPPORTED');
	rejects(() => managerWith()._normalizeRecovery('quorum', null), 'NO_GUARDIANS');
	assert.deepEqual(managerWith({ engine: '0.9.0' })._normalizeRecovery('off', null), {
		mode: 'off',
		guardians: []
	});
	assert.deepEqual(managerWith()._normalizeRecovery(undefined, { mode: "peer-storage", guardians: [] }), {
		mode: 'peer-storage',
		guardians: []
	}, 'no mode in the patch keeps what the record has');
});

test('a wallet pins the set it first enables with and keeps it afterwards', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, running: false, recovery: { mode: 'off', guardians: [] } }
	};
	const m = managerWith({ guardians: G, records });
	let rec = await m.updateWallet('w1', { recoveryMode: 'async-remote' });
	assert.deepEqual(rec.recovery, { mode: 'async-remote', guardians: G, autoApply: false });
	// Settings move on; the wallet does not.
	await m.updateSettings({ recoveryGuardians: OTHER });
	rec = await m.updateWallet('w1', { recoveryMode: 'quorum' });
	assert.deepEqual(rec.recovery, { mode: 'quorum', guardians: G, autoApply: false }, 'the pinned set rides into quorum');
	rec = await m.updateWallet('w1', { name: 'renamed' });
	assert.deepEqual(rec.recovery, { mode: 'quorum', guardians: G, autoApply: false }, 'a patch without a mode changes nothing');
});

test('leaving quorum is refused, and the record is untouched by a refused edit', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, running: false, recovery: { mode: 'quorum', guardians: G } }
	};
	const m = managerWith({ guardians: G, records });
	await assert.rejects(m.updateWallet('w1', { name: 'x', recoveryMode: 'async-remote' }), (err) => err.code === 'RECOVERY_QUORUM_STICKY');
	await assert.rejects(m.updateWallet('w1', { recoveryMode: 'off' }), (err) => err.code === 'RECOVERY_QUORUM_STICKY');
	assert.equal(records.w1.name, 'w', 'the rename in the refused patch did not land');
	const rec = await m.updateWallet('w1', { recoveryMode: 'quorum', onchainOnly: true });
	assert.deepEqual(rec.recovery, { mode: 'quorum', guardians: G, autoApply: false }, 'parking keeps the barrier config');
	assert.equal(rec.onchainOnly, true);
});

test('an edit mid-restore is refused; an edit while merely holding is not', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, port: 3001, running: true, recovery: { mode: 'quorum', guardians: G } }
	};
	const m = managerWith({ guardians: G, records });
	m.runtime.set('w1', { proc: { pid: 1 }, status: 'restore-required', healthy: false, stopping: false });
	m._restoreInFlight = async () => true;
	await assert.rejects(m.updateWallet('w1', { name: 'x' }), (err) => err.code === 'RESTORE_IN_PROGRESS');
	m._restoreInFlight = async () => false;
	const rec = await m.updateWallet('w1', { name: 'x' });
	assert.equal(rec.name, 'x');
});

test('the automatic checkpoint restore is a peer-storage answer, kept until the mode leaves peer storage', async () => {
	const records = {
		w1: { id: 'w1', name: 'w', network: 'regtest', electrum: {}, running: false, recovery: { mode: 'off', guardians: [] } }
	};
	const m = managerWith({ guardians: G, records });
	assert.deepEqual(m._normalizeRecovery('peer-storage', null, true), { mode: 'peer-storage', guardians: [], autoApply: true });
	assert.deepEqual(m._normalizeRecovery('peer-storage', null, false), { mode: 'peer-storage', guardians: [] });
	assert.deepEqual(m._normalizeRecovery('off', null, true), { mode: 'off', guardians: [] }, 'dropped outside peer storage');
	assert.deepEqual(m._normalizeRecovery('quorum', null, true), { mode: 'quorum', guardians: G });
	let rec = await m.updateWallet('w1', { recoveryMode: 'peer-storage', recoveryAutoApply: true });
	assert.deepEqual(rec.recovery, { mode: 'peer-storage', guardians: [], autoApply: true });
	rec = await m.updateWallet('w1', { name: 'renamed' });
	assert.equal(rec.recovery.autoApply, true, 'a patch that says nothing keeps the answer');
	rec = await m.updateWallet('w1', { recoveryAutoApply: false });
	assert.equal(rec.recovery.autoApply, false, 'and the answer can be withdrawn');
	rec = await m.updateWallet('w1', { recoveryAutoApply: true });
	rec = await m.updateWallet('w1', { recoveryMode: 'async-remote' });
	assert.equal(rec.recovery.autoApply, false, 'leaving peer storage drops it');
	rec = await m.updateWallet('w1', { recoveryMode: 'peer-storage' });
	assert.equal(rec.recovery.autoApply, false, 'and coming back does not resurrect it');
});

test('an engine that cannot apply a checkpoint by itself refuses the answer rather than losing it', () => {
	const m = managerWith({ autoApply: false });
	rejects(() => m._normalizeRecovery('peer-storage', null, true), 'RECOVERY_AUTO_APPLY_UNSUPPORTED');
	assert.deepEqual(m._normalizeRecovery('peer-storage', null, false), { mode: 'peer-storage', guardians: [] });
	assert.deepEqual(
		m._normalizeRecovery(undefined, { mode: 'peer-storage', guardians: [], autoApply: true }),
		{ mode: 'peer-storage', guardians: [], autoApply: true },
		'a record that already carries it keeps it; only a fresh request is refused'
	);
});

test('a bolt8 guardian in the settings draft needs an engine with the transport', async () => {
	const node = '02' + K('d');
	const entry = `${K('a')}@bolt8://${node}@h:9735`;
	const m = managerWith({});
	m.guardianHostingSupported = false;
	await rejectsAsync(m.updateSettings({ recoveryGuardians: [entry] }), 'GUARDIAN_HOSTING_UNSUPPORTED');
	assert.deepEqual((await m.updateSettings({ recoveryGuardians: [G[0]] })).recoveryGuardians, [G[0]], 'http entries are unaffected');
	m.guardianHostingSupported = true;
	assert.deepEqual((await m.updateSettings({ recoveryGuardians: [entry] })).recoveryGuardians, [entry]);
});

test('rotating a guardian set asks the daemon and moves the record with it (beignet #701)', async () => {
	const node = '02' + K('e');
	const rec = { id: 'w', name: 'W', port: 3101, running: true, recovery: { mode: 'quorum', guardians: G.slice() } };
	const m = managerWith({ records: { w: rec } });
	m.guardianRotationSupported = true;
	m.runtimeState = () => ({ proc: {}, healthy: true });
	const calls = [];
	m._daemonCall = async (r, method, path, body) => {
		calls.push({ id: r.id, method, path, body });
		return { generation: '2', guardians: [], retired: 1 };
	};
	m.publicRecord = (id) => ({ id, recovery: { guardians: m.registry.get(id).recovery.guardians } });
	const incoming = [G[1], G[2], `${K('f')}@bolt8://${node}@friend.onion:9101`];
	const result = await m.rotateGuardians('w', incoming);
	assert.equal(result.generation, '2');
	assert.equal(result.retired, 1);
	assert.deepEqual(calls, [
		{ id: 'w', method: 'POST', path: '/recovery/rotate-guardians', body: { guardians: incoming, confirm: true } }
	]);
	assert.deepEqual(m.registry.get('w').recovery.guardians, incoming, 'the record names the new set');

	// Refusals: the same set, a short list, a wallet without guardians, an engine without the route.
	await assert.rejects(() => m.rotateGuardians('w', incoming), (e) => e.code === 'BAD_GUARDIANS');
	await assert.rejects(() => m.rotateGuardians('w', [G[0]]), (e) => e.code === 'BAD_GUARDIANS');
	rec.recovery = { mode: 'peer-storage', guardians: [] };
	await assert.rejects(() => m.rotateGuardians('w', G), (e) => e.code === 'NOT_GUARDIAN_MODE');
	rec.recovery = { mode: 'quorum', guardians: incoming };
	m.guardianRotationSupported = false;
	await assert.rejects(() => m.rotateGuardians('w', G), (e) => e.code === 'GUARDIAN_ROTATION_UNSUPPORTED');
	// The daemon's own refusal keeps its code and the record stays put.
	m.guardianRotationSupported = true;
	m._daemonCall = async () => {
		const e = new Error('the startup gate is quarantined');
		e.code = 'ROTATION_UNAVAILABLE';
		throw e;
	};
	await assert.rejects(() => m.rotateGuardians('w', G), (e) => e.code === 'ROTATION_UNAVAILABLE' && e.statusCode === 409);
	assert.deepEqual(m.registry.get('w').recovery.guardians, incoming);
});
