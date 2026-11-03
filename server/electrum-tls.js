'use strict';

/**
 * Electrum TLS certificate verification (beignet #1776, engine 0.31.0).
 *
 * Without it a TLS Electrum connection is encrypted but takes any
 * certificate, because the engine's Electrum client dials with
 * rejectUnauthorized: false. With it the daemon accepts a server only when
 * its certificate chains to a trusted CA and matches the host name, or when
 * its SHA-256 fingerprint is pinned, which is how a self-signed server is
 * accepted. The setting rides on the wallet's Electrum record, and only when
 * it is on, so a record written before it reads exactly as it always did.
 */

// More pins than this is a list of servers, not of one server's certificates.
const MAX_FINGERPRINTS = 8;
// What openssl prints before the fingerprint, pasted along with it.
const OPENSSL_PREFIX = /sha256\s+fingerprint\s*=\s*/gi;

function badElectrum(message) {
	const err = new Error(message);
	err.statusCode = 400;
	err.code = 'BAD_ELECTRUM';
	return err;
}

/**
 * Pinned SHA-256 fingerprints, as lowercase hex without colons. Takes an
 * array or one string separated by commas, spaces or new lines, with or
 * without the colons `openssl x509 -noout -fingerprint -sha256` prints. The
 * daemon refuses to start on a malformed one, so a bad pin is refused here,
 * at save time, instead.
 */
function normalizeFingerprints(input) {
	if (input === undefined || input === null || input === '') return [];
	const items = Array.isArray(input) ? input : String(input).replace(OPENSSL_PREFIX, ' ').split(/[\s,]+/);
	const out = [];
	for (const item of items) {
		if (typeof item !== 'string') throw badElectrum('A pinned certificate must be a SHA-256 fingerprint');
		const raw = item.trim();
		if (!raw) continue;
		const hex = raw.replace(OPENSSL_PREFIX, '').replace(/:/g, '').toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(hex)) {
			throw badElectrum(`"${raw}" is not a SHA-256 fingerprint (64 hex characters, colons optional)`);
		}
		if (!out.includes(hex)) out.push(hex);
	}
	if (out.length > MAX_FINGERPRINTS) throw badElectrum(`At most ${MAX_FINGERPRINTS} pinned certificates`);
	return out;
}

/**
 * The verification fields of a normalized Electrum record. Verification
 * applies to a TLS server only: on plain TCP there is no certificate to
 * check, and the engine would then verify only its public fallbacks.
 */
function normalizeElectrumTls(input, { supported }) {
	if (!input || input.tlsVerify !== true || !input.tls) return {};
	if (!supported) throw badElectrum('The bundled engine cannot verify Electrum certificates');
	const pins = normalizeFingerprints(input.tlsFingerprints);
	return pins.length ? { tlsVerify: true, tlsFingerprints: pins } : { tlsVerify: true };
}

/** The daemon env for a wallet's Electrum record. Off contributes nothing. */
function electrumTlsEnv(electrum) {
	if (!electrum || !electrum.tls || electrum.tlsVerify !== true) return {};
	const env = { BEIGNET_ELECTRUM_TLS_VERIFY: 'true' };
	const pins = Array.isArray(electrum.tlsFingerprints) ? electrum.tlsFingerprints : [];
	if (pins.length) env.BEIGNET_ELECTRUM_TLS_FINGERPRINTS = pins.join(',');
	return env;
}

/**
 * Whether the manager's own tip probe should believe a TLS socket, by the
 * daemon's rule. `socket.authorized` is the CA chain and host name check
 * that Node runs even with rejectUnauthorized off.
 */
function certificateAccepted(socket, electrum) {
	if (!electrum || electrum.tlsVerify !== true) return true;
	if (socket.authorized) return true;
	const pins = Array.isArray(electrum.tlsFingerprints) ? electrum.tlsFingerprints : [];
	if (!pins.length) return false;
	const cert = socket.getPeerCertificate();
	const fingerprint = cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
	return !!fingerprint && pins.includes(fingerprint);
}

module.exports = { MAX_FINGERPRINTS, normalizeFingerprints, normalizeElectrumTls, electrumTlsEnv, certificateAccepted };
