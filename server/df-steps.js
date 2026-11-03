'use strict';

// The steps of a direct funding, gathered for the wallet log and for the
// payment they belong to (umbrel #147).
//
// They come from two places, and neither has the whole story. The engine
// writes the lanes' and the receiver's steps (df_lane_skipped,
// df_frame_dropped, df_offer_*, df_blinded_path_failed) to its action log,
// which the daemon serves at GET /logs and never prints. The payer's own steps
// (df_send_*) are printed and never written there.

const DF_PREFIX = 'df_';
// Every entry here names a direct funding, so a busy wallet makes a handful a
// payment. Enough to hold the recent ones while a card or a fallback asks.
const MAX_STEPS = 500;
// An attempt that never logged its end (the daemon died mid-exchange) stops
// collecting steps this long after it began: the offer window is 120 s and the
// receipt window 45 s after that, and dials can add a minute to either.
const ATTEMPT_MAX_MS = 10 * 60 * 1000;
const STARTS = new Set(['df_send_prepared', 'df_send_started']);
const ENDS = new Set(['df_send_completed', 'df_send_refused']);

function isStep(entry) {
	return (
		!!entry &&
		typeof entry.action === 'string' &&
		entry.action.startsWith(DF_PREFIX) &&
		Number.isFinite(entry.timestamp)
	);
}

function keyOf(step) {
	return `${step.timestamp} ${step.action} ${JSON.stringify(step.data || {})}`;
}

/** The line a step gets in the wallet log: the shape the manager's event lines use. */
function formatStep(step) {
	return `${step.action} ${JSON.stringify(step.data || {})}`;
}

/**
 * Where the next GET /logs read starts, and what it has already handed over.
 *
 * `since` is inclusive on the daemon, so the last read's newest millisecond
 * comes back every time; the entries already taken at that millisecond are
 * remembered and skipped.
 */
class ActionLogCursor {
	constructor(since) {
		this.since = since;
		this.seen = new Set();
	}

	path() {
		return `/logs?category=channel&since=${this.since}`;
	}

	/** Entries as GET /logs answers them; returns the df_ ones not taken before, oldest first. */
	take(entries) {
		const list = (Array.isArray(entries) ? entries : [])
			.filter((e) => e && Number.isFinite(e.timestamp) && e.timestamp >= this.since)
			.sort((a, b) => a.timestamp - b.timestamp);
		const fresh = [];
		for (const entry of list) {
			if (!isStep(entry)) continue;
			const step = {
				timestamp: entry.timestamp,
				action: entry.action,
				data: entry.data && typeof entry.data === 'object' ? entry.data : {}
			};
			const key = keyOf(step);
			if (this.seen.has(key)) continue;
			this.seen.add(key);
			fresh.push(step);
		}
		if (list.length > 0) {
			const newest = list[list.length - 1].timestamp;
			if (newest > this.since) {
				this.since = newest;
				for (const key of this.seen) {
					if (!key.startsWith(`${newest} `)) this.seen.delete(key);
				}
			}
		}
		return fresh;
	}
}

// One field of a util.inspect object, as console.info prints it.
const FIELD = /^([A-Za-z_$][\w$]*): (.*?),?$/;
const HEAD = /^(df_[a-z_]+)(?:\s+(.*))?$/;

function scalar(text) {
	if (/^'.*'$/.test(text)) return text.slice(1, -1).replace(/\\'/g, "'");
	if (text === 'true' || text === 'false') return text === 'true';
	if (text === 'null' || text === 'undefined') return null;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return text;
}

function inlineFields(body) {
	const data = {};
	const re = /([A-Za-z_$][\w$]*): ('(?:[^'\\]|\\.)*'|[^,{}[\]\s][^,{}[\]]*)/g;
	let m;
	while ((m = re.exec(body))) data[m[1]] = scalar(m[2].trim());
	return data;
}

/**
 * Turns the payer's printed df_send_* lines back into steps.
 *
 * The daemon prints them with console.info(action, data), which breaks any
 * object longer than a short line across several, and the manager splits its
 * output into lines before anything sees it. Only top-level scalars are kept:
 * the request id is what ties a step to a payment, and the rest is a caption.
 */
class PrintedStepReader {
	constructor() {
		this.open = null;
	}

