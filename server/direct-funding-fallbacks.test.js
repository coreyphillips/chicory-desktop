'use strict';

/**
 * Run with: npm test (from server/).
 *
 * What this log is for: a direct funding that degraded into an ordinary
 * payment leaves no trace anywhere else, so an entry is only worth keeping if
 * it carries the reason, and it is only findable if the transaction id ties it
 * to the payment it became.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DirectFundingFallbackLog, MAX_FALLBACKS } = require('./direct-funding-fallbacks');
const { WalletManager } = require('./wallet-manager');

const TXID = 'a'.repeat(64);
const NODE = '02' + 'bc'.repeat(32);
const REQUEST = 'd'.repeat(32);

function tmpdir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dff-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('without a reason there is nothing worth recording', (t) => {
	const log = new DirectFundingFallbackLog(tmpdir(t));
	assert.equal(log.record(null), null);
	assert.equal(log.record({ txid: TXID }), null);
	assert.equal(log.record({ reason: '   ' }), null);
	assert.deepEqual(log.list(), []);
});

test('a fallback keeps the reason, the payment it became and the request it was paying', (t) => {
	const log = new DirectFundingFallbackLog(tmpdir(t));
	const { entry, persisted } = log.record({
		reason: '  The recipient did not take the direct funding.  ',
		address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		amountSats: 50_000,
		txid: TXID.toUpperCase(),
		nodeId: NODE,
		requestId: REQUEST
	});
	assert.equal(persisted, true);
	assert.equal(entry.reason, 'The recipient did not take the direct funding.');
	assert.equal(entry.txid, TXID, 'lower case, so it matches a transaction list');
	assert.equal(entry.amountSats, 50_000);
	assert.equal(entry.nodeId, NODE);
	assert.equal(entry.requestId, REQUEST);
	assert.ok(entry.timestamp > 0);
});

test('identifiers that cannot join anything are left out rather than recorded', (t) => {
	const log = new DirectFundingFallbackLog(tmpdir(t));
	const { entry } = log.record({
		reason: 'the daemon refused it',
		txid: 'not-a-txid',
		nodeId: '02ab',
		requestId: 'zzzz',
		amountSats: -5
	});
	assert.deepEqual(Object.keys(entry).sort(), ['reason', 'timestamp']);
});

test('the timestamp is ours: a browser clock is not evidence of when this happened', (t) => {
	const log = new DirectFundingFallbackLog(tmpdir(t));
	const before = Date.now();
	const { entry } = log.record({ reason: 'refused', timestamp: 0 });
	assert.ok(entry.timestamp >= before);
});

test('the ordinary payment failing too is kept, with no transaction to attach it to', (t) => {
	const log = new DirectFundingFallbackLog(tmpdir(t));
	const { entry } = log.record({ reason: 'request expired', error: 'The splice was refused' });
	assert.equal(entry.error, 'The splice was refused');
	assert.equal(entry.txid, undefined);
});

test('a long refusal is capped rather than allowed to grow the file', (t) => {
	const log = new DirectFundingFallbackLog(tmpdir(t));
	const { entry } = log.record({ reason: 'x'.repeat(5000) });
	assert.equal(entry.reason.length, 500);
});

test('history survives a new instance, i.e. a manager restart', (t) => {
	const dir = tmpdir(t);
	new DirectFundingFallbackLog(dir).record({ reason: 'receiver declined the offer', txid: TXID });
	const reloaded = new DirectFundingFallbackLog(dir).list();
	assert.equal(reloaded.length, 1);
	assert.equal(reloaded[0].reason, 'receiver declined the offer');
	assert.equal(reloaded[0].txid, TXID);
});

test('a file whose last line was left unterminated does not swallow the next entry', (t) => {
	const dir = tmpdir(t);
	const file = path.join(dir, 'direct-funding-fallbacks.jsonl');
	fs.writeFileSync(file, JSON.stringify({ timestamp: 1, reason: 'receiver declined the offer' }));
	const { persisted } = new DirectFundingFallbackLog(dir).record({ reason: 'request expired' });
	assert.equal(persisted, true);
	assert.deepEqual(
		new DirectFundingFallbackLog(dir).list().map((e) => e.reason),
		['receiver declined the offer', 'request expired'],
		'both survive: appending onto the tail would have joined them into one unparseable line'
	);
});

test('keeps exactly the newest MAX_FALLBACKS entries, oldest first', (t) => {
	const dir = tmpdir(t);
	const log = new DirectFundingFallbackLog(dir);
	for (let i = 0; i < MAX_FALLBACKS + 10; i++) log.record({ reason: `refusal ${i}` });
	const entries = new DirectFundingFallbackLog(dir).list();
	assert.equal(entries.length, MAX_FALLBACKS);
	assert.equal(entries[0].reason, 'refusal 10');
	assert.equal(entries[entries.length - 1].reason, `refusal ${MAX_FALLBACKS + 9}`);
});

/* ------------------------------------------------ what the routes call into */

function managerOn(dir) {
	const m = Object.create(WalletManager.prototype);
	m.registry = { get: (id) => (id === 'w1' ? { id: 'w1' } : undefined) };
	m.fallbackLogs = new Map();
	m.logs = [];
	m._log = (_id, line) => m.logs.push(line);
	m.paths = () => ({ base: dir });
	return m;
}

test('the manager takes a fallback for a wallet it has, and refuses the rest', (t) => {
	const m = managerOn(tmpdir(t));
	assert.throws(() => m.recordDirectFundingFallback('nope', { reason: 'refused' }), { statusCode: 404 });
	assert.throws(() => m.recordDirectFundingFallback('w1', {}), { statusCode: 400 });
	assert.throws(() => m.directFundingFallbacks('nope'), { statusCode: 404 });

	const entry = m.recordDirectFundingFallback('w1', {
		reason: 'receiver declined the offer',
		txid: TXID
	});
	assert.equal(entry.persisted, true);
	// The Logs tab is the second place to find this, for the wallet whose
	// dashboard is open while it happens.
	assert.deepEqual(m.logs, [
		`direct funding not taken (receiver declined the offer); paid as an ordinary transaction ${TXID}`
	]);
	assert.deepEqual(
		m.directFundingFallbacks('w1').map((e) => e.txid),
		[TXID]
	);
});

test('a log that cannot be read records in memory only, and admits it', (t) => {
	const dir = tmpdir(t);
	// A directory where the file should be: readFileSync fails with EISDIR,
	// which must not be taken for "nothing recorded yet".
	fs.mkdirSync(path.join(dir, 'direct-funding-fallbacks.jsonl'));
	const warnings = [];
	const log = new DirectFundingFallbackLog(dir, { warn: (m) => warnings.push(m) });
	const { persisted } = log.record({ reason: 'refused' });
	assert.equal(persisted, false);
	assert.match(warnings[0], /direct-funding fallbacks unreadable/);
	assert.equal(log.list().length, 1, 'still served for this session');
});
