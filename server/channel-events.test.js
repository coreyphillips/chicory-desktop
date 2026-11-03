'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The durability contract of the channel history log, pinned where it can
 * silently rot: a failure to read or write the file must never be presented
 * as a recorded, durable history.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChannelEventLog, MAX_EVENTS } = require('./channel-events');

function tmpdir(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cel-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test('records lifecycle events and channel-naming errors, ignores the rest', (t) => {
	const log = new ChannelEventLog(tmpdir(t));
	assert.equal(log.record('payment:received', { amountSats: 5 }), null);
	assert.equal(log.record('node:error', { code: 'X', message: 'no channel' }), null);
	assert.equal(log.record('channel:ready', null), null);

	const opening = log.record('channel:opening', { channelId: 'aa', fundingTxid: 'ff' });
	assert.equal(opening.persisted, true);
	log.record('channel:ready', { channelId: 'aa' });
	const errored = log.record('node:error', {
		channelId: 'aa',
		code: 'REESTABLISH_TIMEOUT_FORCE_CLOSED',
		message: 'boom',
		timestamp: 123
	});
	log.record('channel:force-closing', { channelId: 'aa', initiator: 'local' });
	log.record('channel:opening', { channelId: 'bb' });

	assert.equal(errored.entry.timestamp, 123, 'daemon timestamp preserved');
	assert.equal(log.list().length, 5);
	const aa = log.list({ channelId: 'aa' });
	assert.equal(aa.length, 4, 'per-channel filtering');
	assert.deepEqual(
		aa.map((e) => e.event),
		['channel:opening', 'channel:ready', 'node:error', 'channel:force-closing'],
		'insertion order kept'
	);
	assert.equal(aa[2].code, 'REESTABLISH_TIMEOUT_FORCE_CLOSED');
});

test('history survives a new instance, i.e. a manager restart', (t) => {
	const dir = tmpdir(t);
	const first = new ChannelEventLog(dir);
	first.record('channel:opening', { channelId: 'aa' });
	first.record('channel:ready', { channelId: 'aa' });

	const second = new ChannelEventLog(dir);
	assert.equal(second.list().length, 2);
	assert.equal(second.list()[1].event, 'channel:ready');
});

test('keeps exactly the newest MAX_EVENTS entries, in order', (t) => {
	const dir = tmpdir(t);
	const log = new ChannelEventLog(dir);
	for (let i = 0; i < MAX_EVENTS + 100; i++) {
		log.record('channel:ready', { channelId: 'cc', timestamp: i });
	}
	const reloaded = new ChannelEventLog(dir);
	const entries = reloaded.list();
	assert.equal(entries.length, MAX_EVENTS);
	assert.equal(entries[0].timestamp, 100, 'oldest surviving entry');
	assert.equal(entries[entries.length - 1].timestamp, MAX_EVENTS + 99, 'newest kept');
});

test('a torn line loses one entry, not the log, and says so', (t) => {
	const dir = tmpdir(t);
	const log = new ChannelEventLog(dir);
	log.record('channel:opening', { channelId: 'aa' });
	log.record('channel:ready', { channelId: 'aa' });
	fs.appendFileSync(path.join(dir, 'channel-events.jsonl'), '{"torn": tru');

	const warnings = [];
	const reloaded = new ChannelEventLog(dir, { warn: (m) => warnings.push(m) });
	assert.equal(reloaded.list().length, 2, 'intact entries survive');
	assert.equal(warnings.length, 1, 'the loss is reported, not silent');
	assert.match(warnings[0], /malformed/);
});

test('ENOENT means no history yet; nothing is broken and writes work', (t) => {
	const warnings = [];
	const log = new ChannelEventLog(tmpdir(t), { warn: (m) => warnings.push(m) });
	assert.deepEqual(log.list(), []);
	assert.equal(warnings.length, 0, 'a missing file is not a failure');
	assert.equal(log.record('channel:ready', { channelId: 'aa' }).persisted, true);
});

test('a genuine read failure is reported and never written through', (t) => {
	const dir = tmpdir(t);
	// A directory where the file should be: readFileSync fails with EISDIR,
	// which must NOT be treated as "no history yet".
	fs.mkdirSync(path.join(dir, 'channel-events.jsonl'));

	const warnings = [];
	const log = new ChannelEventLog(dir, { warn: (m) => warnings.push(m) });
	const rec = log.record('channel:ready', { channelId: 'aa' });
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /unreadable/);
	assert.equal(rec.persisted, false, 'entry is memory-only, and admits it');
	assert.equal(log.list().length, 1, 'still served for this session');
	// Writing through an unreadable log could compact over history we cannot
	// see; the file location must be left untouched.
	assert.ok(fs.statSync(path.join(dir, 'channel-events.jsonl')).isDirectory());
});

