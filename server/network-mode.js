'use strict';

/**
 * Per-wallet network mode (umbrel #193): how a wallet dials its peers and
 * which addresses it announces, the choice Umbrel's LND app calls Tor,
 * Clearnet and Hybrid.
 *
 *   mode       clearnet peers   .onion peers   announced
 *   tor        over Tor         over Tor       the onion
 *   clearnet   direct           over Tor       the public address
 *   hybrid     direct           over Tor       both
 *
 * Pure rules, so the record model and the daemon env can be held in tests
 * without a manager. The engine's half is the proxy scoped to .onion hosts
 * (BEIGNET_TOR_PROXY_ONION_ONLY, beignet #963, engine 0.22.0).
 */
const net = require('net');

const MODES = ['tor', 'clearnet', 'hybrid'];
const DEFAULT_MODE = 'hybrid';

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	return err;
}

/**
 * The mode a record runs in. Records written before the field existed carry
 * `tor` (outbound over Tor, on or off): Tor on reads as the tor mode, Tor off
 * as hybrid, which keeps the direct dials those wallets always made and
 * gives their .onion peers the app's Tor, which the old flag never passed.
 */
function networkMode(rec) {
	if (rec && MODES.includes(rec.networkMode)) return rec.networkMode;
	return rec && rec.tor ? 'tor' : DEFAULT_MODE;
}

/** The mode a request asks for: the field, else the legacy flag, else `fallback`. */
function requestedMode({ networkMode: mode, tor } = {}, fallback) {
	if (mode !== undefined && mode !== null) return String(mode);
	if (tor !== undefined) return tor ? 'tor' : DEFAULT_MODE;
	return fallback;
}

function usesOnion(mode) {
	return mode === 'tor' || mode === 'hybrid';
}

function usesPublic(mode) {
	return mode === 'clearnet' || mode === 'hybrid';
}

// The engine's rule for a DNS name in a node_announcement (parseAnnouncedAddress
// in beignet's gossip messages): lowercase letters, digits, dots and hyphens,
// neither first nor last a dot or hyphen, at most 255 characters.
const DNS_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const DOTTED_QUAD_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * IPv6 as the engine's expandIpv6 (beignet's gossip messages) accepts it:
 * hex groups of one to four digits, eight of them once a single "::" is
 * expanded. Node's net.isIPv6 is wider (zone ids like fe80::1%eth0, embedded
 * IPv4 like ::ffff:192.0.2.1), and a host the engine refuses fails the
 * daemon's boot, so the narrower rule is the one that counts.
 */