	/** Feed one trimmed output line; returns the steps it finished. */
	read(line, at = Date.now()) {
		const done = [];
		if (this.open) {
			if (/[{[]$/.test(line) && !/^[}\]]/.test(line)) {
				this.open.depth += 1;
				return done;
			}
			if (/^[}\]]/.test(line)) {
				this.open.depth -= 1;
				if (this.open.depth === 0) {
					done.push(this.open.step);
					this.open = null;
				}
				return done;
			}
			const field = FIELD.exec(line);
			if (field) {
				if (this.open.depth === 1) this.open.step.data[field[1]] = scalar(field[2]);
				return done;
			}
			// Something else interleaved (another writer, a chunk split mid-line):
			// keep what the block said so far rather than lose the step.
			done.push(this.open.step);
			this.open = null;
		}
		const head = HEAD.exec(line);
		if (!head) return done;
		const step = { timestamp: at, action: head[1], data: {} };
		const rest = (head[2] || '').trim();
		if (rest === '{') {
			this.open = { step, depth: 1 };
		} else {
			if (rest.startsWith('{')) step.data = inlineFields(rest);
			done.push(step);
		}
		return done;
	}
}

/** A wallet's recent direct-funding steps, oldest first. */
class DirectFundingSteps {
	constructor({ max = MAX_STEPS } = {}) {
		this.max = max;
		this.steps = [];
		this.keys = new Set();
	}

	/** Returns false for a step already held. */
	add(step) {
		if (!isStep(step)) return false;
		const key = keyOf(step);
		if (this.keys.has(key)) return false;
		this.keys.add(key);
		// Printed steps are stamped as they arrive and logged ones when they
		// happened, so they do not arrive in order.
		let i = this.steps.length;
		while (i > 0 && this.steps[i - 1].timestamp > step.timestamp) i--;
		this.steps.splice(i, 0, step);
		if (this.steps.length > this.max) this.keys.delete(keyOf(this.steps.shift()));
		return true;
	}

	/**
	 * The steps of the latest attempt to pay one request, optionally the latest
	 * that began by `until`.
	 *
	 * The lanes' steps carry no request id, so an attempt is a stretch of time:
	 * from its first step naming the request to the step that ended it, or to
	 * the next payment's start. Steps naming another request are left out.
	 */
	forRequest(requestId, { until } = {}) {
		if (typeof requestId !== 'string' || !requestId) return [];
		const want = requestId.toLowerCase();
		const steps = this.steps;
		const named = (s) => typeof s.data.requestId === 'string' && s.data.requestId.toLowerCase() === want;
		const bound = Number.isFinite(until) ? until : Infinity;
		let start = -1;
		for (let i = steps.length - 1; i >= 0; i--) {
			if (steps[i].timestamp <= bound && STARTS.has(steps[i].action) && named(steps[i])) {
				start = i;
				break;
			}
		}
		if (start === -1) return [];
		// A df_send_prepared ahead of the start belongs to the same attempt,
		// unless an earlier attempt ended in between or is too old to be this one.
		const latest = steps[start].timestamp;
		while (start > 0) {
			let j = start - 1;
			while (j >= 0 && !named(steps[j])) j--;
			if (j < 0 || ENDS.has(steps[j].action) || !STARTS.has(steps[j].action)) break;
			if (latest - steps[j].timestamp > ATTEMPT_MAX_MS) break;
			start = j;
		}
		const deadline = latest + ATTEMPT_MAX_MS;
		const out = [];
		for (let i = start; i < steps.length; i++) {
			const s = steps[i];
			if (s.timestamp > deadline) break;
			if (i > start && STARTS.has(s.action) && typeof s.data.requestId === 'string' && !named(s)) break;
			if (typeof s.data.requestId === 'string' && !named(s)) continue;
			// An offer this wallet received, never a step of its own send.
			if (s.action.startsWith('df_offer_')) continue;
			out.push(s);
			if (i > start && ENDS.has(s.action) && named(s)) break;
		}
		return out;
	}
}

module.exports = {
	ActionLogCursor,
	PrintedStepReader,
	DirectFundingSteps,
	formatStep,
	ATTEMPT_MAX_MS,
	MAX_STEPS
};
