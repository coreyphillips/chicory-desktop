'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The backup archive is the only way the half of a wallet that is not on the
 * chain (its seed, its API token, its record, the app's settings) leaves the
 * box. So the round trip is the test: export a data dir, wipe it, restore,
 * and the secrets are the same bytes with the same modes, the records are the
 * same records, and nothing has been started. The two refusals matter as
 * much: a wrong passphrase must fail cleanly rather than half-restore, and a
 * seed already running here must not quietly start running twice.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// config reads DATA_DIR once, at require time, and wallet-manager reads
// config: the temp box has to exist before either is loaded.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-backup-'));
process.env.DATA_DIR = DATA_DIR;

const { WalletManager } = require('./wallet-manager');
const { backupStale, openArchive, payloadFiles, payloadRegistry } = require('./backup');

const PASSPHRASE = 'a good long passphrase';

const SEED_A =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_B =
	'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

/** The export and restore paths both narrate themselves; tests do not need it. */
async function quiet(fn) {
	const write = process.stdout.write;
	const log = console.log;
	process.stdout.write = () => true;
	console.log = () => {};
	try {
		return await fn();
	} finally {
		process.stdout.write = write;
		console.log = log;
	}
}

function wipe() {
	for (const entry of fs.readdirSync(DATA_DIR)) {
		fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
	}
}

/** A wallet on disk exactly as _provision leaves one: record, seed, token. */
function seedWallet({ id, name, port, mnemonic, nodeId = null, extra = {} }) {
	const base = path.join(DATA_DIR, 'wallets', id);
	fs.mkdirSync(path.join(base, 'home'), { recursive: true });
	fs.mkdirSync(path.join(base, 'data'), { recursive: true });
	fs.mkdirSync(path.join(base, 'secrets'), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(base, 'secrets', 'mnemonic'), mnemonic, { mode: 0o600 });
	fs.writeFileSync(path.join(base, 'secrets', 'api_token'), crypto.randomBytes(32).toString('hex'), {
		mode: 0o600
	});
	return {
		id,
		name,
		network: 'regtest',
		electrum: { host: '10.21.21.10', port: 50001, tls: false },
		networkMode: 'hybrid',
		announce: false,
		onchainOnly: false,
		recovery: { mode: 'off', guardians: [] },
		guardianServe: false,
		lfbw: null,
		liquidityProvider: false,
		port,
		running: true,
		nodeId,
		createdAt: '2026-09-01T00:00:00.000Z',
		...extra
	};
}

function writeRegistry(records) {
	fs.writeFileSync(path.join(DATA_DIR, 'registry.json'), JSON.stringify(records, null, 2));
}

function writeSettings(settings) {
	fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(settings, null, 2));
}

function manager() {
	const m = new WalletManager();
	m.settings.load();
	m.registry.load();
	return m;
}

const secretsOf = (id) => ({
	mnemonic: fs.readFileSync(path.join(DATA_DIR, 'wallets', id, 'secrets', 'mnemonic')),
	token: fs.readFileSync(path.join(DATA_DIR, 'wallets', id, 'secrets', 'api_token'))
});
const modeOf = (file) => fs.statSync(file).mode & 0o777;

const GUARDIANS = ['1'.repeat(64) + '@https://g1.example/', '2'.repeat(64) + '@https://g2.example/'];

