'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The registry file is the only list of the wallets this manager owns. A
 * file that exists but cannot be parsed used to leave the records empty and
 * the next upsert or remove then wrote that near-empty list over it, so
 * every other wallet was forgotten while its data dir sat on disk unlisted.
 * A load that fails for any reason but a missing file now refuses every
 * save and keeps a copy of what it could not read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Registry } = require('./registry');

function tmpFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-registry-'));
	return path.join(dir, 'registry.json');
}

const quiet = async (fn) => {
	const error = console.error;
	console.error = () => {};
	try {
		return await fn();
	} finally {
		console.error = error;
	}
};

const rec = (id, extra = {}) => ({ id, name: `Wallet ${id}`, network: 'regtest', port: 3000, ...extra });

test('a registry file that cannot be parsed is never overwritten, and a copy of it is kept', async () => {
	const file = tmpFile();
	const corrupt = '[{"id":"w1","name":"Old wallet"},{"id":"w2","na';
	fs.writeFileSync(file, corrupt);
	const r = new Registry(file);
	await quiet(() => r.load());
	assert.ok(r.loadError, 'the failure is remembered');
	assert.match(r.loadError.message, /JSON/);
	assert.equal(r.list().length, 0);
	assert.ok(r.loadError.backup.startsWith(`${file}.corrupt-`));
	assert.equal(fs.readFileSync(r.loadError.backup, 'utf8'), corrupt, 'the copy is the unreadable file, byte for byte');

	assert.throws(() => r.upsert(rec('w3')), /refusing to overwrite/);
	assert.throws(() => r.remove('w1'), /refusing to overwrite/);
	assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'the only copy of the other wallets is untouched');
	assert.equal(fs.existsSync(`${file}.tmp`), false);
	assert.ok(r.get('w3'), 'the record is held in memory for the life of the process');
});

test('a second load of the same unreadable file keeps one copy, not two', async () => {
	const file = tmpFile();
	fs.writeFileSync(file, 'not json');
	const r = new Registry(file);
	await quiet(() => r.load());
	await quiet(() => r.load());
	const copies = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
	assert.equal(copies.length, 1);
});

test('a missing registry file is not a failure: the first upsert creates it', async () => {
	const file = tmpFile();
	const r = new Registry(file);
	r.load();
	assert.equal(r.loadError, null);
	r.upsert(rec('w1'));
	assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [rec('w1')]);
});

test('a valid registry file round-trips through load, upsert and remove', () => {
	const file = tmpFile();
	fs.writeFileSync(file, JSON.stringify([rec('w1'), rec('w2', { port: 3001 })]));
	const r = new Registry(file);
	r.load();
	assert.equal(r.loadError, null);
	assert.deepEqual(r.list().map((x) => x.id), ['w1', 'w2']);
	r.upsert(rec('w3', { port: 3002 }));
	r.remove('w1');
	const again = new Registry(file);
	again.load();
	assert.deepEqual(again.list().map((x) => x.id), ['w2', 'w3']);
	assert.equal(again.get('w2').port, 3001);
	assert.equal(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')), false, 'no copy for a good file');
});
