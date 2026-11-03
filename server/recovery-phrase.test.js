'use strict';

/**
 * Run with: npm test (from server/).
 *
 * A wallet's recovery phrase can be read back after the create dialog has
 * closed. What it reads is the seed file the daemon is started from, byte for
 * byte after trimming; a wallet with no seed file says so rather than
 * answering with nothing; and each read leaves a line in the wallet's log
 * that never carries the words.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config reads DATA_DIR once, at require time: the temp box has to exist
// before wallet-manager is loaded.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-phrase-'));
process.env.DATA_DIR = DATA_DIR;

const { WalletManager } = require('./wallet-manager');

const SEED =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function box({ mnemonic = SEED } = {}) {
	for (const entry of fs.readdirSync(DATA_DIR)) {
		fs.rmSync(path.join(DATA_DIR, entry), { recursive: true, force: true });
	}
	const secrets = path.join(DATA_DIR, 'wallets', ID, 'secrets');
	fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
	if (mnemonic !== null) fs.writeFileSync(path.join(secrets, 'mnemonic'), mnemonic, { mode: 0o600 });
	fs.writeFileSync(
		path.join(DATA_DIR, 'registry.json'),
		JSON.stringify([{ id: ID, name: 'Spending', network: 'regtest', port: 3101, running: false }])
	);
	const m = new WalletManager();
	m.settings.load();
	m.registry.load();
	return m;
}

/** The manager narrates each read to stdout; the tests read the wallet log instead. */
function quiet(fn) {
	const write = process.stdout.write;
	process.stdout.write = () => true;
	try {
		return fn();
	} finally {
		process.stdout.write = write;
	}
}

test('the phrase read back is the seed file the wallet runs on, and the read is logged without it', () => {
	const m = box({ mnemonic: `${SEED}\n` });
	const result = quiet(() => m.recoveryPhrase(ID));
	assert.deepEqual(result, { mnemonic: SEED });
	const logs = m.runtimeState(ID).logs;
	assert.equal(logs.length, 1);
	assert.match(logs[0], /recovery phrase shown in the dashboard/);
	assert.doesNotMatch(logs[0], /abandon/);
});

test('an unknown wallet is not found, and a wallet with no seed file says the phrase is not here', () => {
	const m = box({ mnemonic: null });
	assert.throws(
		() => m.recoveryPhrase('bbbbbbbb-0000-4000-8000-000000000002'),
		(e) => e.statusCode === 404 && e.code === 'NOT_FOUND'
	);
	assert.throws(
		() => m.recoveryPhrase(ID),
		(e) => e.statusCode === 404 && e.code === 'NO_SEED' && /not on this Umbrel/.test(e.message)
	);
	const empty = box({ mnemonic: '  \n' });
	assert.throws(() => empty.recoveryPhrase(ID), (e) => e.code === 'NO_SEED');
	assert.equal(empty.runtimeState(ID).logs.length, 0);
});