function isEngineIpv6(host) {
	if (!host || !host.includes(':')) return false;
	let groups;
	const doubleColon = host.indexOf('::');
	if (doubleColon !== -1) {
		if (host.indexOf('::', doubleColon + 1) !== -1) return false;
		const head = host.slice(0, doubleColon).split(':').filter((g) => g.length > 0);
		const tail = host.slice(doubleColon + 2).split(':').filter((g) => g.length > 0);
		const missing = 8 - head.length - tail.length;
		if (missing < 1) return false;
		groups = [...head, ...new Array(missing).fill('0'), ...tail];
	} else {
		groups = host.split(':');
	}
	return groups.length === 8 && groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

/**
 * The public host a wallet announces, held to what the engine accepts,
 * because a bad entry in BEIGNET_ANNOUNCE_ADDRESSES fails the daemon's boot
 * and a wallet that cannot start is worse than a refused edit. Blank means
 * none. IPv6 is kept bare and bracketed where it meets a port (hostForUri).
 * The port is never part of it: the window the app publishes fixes it.
 */
function normalizePublicHost(input) {
	const raw = input === undefined || input === null ? '' : String(input).trim();
	if (!raw) return '';
	const bad = (why) => httpError(400, 'BAD_PUBLIC_HOST', why);
	if (/\s/.test(raw)) throw bad('A public address cannot contain spaces.');
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw bad('Enter a host, not a URL: leave off the scheme.');
	if (raw.includes('/')) throw bad('Enter a host only, with no path.');
	if (raw.includes('@')) throw bad('Enter a host only: the node id is added for you.');
	let host = raw;
	if (raw.startsWith('[')) {
		const end = raw.indexOf(']');
		if (end === -1) throw bad('An IPv6 address in brackets needs its closing bracket.');
		if (end !== raw.length - 1) throw bad('Enter the host only: the port is fixed by the app.');
		host = raw.slice(1, end);
		if (!isEngineIpv6(host)) throw bad(`"${host}" is not an IPv6 address the node can announce (plain hex groups, no zone id or embedded IPv4).`);
		return host.toLowerCase();
	}
	if (isEngineIpv6(host)) return host.toLowerCase();
	if (host.includes(':')) {
		if (/^[^:]+:\d+$/.test(host)) throw bad('Enter the host only: the port is fixed by the app.');
		if (net.isIPv6(host)) throw bad(`"${host}" is not an IPv6 address the node can announce (plain hex groups, no zone id or embedded IPv4).`);
		throw bad('Enter an IP address or a domain name.');
	}
	if (DOTTED_QUAD_RE.test(host)) {
		if (!net.isIPv4(host)) throw bad(`"${host}" is not a valid IPv4 address.`);
		return host;
	}
	const lower = host.toLowerCase();
	if (lower.endsWith('.onion')) {
		throw bad('The Tor address is published by the app itself; enter your public IP or domain name here.');
	}
	if (lower.length > 255 || !DNS_NAME_RE.test(lower)) throw bad('Enter an IP address or a domain name.');
	return lower;
}

/** A host as it appears before a port: IPv6 in brackets, anything else as is. */
function hostForUri(host) {
	return host && host.includes(':') ? `[${host}]` : host;
}

/**
 * The host port peers off the box dial for a listen port. The compose file
 * publishes the onion's window (the first `windowCount` listen ports from
 * `windowStart`) at `publishedBase`, so a listen port inside the window maps
 * to its place in the published range and one past it has no public port.
 * With no base set (a native run) the listen port itself is reachable.
 */
function publicPort({ listenPort, windowStart, windowCount, publishedBase } = {}) {
	if (!listenPort) return null;
	if (!publishedBase) return listenPort;
	const i = listenPort - windowStart;
	return i >= 0 && i < windowCount ? publishedBase + i : null;
}

/**
 * The addresses for the node_announcement: the onion while it forwards this
 * wallet's listen port, the public host at its published port, or both by
 * mode, and nothing while the wallet does not announce or runs no Lightning.
 */
function announceList({ mode, announce, onchainOnly, onion, listenPort, onionMapped, publicHost, publicPort: pub } = {}) {
	if (!announce || onchainOnly) return [];
	const out = [];
	if (usesOnion(mode) && onion && onionMapped && listenPort) out.push(`${onion}:${listenPort}`);
	if (usesPublic(mode) && publicHost && pub) out.push(`${hostForUri(publicHost)}:${pub}`);
	return out;
}

/**
 * The daemon's proxy env for a mode. Tor mode sends every peer through the
 * app's Tor. Clearnet and Hybrid keep the proxy for .onion peers and dial
 * clearnet directly, which is the engine's onion-only scope; an engine
 * without it gets no proxy for those modes at all, the direct dials they
 * always made, rather than a surprise trip through Tor. The scope is never
 * sent alone: the engine refuses to start on it without a proxy.
 */
function proxyEnv({ mode, torProxy, scopeSupported } = {}) {
	if (!torProxy) return {};
	if (mode === 'tor') return { BEIGNET_TOR_PROXY: torProxy };
	if (!scopeSupported) return {};
	return { BEIGNET_TOR_PROXY: torProxy, BEIGNET_TOR_PROXY_ONION_ONLY: 'true' };
}

/** What a record's network choice refuses, before anything is written. */
function validateNetworkChoice({ mode, publicHost, onchainOnly } = {}) {
	if (!MODES.includes(mode)) {
		throw httpError(400, 'BAD_NETWORK_MODE', `Unknown network mode "${mode}". Choose Tor, Clearnet or Hybrid.`);
	}
	if (mode === 'clearnet' && !publicHost && !onchainOnly) {
		throw httpError(
			400,
			'PUBLIC_HOST_REQUIRED',
			'Clearnet needs a public address, your public IP or domain name, so peers have somewhere to reach this wallet. Choose Hybrid to keep the Tor address without one.'
		);
	}
}

/** Iroh is an opt-in listener independent of the routing mode. */
function normalizeIroh(input, { existing, available = false, onchainOnly = false } = {}) {
	const value = input === undefined ? (existing || { enabled: false }) : input;
	const bad = (message) => httpError(400, 'BAD_IROH', message);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Iroh settings must be an object.');
	if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw bad('Iroh enabled must be true or false.');
	const enabled = !onchainOnly && (value.enabled ?? existing?.enabled ?? false);
	if (enabled && !available && input !== undefined) {
		throw httpError(400, 'IROH_UNSUPPORTED', 'The bundled engine does not support Iroh.');
	}
	const relays = !enabled || value.relays === undefined ? existing?.relays : value.relays === null ? undefined : value.relays;
	if (relays !== undefined && (!Array.isArray(relays) || relays.length > 16)) throw bad('Provide at most 16 relay URLs.');
	const normalized = relays?.map((relay) => {
		if (typeof relay !== 'string' || relay.length > 2048 || /[\s,]/.test(relay)) throw bad('Relay URLs cannot contain spaces or commas.');
		let url;
		try { url = new URL(relay); } catch (_) { throw bad('Enter a valid HTTP or HTTPS relay URL.'); }
		if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
			throw bad('Relay URLs must use HTTP or HTTPS without credentials, query parameters or fragments.');
		}
		return url.href;
	});
	return { enabled, ...(normalized?.length ? { relays: [...new Set(normalized)] } : {}) };
}

function irohEnv(rec, available) {
	if (!available || rec.onchainOnly || rec.iroh?.enabled !== true) return {};
	return {
		BEIGNET_IROH: 'true',
		BEIGNET_IROH_DISCOVERY: rec.iroh.relays?.length ? 'false' : 'true',
		...(rec.iroh.relays?.length ? { BEIGNET_IROH_RELAYS: rec.iroh.relays.join(',') } : {})
	};
}

module.exports = {
	normalizeIroh,
	irohEnv,
	MODES,
	DEFAULT_MODE,
	isEngineIpv6,
	networkMode,
	requestedMode,
	usesOnion,
	usesPublic,
	normalizePublicHost,
	hostForUri,
	publicPort,
	announceList,
	proxyEnv,
	validateNetworkChoice
};