function twoWalletBox() {
	wipe();
	const a = seedWallet({ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Spending', port: 3101, mnemonic: SEED_A, nodeId: '02' + 'ab'.repeat(32) });
	const b = seedWallet({
		id: 'bbbbbbbb-0000-4000-8000-000000000002',
		name: 'Savings',
		port: 3102,
		mnemonic: SEED_B,
		extra: { onchainOnly: true, running: false }
	});
	writeRegistry([a, b]);
	writeSettings({
		defaultNetwork: 'regtest',
		defaultElectrum: { host: '10.21.21.10', port: 50001, tls: false },
		recoveryGuardians: GUARDIANS,
		lastBackupAt: null
	});
	return { a, b };
}

test('a box round-trips: export, wipe, restore, and the secrets are the same bytes with the same modes', async () => {
	const { a, b } = twoWalletBox();
	const before = { [a.id]: secretsOf(a.id), [b.id]: secretsOf(b.id) };
	const registryBytes = fs.readFileSync(path.join(DATA_DIR, 'registry.json'));

	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	assert.equal(out.walletCount, 2);
	assert.match(out.filename, /^beignet-backup-.*\.beignet$/);

	// The archive carries the files themselves, not a re-serialization of them.
	const files = payloadFiles(openArchive(out.archive, PASSPHRASE));
	assert.deepEqual(files.get('registry.json').data, registryBytes);
	assert.deepEqual(files.get(`wallets/${a.id}/secrets/mnemonic`).data, before[a.id].mnemonic);
	assert.equal(files.get(`wallets/${a.id}/secrets/mnemonic`).mode, 0o600);
	assert.equal(payloadRegistry(files).length, 2);
	// Nothing from data/ is in it: that is the recovery protocol's job.
	assert.equal([...files.keys()].some((k) => k.includes('/data/')), false);

	// Exporting is what makes a wallet count as backed up.
	const stamped = manager();
	assert.equal(stamped.publicRecord(a.id).lastBackupAt, out.createdAt);
	assert.equal(stamped.publicRecord(a.id).backupStale, false);
	assert.equal(stamped.getSettings().lastBackupAt, out.createdAt);

	wipe();
	const fresh = manager();
	assert.equal(fresh.list().length, 0);
	const result = await quiet(() =>
		fresh.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') })
	);
	assert.deepEqual(result.restored.map((w) => w.name).sort(), ['Savings', 'Spending']);
	assert.equal(result.settings, true);

	for (const rec of [a, b]) {
		const got = secretsOf(rec.id);
		assert.deepEqual(got.mnemonic, before[rec.id].mnemonic, `${rec.name} seed is the same bytes`);
		assert.deepEqual(got.token, before[rec.id].token, `${rec.name} token is the same bytes`);
		assert.equal(modeOf(path.join(DATA_DIR, 'wallets', rec.id, 'secrets', 'mnemonic')), 0o600);
		assert.equal(modeOf(path.join(DATA_DIR, 'wallets', rec.id, 'secrets', 'api_token')), 0o600);
	}

	// The records come back as they were, but stopped: a restore starts
	// nothing, and every wallet counts as backed up as of the archive.
	const restored = manager();
	for (const rec of [a, b]) {
		const got = restored.registry.get(rec.id);
		assert.deepEqual(got, { ...rec, running: false, lastBackupAt: out.createdAt });
		assert.equal(restored.publicRecord(rec.id).desiredRunning, false);
		assert.equal(restored.publicRecord(rec.id).backupStale, false);
	}
	// The app defaults are back too: a guardian-mode wallet cannot start
	// without the set, and the set lives here rather than on the record.
	assert.deepEqual(restored.getSettings().recoveryGuardians, GUARDIANS);
	assert.deepEqual(restored.getSettings().defaultElectrum, { host: '10.21.21.10', port: 50001, tls: false });
	// The daemon needs its directories, which no longer come from a create.
	for (const rec of [a, b]) {
		assert.ok(fs.existsSync(path.join(DATA_DIR, 'wallets', rec.id, 'data')));
		assert.ok(fs.existsSync(path.join(DATA_DIR, 'wallets', rec.id, 'home')));
	}
});

test('a wrong passphrase fails cleanly and writes nothing', async () => {
	const { a } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	wipe();
	const fresh = manager();
	assert.throws(
		() => fresh.restoreBackup({ passphrase: 'not the passphrase', archive: out.archive.toString('base64') }),
		(err) => err.code === 'BAD_PASSPHRASE' && err.statusCode === 400
	);
	assert.equal(fresh.list().length, 0);
	assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets', a.id)), false);
	// A file that is not one of ours says so rather than blaming the passphrase.
	assert.throws(
		() => fresh.restoreBackup({ passphrase: PASSPHRASE, archive: Buffer.from('hello there, not an archive').toString('base64') }),
		(err) => err.code === 'BAD_ARCHIVE'
	);
	// A header asking for more work than the app ever writes is refused
	// before scrypt is asked for it: logN, r and p sit at 16, 17 and 18,
	// after the 14-byte magic and the format and kdf bytes.
	const greedy = Buffer.from(out.archive);
	greedy.set([18, 255, 255], 16);
	assert.throws(
		() => fresh.restoreBackup({ passphrase: PASSPHRASE, archive: greedy.toString('base64') }),
		(err) => err.code === 'BAD_ARCHIVE'
	);
});

test('a passphrase too short to be worth typing is refused before anything is read', async () => {
	twoWalletBox();
	await assert.rejects(
		() => manager().exportBackup({ passphrase: 'short' }),
		(err) => err.code === 'WEAK_PASSPHRASE' && err.statusCode === 400
	);
	assert.equal(manager().getSettings().lastBackupAt, null, 'a refused export claims no backup');
});

test('settings that could not be read are not replaced by the export that would archive them', async () => {
	twoWalletBox();
	// Truncated, and holding a guardian set that exists nowhere else.
	const corrupt = `{"defaultNetwork":"regtest","recoveryGuardians":["${GUARDIANS[0]}"`;
	fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), corrupt);
	const error = console.error;
	console.error = () => {};
	let m;
	try {
		m = manager();
	} finally {
		console.error = error;
	}
	await assert.rejects(
		() => m.exportBackup({ passphrase: PASSPHRASE }),
		(err) => err.code === 'SETTINGS_UNREADABLE' && err.statusCode === 409
	);
	assert.equal(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'), corrupt);
});

test('a wallet whose node id is already here is refused until it is confirmed', async () => {
	const { a, b } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	const archive = out.archive.toString('base64');

	// A fresh box holding the same seed under another record: the same node,
	// twice, which is how channels get lost.
	wipe();
	const twin = seedWallet({
		id: 'cccccccc-0000-4000-8000-000000000003',
		name: 'The same node under another name',
		port: 3101,
		mnemonic: SEED_A
	});
	writeRegistry([twin]);
	const m = manager();

	const preview = m.inspectBackup({ passphrase: PASSPHRASE, archive });
	assert.equal(preview.conflicts.length, 1);
	assert.equal(preview.conflicts[0].id, a.id);
	assert.deepEqual(preview.conflicts[0].duplicateOf, { id: twin.id, name: twin.name });
	assert.equal(preview.wallets.find((w) => w.id === b.id).duplicateOf, null);

	assert.throws(
		() => m.restoreBackup({ passphrase: PASSPHRASE, archive }),
		(err) => err.code === 'DUPLICATE_NODE_ID' && err.statusCode === 409 && err.details.conflicts.length === 1
	);
	assert.equal(m.registry.get(a.id), undefined, 'nothing was written, not even the wallet with no conflict');

	const result = await quiet(() => m.restoreBackup({ passphrase: PASSPHRASE, archive, confirm: true }));
	assert.deepEqual(result.restored.map((w) => w.id).sort(), [a.id, b.id].sort());
	// The wallet already here kept its port; the restored twin was moved off it.
	assert.equal(manager().registry.get(twin.id).port, 3101);
	assert.notEqual(manager().registry.get(a.id).port, 3101);
});

test('two records on one seed inside one archive are the same conflict', async () => {
	// A box can hold the same seed twice (importing it twice is allowed), so
	// its archive can too; restoring both silently would leave the new box in
	// the state the confirm exists to stop.
	wipe();
	const one = seedWallet({ id: 'dddddddd-0000-4000-8000-000000000004', name: 'Spending', port: 3101, mnemonic: SEED_A });
	const two = seedWallet({ id: 'eeeeeeee-0000-4000-8000-000000000005', name: 'The same seed again', port: 3102, mnemonic: SEED_A });
	writeRegistry([one, two]);
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	const archive = out.archive.toString('base64');

	wipe();
	const m = manager();
	const preview = m.inspectBackup({ passphrase: PASSPHRASE, archive });
	assert.equal(preview.conflicts.length, 1);
	assert.equal(preview.conflicts[0].id, two.id);
	assert.deepEqual(preview.conflicts[0].duplicateOf, { id: one.id, name: one.name });

	assert.throws(
		() => m.restoreBackup({ passphrase: PASSPHRASE, archive }),
		(err) => err.code === 'DUPLICATE_NODE_ID' && err.statusCode === 409
	);
	assert.equal(m.list().length, 0);
	const result = await quiet(() => m.restoreBackup({ passphrase: PASSPHRASE, archive, confirm: true }));
	assert.equal(result.restored.length, 2);
});

test('an archive naming a network this app does not run is refused before anything is written', async () => {
	// The record is written to the registry as the archive states it, and the
	// network names the instance lock file the daemon writes beside its data.
	wipe();
	const rogue = seedWallet({ id: 'ffffffff-0000-4000-8000-000000000006', name: 'Rogue', port: 3105, mnemonic: SEED_B });
	writeRegistry([{ ...rogue, network: '../../../victim' }]);
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));

	wipe();
	const m = manager();
	assert.throws(
		() => m.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') }),
		(err) => err.code === 'BAD_NETWORK' && err.statusCode === 400
	);
	assert.equal(m.list().length, 0);
	assert.equal(fs.existsSync(path.join(DATA_DIR, 'wallets', rogue.id)), false);
});

