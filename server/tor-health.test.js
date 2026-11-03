'use strict';

/**
 * Run with: npm test (from server/).
 *
 * After a restart the app's Tor needs time to bootstrap and upload the onion's
 * descriptor, and its own connections to the onion can keep failing for a few
 * minutes after that however healthy Tor is. The manager used to probe once
 * at 90 s and then every five minutes, so one early failure kept the "cannot
 * build circuits" warning up for minutes. These pin down when TorHealth lets
 * a probe run and what a result does to the verdict.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
	TorHealth,
	TOR_CIRCUIT_CHECK_MS,
	TOR_CIRCUIT_RETRY_MS,
	TOR_STARTUP_GRACE_MS,
	TOR_UPLOAD_SETTLE_MS
} = require('./tor-health');

const PUBLISHED = 1_000_000;
const AFTER_GRACE = PUBLISHED + TOR_STARTUP_GRACE_MS;

// A TorHealth that has seen the onion published at PUBLISHED and uploaded.
function started() {
	const h = new TorHealth();
	h.shouldProbe(PUBLISHED, { publishedAt: PUBLISHED, uploadedAt: PUBLISHED });
	return h;
}

test('a freshly published onion is not probed before its descriptor is uploaded', () => {
	const h = new TorHealth();
	assert.equal(h.shouldProbe(PUBLISHED, { publishedAt: PUBLISHED, uploadedAt: null }), false);
	assert.equal(h.shouldProbe(AFTER_GRACE - 1, { publishedAt: PUBLISHED, uploadedAt: null }), false);
});

test('the upload gets a moment to reach the other directories before the probe', () => {
	const h = new TorHealth();
	const uploadedAt = PUBLISHED + 10_000;
	assert.equal(h.shouldProbe(uploadedAt, { publishedAt: PUBLISHED, uploadedAt }), false);
	assert.equal(
		h.shouldProbe(uploadedAt + TOR_UPLOAD_SETTLE_MS - 1, { publishedAt: PUBLISHED, uploadedAt }),
		false
	);
	assert.equal(h.shouldProbe(uploadedAt + TOR_UPLOAD_SETTLE_MS, { publishedAt: PUBLISHED, uploadedAt }), true);
});

test('a Tor that never reports an upload is probed once the startup grace is over', () => {
	// Either it really cannot publish, and the probe fails and says so, or the
	// upload went unreported, and the probe clears it. Never a warning from
	// silence alone.
	const h = new TorHealth();
	assert.equal(h.shouldProbe(AFTER_GRACE, { publishedAt: PUBLISHED, uploadedAt: null }), true);
});

test('with no control port to ask, every check probes and two failures warn', () => {
	const h = new TorHealth();
	assert.equal(h.shouldProbe(PUBLISHED, { publishedAt: null, uploadedAt: null }), true);
	assert.equal(h.record(PUBLISHED, false, null), null);
	assert.equal(h.record(PUBLISHED, false, null), false);
});

test('failures while Tor is starting up never warn', () => {
	const h = started();
	for (let t = PUBLISHED; t < AFTER_GRACE; t += TOR_CIRCUIT_RETRY_MS) {
		assert.equal(h.record(t, false, null), null);
	}
	// Still failing once the grace is over is Tor, not a slow start.
	assert.equal(h.record(AFTER_GRACE, false, null), false);
});

test('once a probe has gone through, two failures in a row warn even early on', () => {
	const h = started();
	assert.equal(h.record(PUBLISHED + 30_000, true, null), true);
	assert.equal(h.record(PUBLISHED + 60_000, false, true), true);
	assert.equal(h.record(PUBLISHED + 90_000, false, true), false);
});

test('a success clears the warning and the failure count', () => {
	const h = started();
	h.record(AFTER_GRACE, false, null);
	h.record(AFTER_GRACE, false, null);
	assert.equal(h.record(AFTER_GRACE, true, false), true);
	// A later single miss is again only one.
	assert.equal(h.record(AFTER_GRACE, false, true), true);
});

test('a Tor that restarts on its own later is judged without a grace', () => {
	// Otherwise a Tor crashing every few minutes would never warn.
	const h = started();
	assert.equal(h.record(AFTER_GRACE, true, null), true);
	const republished = AFTER_GRACE + 60_000;
	// No upload yet, and the app is long past starting up: probe right away.
	assert.equal(h.shouldProbe(republished, { publishedAt: republished, uploadedAt: null }), true);
	assert.equal(h.record(republished + 1_000, false, true), true);
	assert.equal(h.record(republished + 16_000, false, true), false);
});

test('a probe that went through ends the startup grace early', () => {
	const h = started();
	assert.equal(h.record(PUBLISHED + 30_000, true, null), true);
	// Tor restarts a minute in: its failures now count.
	const republished = PUBLISHED + 60_000;
	h.shouldProbe(republished, { publishedAt: republished, uploadedAt: republished });
	h.record(republished + 30_000, false, true);
	assert.equal(h.record(republished + 45_000, false, true), false);
});

test('checks come every few minutes while healthy and quickly otherwise', () => {
	const h = started();
	assert.equal(h.nextDelayMs(null), TOR_CIRCUIT_RETRY_MS);
	assert.equal(h.nextDelayMs(false), TOR_CIRCUIT_RETRY_MS);
	assert.equal(h.nextDelayMs(true), TOR_CIRCUIT_CHECK_MS);
	// A healthy Tor that just missed once is checked again soon, so a real
	// outage is confirmed in seconds rather than at the next long interval.
	h.record(AFTER_GRACE, false, true);
	assert.equal(h.nextDelayMs(true), TOR_CIRCUIT_RETRY_MS);
});
