'use strict';

const path = require('path');
const { JsonlLog } = require('./jsonl-log');

// Durable per-wallet record of direct fundings that degraded into an ordinary
// payment.
//
// Only the payer ever learns why: the daemon's refusal, the caveat on an offer
// the recipient did not take. The recipient cannot tell an offer that was
// declined from one that never arrived, and what lands there is a plain send
// with change, indistinguishable from one that was never meant to be anything
// else. Until this the reason lasted as long as a toast (umbrel #121).
const MAX_FALLBACKS = 200;

// A daemon refusal is a sentence or two. The cap is here so a pathological one
// cannot grow the file without bound.
const MAX_TEXT = 500;

function text(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

// A fallback's steps (umbrel #147): enough for a slow exchange that dialed
// every route twice, and short enough that the file stays a list of reasons.
const MAX_STEPS = 40;

// Only scalars are kept, each capped like the reason: a step's data is a
// caption for its action, and the engine's own record is the full account.
function steps(value) {
	if (!Array.isArray(value)) return null;
	const kept = [];
	for (const step of value.slice(-MAX_STEPS)) {
		if (!step || !/^df_[a-z_]+$/.test(step.action) || !Number.isFinite(step.timestamp)) continue;
		const data = {};
		for (const [key, v] of Object.entries(step.data && typeof step.data === 'object' ? step.data : {})) {
			if (typeof v === 'string') data[key] = v.slice(0, MAX_TEXT);
			else if (typeof v === 'number' || typeof v === 'boolean') data[key] = v;
		}
		kept.push({ timestamp: step.timestamp, action: step.action, data });
	}
	return kept.length ? kept : null;
}

// Identifiers are recorded only when they are the right shape, because a
// malformed one joins nothing and reads as though it might.
function hex(value, length) {
	return typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
		? value.toLowerCase()
		: null;
}

class DirectFundingFallbackLog {
	constructor(dir, { warn } = {}) {
		this.log = new JsonlLog(path.join(dir, 'direct-funding-fallbacks.jsonl'), {
			max: MAX_FALLBACKS,
			label: 'direct-funding fallbacks',
			warn
		});
	}

	/**
	 * Record one fallback, returning { entry, persisted }, or null when there
	 * is no reason to record. The reason is the whole of what this log holds
	 * that nothing else does; the rest describes a payment the wallet already
	 * lists, and is kept so the entry can be tied back to it.
	 *
	 * The timestamp is ours rather than the caller's: this is written from a
	 * browser, and a browser's clock is not evidence of when anything happened.
	 */
	record(input) {
		const reason = text(input && input.reason);
		if (!reason) return null;
		const entry = { timestamp: Date.now(), reason };
		// The payment the fallback became. This is what ties the reason to a row
		// in the dashboard's activity list, and the one field worth going back
		// for; there is none when the ordinary payment failed too.
		const txid = hex(input.txid, 64);
		if (txid) entry.txid = txid;
		const address = text(input.address);
		if (address) entry.address = address;
		if (Number.isInteger(input.amountSats) && input.amountSats >= 0) {
			entry.amountSats = input.amountSats;
		}
		// Which request was being paid, and who asked: a payer that hits this
		// twice needs to know whether it was the same recipient both times.
		const nodeId = hex(input.nodeId, 66);
		if (nodeId) entry.nodeId = nodeId;
		const requestId = hex(input.requestId, 32);
		if (requestId) entry.requestId = requestId;
		const error = text(input.error);
		if (error) entry.error = error;
		// What the daemon did before it gave up: the routes it tried and why
		// each went nowhere, stamped by the daemon.
		const tried = steps(input.steps);
		if (tried) entry.steps = tried;
		return this.log.append(entry);
	}

	/** Every fallback, oldest first. */
	list() {
		return this.log.all();
	}
}

module.exports = { DirectFundingFallbackLog, MAX_FALLBACKS, MAX_STEPS };
