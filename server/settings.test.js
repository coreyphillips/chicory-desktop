'use strict';

/**
 * Run with: npm test (from server/).
 *
 * settings.json holds the recovery guardian set, the default network and the
 * default Electrum server. A file that could not be parsed used to leave the
 * defaults in memory with nothing kept of the bytes, and the next save (the
 * Settings dialog, or the lastBackupAt stamp an export writes on its own)
 * renamed those defaults over it. Damaged settings can be read back by eye
 * while they are still on disk, so they are now copied aside at load, the way
 * the registry does it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings } = require('./settings');
const { WalletManager } = require('./wallet-manager');

const SEED = { defaultNetwork: 'bitcoin', defaultElectrum: null };
const GUARDIAN = `${'1'.repeat(64)}@https://g1.example/`;

function tmpFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-settings-'));
	return path.join(dir, 'settings.json');
}

const quiet = (fn) => {
	const error = console.error;
	console.error = () => {};
	try {
		return fn();
	} finally {
		console.error = error;
	}
};

const copies = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));

test('settings that cannot be parsed are kept aside before a save writes defaults over them', () => {
	const file = tmpFile();
	// Truncated mid-write, and the only copy of a guardian set entered by hand.
	const corrupt = `{"defaultNetwork":"regtest","recoveryGuardians":["${GUARDIAN}"`;
	fs.writeFileSync(file, corrupt);
	const s = new Settings(file, SEED);
	quiet(() => s.load());
	assert.ok(s.loadError, 'the failure is remembered');
	assert.match(s.loadError.message, /JSON/);
	assert.equal(s.get().defaultNetwork, 'bitcoin', 'the seeded defaults stand in');
	assert.deepEqual(s.get().recoveryGuardians, []);

	const kept = s.loadError.backup;
	assert.ok(kept.startsWith(`${file}.corrupt-`));

	// The stamp an export writes without being asked is enough to replace it.
	s.update({ lastBackupAt: '2026-09-17T00:00:00.000Z' });
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).recoveryGuardians, []);
	assert.equal(fs.readFileSync(kept, 'utf8'), corrupt, 'the copy is the unreadable file, byte for byte');
	assert.equal(s.loadError, null, 'the file on disk is now the one that was written');
});

test('a second load of the same unreadable file keeps one copy, not two', () => {
	const file = tmpFile();
	fs.writeFileSync(file, 'not json');
	const s = new Settings(file, SEED);
	quiet(() => s.load());
	quiet(() => s.load());
	assert.equal(copies(file).length, 1);
});

test('a save is refused while the unreadable file is the only copy left', () => {
	const file = tmpFile();
	const corrupt = `{"defaultNetwork":"regtest","recoveryGuardians":["${GUARDIAN}"`;
	fs.writeFileSync(file, corrupt);
	const s = new Settings(file, SEED);
	// The copy can fail on its own: a full disk, or a data dir that was not
	// writable at boot.
	s._keepUnreadable = () => null;
	quiet(() => s.load());
	assert.equal(s.loadError.backup, null);
	quiet(() => assert.throws(() => s.update({ lastBackupAt: '2026-09-17T00:00:00.000Z' }), /refusing to overwrite/));
	assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'the only copy is still on disk');

	// Once a copy can be made, the save goes through.
	delete s._keepUnreadable;
	quiet(() => s.update({ lastBackupAt: '2026-09-17T00:00:00.000Z' }));
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).recoveryGuardians, []);
	assert.equal(fs.readFileSync(path.join(path.dirname(file), copies(file)[0]), 'utf8'), corrupt);

	// Removing the file is what the refusal asks for, and it must not wedge.
	const gone = new Settings(tmpFile(), SEED);
	gone._keepUnreadable = () => null;
	fs.writeFileSync(gone.file, 'not json');
	quiet(() => gone.load());
	fs.rmSync(gone.file);
	gone.save();
	assert.equal(JSON.parse(fs.readFileSync(gone.file, 'utf8')).defaultNetwork, 'bitcoin');
});

test('a missing settings file is not a failure: the first save creates it', () => {
	const file = tmpFile();
	const s = new Settings(file, SEED);
	s.load();
	assert.equal(s.loadError, null);
	s.update({ defaultNetwork: 'regtest' });
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).defaultNetwork, 'regtest');
	assert.equal(copies(file).length, 0);
});

test('a valid settings file round-trips through load and update', () => {
	const file = tmpFile();
	fs.writeFileSync(
		file,
		JSON.stringify({ defaultNetwork: 'regtest', recoveryGuardians: [GUARDIAN], lastBackupAt: null })
	);
	const s = new Settings(file, SEED);
	s.load();
	assert.equal(s.loadError, null);
	assert.deepEqual(s.get().recoveryGuardians, [GUARDIAN]);
	s.update({ lastBackupAt: '2026-09-17T00:00:00.000Z' });
	const again = new Settings(file, SEED);
	again.load();
	assert.deepEqual(again.get().recoveryGuardians, [GUARDIAN]);
	assert.equal(again.get().lastBackupAt, '2026-09-17T00:00:00.000Z');
	assert.equal(copies(file).length, 0, 'no copy for a good file');
});

test('an unreadable file of either kind is degraded in the health report', () => {
	const m = Object.create(WalletManager.prototype);
	m.registry = { loadError: null };
	m.settings = { loadError: null };
	assert.deepEqual(m.health(), { status: 'ok', registry: null, settings: null });

	m.settings.loadError = { message: 'Unexpected end of JSON input', backup: '/data/settings.json.corrupt-x', at: 1 };
	const degraded = m.health();
	assert.equal(degraded.status, 'degraded');
	assert.equal(degraded.registry, null);
	assert.deepEqual(degraded.settings, {
		error: 'Unexpected end of JSON input',
		backup: '/data/settings.json.corrupt-x',
		at: 1
	});

	m.registry.loadError = { message: 'Unexpected token }', backup: null, at: 2 };
	assert.equal(m.health().registry.error, 'Unexpected token }');
});
