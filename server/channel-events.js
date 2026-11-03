'use strict';

const path = require('path');
const { JsonlLog } = require('./jsonl-log');

// Durable per-wallet channel history. The daemon reports a channel's life
// (opening, ready, closing, and the reason an automatic force-close fired)
// only as transient events on its stream; the manager's in-memory rings die
// with the process. This log is the record that survives: without it, a
// channel that closed while nobody was watching has no story to tell, which
// is exactly the complaint that motivated it (a force-closed channel whose
// detail view could not say what happened or when).
const MAX_EVENTS = 500;

// The daemon SSE events that narrate a channel's lifecycle. channel:resolved
// (every on-chain output of a close irrevocably swept, relayed since beignet
// 0.9.0) is the terminal one: after it the story is complete.
const LIFECYCLE_EVENTS = new Set([
	'channel:opening',
	'channel:ready',
	'channel:pending-close',
	'channel:force-closing',
	'channel:closed',
	'channel:resolved',
	// FFOR offline receive (beignet #729): the epoch's committed state
	// changes and a peer contradicting an ACTIVE epoch at reconnect. An
	// epoch's start, activation, settlements while the wallet was away and
	// its close are exactly the history a user asks about later.
	'ffor:state',
	'ffor:enforce'
]);

class ChannelEventLog {
	constructor(dir, { warn } = {}) {
		this.log = new JsonlLog(path.join(dir, 'channel-events.jsonl'), {
			max: MAX_EVENTS,
			label: 'channel history',
			warn
		});
	}

	/**
	 * Record a daemon event if it tells a channel's story: a lifecycle event,
	 * or a node:error that names a channel (automatic force-close reasons like
	 * REESTABLISH_TIMEOUT_FORCE_CLOSED arrive that way and nowhere else).
	 *
	 * Returns null for events that are not channel-shaped, otherwise
	 * { entry, persisted }: persisted is false when the entry lives only in
	 * this process's memory (unwritable disk, unreadable log), so the caller
	 * never mistakes a session-only note for the durable record.
	 */
	record(name, data) {
		if (!data || typeof data !== 'object') return null;
		const isError = name === 'node:error' && data.channelId;
		if (!isError && !LIFECYCLE_EVENTS.has(name)) return null;
		if (!data.channelId) return null;
		const entry = {
			timestamp: data.timestamp || Date.now(),
			event: name,
			channelId: String(data.channelId)
		};
		if (data.initiator) entry.initiator = data.initiator;
		if (name === 'ffor:state' && data.state) entry.state = String(data.state);
		if (data.fundingTxid) entry.fundingTxid = String(data.fundingTxid);
		if (isError) {
			entry.code = data.code || 'ERROR';
			entry.message = data.message || 'Unknown error';
		}
		return this.log.append(entry);
	}

	/** Entries oldest first, optionally for one channel. */
	list({ channelId } = {}) {
		const all = this.log.all();
		return channelId ? all.filter((e) => e.channelId === channelId) : all;
	}
}

module.exports = { ChannelEventLog, MAX_EVENTS };