test('an append failure is reported and the entry marked unpersisted', (t) => {
	const dir = tmpdir(t);
	const file = path.join(dir, 'channel-events.jsonl');
	const warnings = [];
	const log = new ChannelEventLog(dir, { warn: (m) => warnings.push(m) });
	assert.equal(log.record('channel:opening', { channelId: 'aa' }).persisted, true);

	// Appending needs write permission on the FILE (a read-only directory only
	// blocks creating and renaming, not writing an existing file).
	fs.chmodSync(file, 0o444);
	t.after(() => {
		try {
			fs.chmodSync(file, 0o644);
		} catch (_) {
			/* already restored or removed */
		}
	});
	const rec = log.record('channel:ready', { channelId: 'aa' });
	assert.equal(rec.persisted, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /write failed/);
	assert.equal(log.list().length, 2, 'in-memory history still serves');

	fs.chmodSync(file, 0o644);
	const reloaded = new ChannelEventLog(dir);
	assert.equal(reloaded.list().length, 1, 'disk holds only what was persisted');
});

test('a compaction failure is reported and does not destroy the file', (t) => {
	const dir = tmpdir(t);
	const log = new ChannelEventLog(dir);
	for (let i = 0; i < MAX_EVENTS; i++) {
		log.record('channel:ready', { channelId: 'cc', timestamp: i });
	}

	const warnings = [];
	const full = new ChannelEventLog(dir, { warn: (m) => warnings.push(m) });
	// Directory chmod does not enforce write restrictions on Windows or
	// under a privileged user. Inject the failed temporary-file write itself.
	const temporary = path.join(dir, 'channel-events.jsonl.tmp');
	const write = fs.writeFileSync;
	t.mock.method(fs, 'writeFileSync', (file, ...args) => {
		if (file === temporary) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
		return write(file, ...args);
	});
	const rec = full.record('channel:ready', { channelId: 'cc', timestamp: 9999 });
	assert.equal(rec.persisted, false);
	assert.match(warnings[0], /write failed/);

	const reloaded = new ChannelEventLog(dir);
	assert.equal(reloaded.list().length, MAX_EVENTS, 'original file intact');
});

test('channel:resolved is recorded as the terminal event of a close', (t) => {
	const dir = tmpdir(t);
	const log = new ChannelEventLog(dir);
	log.record('channel:closed', { channelId: 'dd', timestamp: 1 });
	// Relayed since beignet 0.9.0: every on-chain output of the close swept.
	const rec = log.record('channel:resolved', { channelId: 'dd', timestamp: 2 });
	assert.ok(rec && rec.persisted, 'resolved is a lifecycle event and reaches disk');
	const reloaded = new ChannelEventLog(dir);
	assert.deepEqual(
		reloaded.list({ channelId: 'dd' }).map((e) => e.event),
		['channel:closed', 'channel:resolved']
	);
});

test('FFOR epoch events join the channel they run on, with the state kept (beignet #729)', (t) => {
	const log = new ChannelEventLog(tmpdir(t));
	const active = log.record('ffor:state', { channelId: 'aa', state: 'ACTIVE', epoch: { slots: [] } });
	assert.equal(active.entry.state, 'ACTIVE');
	assert.equal(active.entry.event, 'ffor:state');
	log.record('ffor:enforce', { channelId: 'aa', epoch: {} });
	assert.equal(log.record('ffor:settled', { channelId: 'aa', k: 1 }), null, 'a settlement for a sibling is not this channel history');
	assert.equal(log.record('ffor:state', { state: 'ACTIVE' }), null, 'no channel, no entry');
	assert.deepEqual(
		log.list({ channelId: 'aa' }).map((e) => e.event),
		['ffor:state', 'ffor:enforce']
	);
});
