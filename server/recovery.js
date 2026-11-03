'use strict';

/**
 * Recovery Protocol rules the manager enforces before a daemon is spawned
 * (docs/RECOVERY-PROTOCOL.md section 8 in the beignet repository). Kept
 * pure so the contract can be tested without a registry or a process.
 *
 * The daemon validates everything here again and refuses to start on a
 * mistake, but a refusal at spawn time only ever shows up in the Logs tab
 * after a restart loop. Validating in the manager turns the same mistake
 * into a 400 on the request that made it.
 */

const RECOVERY_MODES = ['off', 'peer-storage', 'async-remote', 'quorum'];
const GUARDIAN_SET_SIZE = 3;
// The only profile protocol v1 accepts (2-of-3, crash-fault). The daemon
// defaults to it; it is passed explicitly so the wallet's env reads whole.
const RECOVERY_PROFILE = 'crash-v1';

function isRecoveryMode(mode) {
	return RECOVERY_MODES.includes(mode);
}

function isGuardianMode(mode) {
	return mode === 'async-remote' || mode === 'quorum';
}

/** A Lightning node URI, `<66-hex compressed node id>@host:port`, as a wallet pastes it. */
const NODE_URI = /^([0-9a-fA-F]{66})@(\[[0-9a-fA-F:]+\]|[^:\s@/]+):(\d{1,5})$/;

/** True when `input` is a plain node URI rather than a guardian entry. */
function isNodeUri(input) {
	return NODE_URI.test(String(input || '').trim());
}

/**
 * One guardian entry, `<64-hex-x-only-pubkey>@<url>`, where the URL is
 * `http(s)://...` for a guardian service or `bolt8://<66-hex node id>@host:port`
 * for a guardian hosted by a beignet node (beignet #699, wire 2.7). Returns
 * the normalized entry (lowercase keys, URL as given or canonical for bolt8)
 * or throws with a message that names what is wrong. Whether the keys are
 * valid secp256k1 points is left to the daemon; the manager has no curve
 * library and a key copied from a guardian is a point.
 */
function parseGuardianEntry(input) {
	const entry = String(input || '').trim();
	const at = entry.indexOf('@');
	if (at < 0) {
		throw new Error(
			`guardian entry "${entry}" is missing the pubkey@url separator; expected <64-hex-x-only-pubkey>@<url>`
		);
	}
	const pubkey = entry.slice(0, at);
	const url = entry.slice(at + 1);
	if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
		throw new Error(`guardian entry "${entry}" does not start with a 64-hex-character x-only pubkey`);
	}
	let parsed;
	try {
		parsed = new URL(url);
	} catch (_) {
		throw new Error(`guardian URL "${url}" is not a valid URL`);
	}
	if (parsed.protocol === 'bolt8:') {
		// The userinfo position carries the host node's id, by design (the key
		// BOLT 8 authenticates the server by); a credential never rides here.
		if (!/^[0-9a-fA-F]{66}$/.test(parsed.username) || parsed.password !== '') {
			throw new Error(`bolt8 guardian URL "${url}" must carry a 66-hex node id before the @, and nothing else`);
		}
		if (!parsed.hostname || parsed.port === '') {
			throw new Error(`bolt8 guardian URL "${url}" needs a host and a port`);
		}
		if (parsed.pathname && parsed.pathname !== '/') {
			throw new Error(`bolt8 guardian URL "${url}" must not carry a path`);
		}
		const canonical = `bolt8://${parsed.username.toLowerCase()}@${parsed.hostname.toLowerCase()}:${parsed.port}`;
		return { pubkey: pubkey.toLowerCase(), url: canonical, entry: `${pubkey.toLowerCase()}@${canonical}`, bolt8: true };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`guardian URL "${url}" must use http, https or bolt8`);
	}
	return { pubkey: pubkey.toLowerCase(), url, entry: `${pubkey.toLowerCase()}@${url}`, bolt8: false };
}

/**
 * The app-level list of guardians, which is allowed to be unfinished: up to
 * three distinct, well formed entries. Guardians are collected one at a
 * time (a set often arrives over days, one server at a time), so a partial
 * list is a saveable draft rather than an error. Returns the normalized
 * entries.
 */
function validateGuardianDraft(list) {
	if (!Array.isArray(list)) throw new Error('guardians must be a list');
	const entries = list.map((g) => String(g || '').trim()).filter((g) => g.length > 0);
	if (entries.length > GUARDIAN_SET_SIZE) {
		throw new Error(`a guardian set is at most ${GUARDIAN_SET_SIZE} entries; got ${entries.length}`);
	}
	const parsed = entries.map(parseGuardianEntry);
	const keys = new Set(parsed.map((g) => g.pubkey));
	if (keys.size !== parsed.length) {
		throw new Error('guardian entries must have distinct pubkeys');
	}
	return parsed.map((g) => g.entry);
}

/**
 * A guardian set at the point a wallet uses it is all or nothing: an empty
 * list (no guardians configured) or exactly three distinct entries, the
 * crash-v1 profile's only shape. Returns the normalized entries.
 */
function validateGuardianSet(list) {
	const entries = validateGuardianDraft(list);
	if (entries.length === 0) return [];
	if (entries.length !== GUARDIAN_SET_SIZE) {
		throw new Error(
			`a guardian set is exactly ${GUARDIAN_SET_SIZE} entries (crash-v1 is 2-of-3); got ${entries.length}`
		);
	}
	return entries;
}

/** True when two guardian sets name the same keys, in any order. */
function sameGuardianSet(a, b) {
	const keys = (list) =>
		(list || [])
			.map((g) => String(g).slice(0, 64).toLowerCase())
			.sort()
			.join(',');
	return keys(a) === keys(b);
}

/**
 * The daemon env fragment for a wallet record's recovery field. Off (or an
 * absent field) contributes nothing, so a daemon that predates the feature
 * sees the env it always saw. Guardians ride only with the guardian modes:
 * the daemon refuses a guardian list under off or peer-storage.
 */
function recoveryEnv(recovery) {
	const mode = recovery && recovery.mode;
	if (!mode || mode === 'off' || !isRecoveryMode(mode)) return {};
	const env = { BEIGNET_RECOVERY_MODE: mode };
	if (isGuardianMode(mode)) {
		env.BEIGNET_RECOVERY_GUARDIANS = (recovery.guardians || []).join(',');
		env.BEIGNET_RECOVERY_PROFILE = RECOVERY_PROFILE;
	}
	// The daemon applying a peer-storage checkpoint by itself on an empty
	// database (beignet #690). Peer storage only: the daemon refuses to
	// start with the flag under any other mode, so it never rides there.
	if (mode === 'peer-storage' && recovery.autoApply === true) {
		env.BEIGNET_RECOVERY_AUTO_APPLY = 'true';
	}
	return env;
}

module.exports = {
	RECOVERY_MODES,
	GUARDIAN_SET_SIZE,
	RECOVERY_PROFILE,
	isRecoveryMode,
	isGuardianMode,
	isNodeUri,
	parseGuardianEntry,
	validateGuardianDraft,
	validateGuardianSet,
	sameGuardianSet,
	recoveryEnv
};
