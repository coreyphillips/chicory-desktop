'use strict';

// Requests that can move funds or change wallet state. Reads keep working
// while an update waits, so the owner can still see the wallet.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// A proxied wallet request whose client went away may never end its response,
// because the proxy drops it. It stops counting this long after the disconnect,
// so one abandoned request cannot block every later update.
const ABANDONED_MS = 2 * 60 * 1000;

/**
 * Lets the desktop shell pause wallet actions before it installs an update.
 * A hold refuses new actions and succeeds only once in-flight actions finish,
 * so an installer never starts between a payment request and its answer.
 */
function createUpdateHold({ abandonedMs = ABANDONED_MS } = {}) {
	let inFlight = 0;
	let held = false;
	let drained = [];

	const settle = () => {
		if (inFlight) return;
		for (const resolve of drained.splice(0)) resolve(true);
	};

	function middleware(req, res, next) {
		if (!MUTATING.has(req.method)) return next();
		if (held) {
			return res.status(503).json({
				ok: false,
				error: { code: 'UPDATE_PENDING', message: 'Chicory is preparing an update. Wallet actions are paused.' }
			});
		}
		inFlight++;
		let done = false;
		let abandoned;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(abandoned);
			inFlight--;
			settle();
		};
		// A closed connection does not stop the handler, which may still be
		// talking to the wallet. The action is over only once it ends its response.
		const end = res.end;
		res.end = function (...args) {
			finish();
			return end.apply(this, args);
		};
		res.once('close', () => {
			if (done) return;
			abandoned = setTimeout(finish, abandonedMs);
			abandoned.unref?.();
		});
		next();
	}

	/** Resolves true when idle, or false (and releases) if actions outlast the bound. */
	function hold(timeoutMs = 15000) {
		held = true;
		if (!inFlight) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				drained = drained.filter((entry) => entry !== done);
				held = false;
				resolve(false);
			}, timeoutMs);
			const done = (value) => { clearTimeout(timer); resolve(value); };
			drained.push(done);
		});
	}

	function release() { held = false; }

	return { middleware, hold, release, get inFlight() { return inFlight; }, get held() { return held; } };
}

module.exports = { createUpdateHold, ABANDONED_MS };