test('a wallet already here under the same id is left exactly as it is', async () => {
	const { a, b } = twoWalletBox();
	const out = await quiet(() => manager().exportBackup({ passphrase: PASSPHRASE }));
	// Wallet A stays, with an edit the archive predates; B is gone.
	const kept = manager();
	// Stamped after the export it is compared with, not on a calendar date the
	// clock will one day pass.
	const editedAt = new Date(Date.parse(out.createdAt) + 60_000).toISOString();
	const edited = { ...kept.registry.get(a.id), name: 'Renamed since the backup', updatedAt: editedAt };
	writeRegistry([edited]);
	fs.rmSync(path.join(DATA_DIR, 'wallets', b.id), { recursive: true, force: true });

	const m = manager();
	assert.equal(m.publicRecord(a.id).backupStale, true, 'an edit since the export asks for a new one');
	const result = await quiet(() =>
		m.restoreBackup({ passphrase: PASSPHRASE, archive: out.archive.toString('base64') })
	);
	assert.deepEqual(result.restored.map((w) => w.id), [b.id]);
	assert.deepEqual(result.skipped.map((w) => [w.id, w.action]), [[a.id, 'present']]);
	assert.equal(manager().registry.get(a.id).name, 'Renamed since the backup');
});

test('the stale rule: never backed up, backed up, edited since', () => {
	const created = '2026-09-01T00:00:00.000Z';
	assert.equal(backupStale({ createdAt: created }), true);
	assert.equal(backupStale({ createdAt: created, lastBackupAt: '2026-09-02T00:00:00.000Z' }), false);
	assert.equal(
		backupStale({ createdAt: created, updatedAt: '2026-09-03T00:00:00.000Z', lastBackupAt: '2026-09-02T00:00:00.000Z' }),
		true
	);
	// A record made before the stamp existed has no updatedAt; creation stands
	// in for it, so a wallet created after the last export still asks.
	assert.equal(backupStale({ createdAt: '2026-09-04T00:00:00.000Z', lastBackupAt: '2026-09-02T00:00:00.000Z' }), true);
});
