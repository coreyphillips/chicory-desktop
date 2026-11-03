'use strict';

// How often the app's Tor is checked while it looks healthy, and while it does
// not (or is not known yet). The faster cadence is what clears the warning
// within moments of Tor recovering instead of at the next five-minute check.
const TOR_CIRCUIT_CHECK_MS = 5 * 60 * 1000;
const TOR_CIRCUIT_RETRY_MS = 15 * 1000;
// A freshly started Tor has to bootstrap, build introduction circuits and
// upload the onion's descriptor before anyone can reach the onion, our own
// probe included, and even after the upload its own first connections to the
// onion can keep timing out for minutes (up to 3.5 measured on a fast
// machine, with an independent client no quicker). Until a probe has gone
// through or this long has passed since the app first published the onion, a
// failure is the app starting up. A Tor that restarts later on its own gets no
// such grace: that restart is the news, and one that keeps crashing must warn.
const TOR_STARTUP_GRACE_MS = 10 * 60 * 1000;
// The first upload lands on one directory; the rest follow within seconds.
// Until they have the new descriptor some still serve the previous run's,
// whose introduction points died with the old Tor, so give them a moment.
const TOR_UPLOAD_SETTLE_MS = 20 * 1000;
// One failed probe can be a slow circuit; two in a row is Tor.
const TOR_FAILURES_TO_ALARM = 2;

/**
 * Decides when the self-probe through the app's Tor means anything, and what
 * a result says. It keeps no clock of its own: the manager passes in `now` and
 * what the control port reported (see TorControl.publishedAt and uploadedAt),
 * all on the same monotonic clock.
 */
class TorHealth {
	constructor() {
		this.failures = 0;
		// When this manager first saw the onion published.
		this.startedAt = null;
		// A probe has gone through since then.
		this.reached = false;
	}

	_starting(now) {
		return this.startedAt !== null && now - this.startedAt < TOR_STARTUP_GRACE_MS;
	}

	// False while there is no descriptor out there to reach yet. With nothing
	// known about the publish (no control port) it always probes, as before.
	shouldProbe(now, { publishedAt, uploadedAt }) {
		if (publishedAt === null) return true;
		if (this.startedAt === null) this.startedAt = publishedAt;
		if (uploadedAt !== null) return now - uploadedAt >= TOR_UPLOAD_SETTLE_MS;
		return !this._starting(now);
	}

	// The verdict after one probe. A success settles it. A failure counts once
	// it has happened twice in a row, and not at all while the app is starting
	// up and no probe has gone through yet; until then the last verdict stands.
	record(now, ok, previous) {
		if (ok) {
			this.failures = 0;
			this.reached = true;
			return true;
		}
		this.failures += 1;
		if ((!this.reached && this._starting(now)) || this.failures < TOR_FAILURES_TO_ALARM) return previous;
		return false;
	}

	nextDelayMs(verdict) {
		return verdict === true && this.failures === 0 ? TOR_CIRCUIT_CHECK_MS : TOR_CIRCUIT_RETRY_MS;
	}
}

module.exports = {
	TorHealth,
	TOR_CIRCUIT_CHECK_MS,
	TOR_CIRCUIT_RETRY_MS,
	TOR_STARTUP_GRACE_MS,
	TOR_UPLOAD_SETTLE_MS,
	TOR_FAILURES_TO_ALARM
};
