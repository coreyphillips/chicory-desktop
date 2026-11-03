'use strict';

const fs = require('fs');
const dns = require('dns').promises;

/**
 * Source-restricts the manager's HTTP API to whatever fronts it with Umbrel's
 * single sign-on.
 *
 * The manager listens on 0.0.0.0 on Umbrel's shared app network, where every
 * installed app can reach it by name/IP. Only the component that fronts the
 * browser with single sign-on should ever call the manager: it terminates the
 * browser connection and opens a fresh proxied connection, so legitimate
 * requests arrive with that component's own address as their TCP source. This
 * guard rejects any request whose source is not that component or loopback, so
 * a co-installed (or compromised) app on the shared network cannot drive the
 * wallet API (including the fund-moving proxied daemon routes) directly,
 * bypassing the sign-on.
 *
 * That component depends on the umbrelOS version:
 *  - Legacy Umbrel and umbrelOS 1.x run an app_proxy container per app. It is
 *    resolved by Docker DNS and re-resolved periodically because its IP can
 *    change across restarts; {all:true} captures every network the container
 *    is on, so whichever IP the connection actually uses is covered.
 *  - umbrelOS 2 removed that container: umbreld's app gateway, on the host,
 *    connects straight to this container's IP, so its requests come from the
 *    Docker bridge host. That address is the gateway of the container's
 *    default route, read from /proc/net/route. The rbitcoin settings service
 *    trusts the same address for the same reason.
 * Both are trusted on every system. On the older ones the bridge host is only
 * Umbrel itself, which owns the app's data anyway, and apps that share the
 * host's network.
 *
 * It leans on the real TCP peer (req.socket.remoteAddress), never a spoofable
 * X-Forwarded-For header.
 *
 * Safeguards against ever locking the user out of their own wallet:
 *  - Set BEIGNET_TRUST_ALL=1 to disable the guard entirely.
 *  - Until the guard knows which of the two fronts this box, it fails open
 *    (allows) so a transient DNS problem cannot brick the dashboard. It knows
 *    once app_proxy resolves, or once Docker DNS answers for this container's
 *    own name but not for app_proxy, which means there is no app_proxy here.
 *  - A request from an unknown source re-resolves before it is refused, so an
 *    app_proxy that starts after the manager is let in on its first request.
 *
 * `guard.strict` is the same guard without the fail-open window, for routes
 * where failing open is the worse outcome: an unresolved app_proxy costs a
 * dashboard feature, where a bulk seed export to a co-installed app costs the
 * coins. It admits loopback, a resolved app_proxy and the bridge host, nothing
 * else.
 */

// app_proxy is reachable under a few app-scoped names depending on the umbrelOS
// version and container-name scheme (underscore vs hyphen). We resolve all of
// them and never the bare "app_proxy": that alias is shared by every app on the
// network, so it would be ambiguous. APP_PROXY_HOST overrides with a single name.
const APP_ID = 'chicory-wallet';
const PROXY_HOSTS = process.env.APP_PROXY_HOST
	? [process.env.APP_PROXY_HOST]
	: [`app_proxy_${APP_ID}`, `${APP_ID}_app_proxy_1`, `${APP_ID}-app_proxy-1`];
// This container's own name, pinned by container_name in docker-compose.yml.
// It resolving while app_proxy does not is what tells umbrelOS 2 apart from a
// DNS outage.
const SELF_HOST = `${APP_ID}_manager_1`;
const REFRESH_MS = 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normalizeIp(ip) {
	if (!ip) return ip;
	// Strip an IPv4-mapped IPv6 prefix (::ffff:10.21.0.5 -> 10.21.0.5).
	return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isEnabled() {
	const v = String(process.env.BEIGNET_TRUST_ALL || '').toLowerCase();
	return !(v === '1' || v === 'true');
}

function forbidden(res) {
	return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
}

/**
 * The gateways of this container's default routes, which is where umbrelOS 2's
 * app gateway connects from. /proc/net/route holds each address as eight hex
 * digits, little-endian; a default route has destination and mask 0 and both
 * the up and gateway flags.
 */
function hostGateways(routeFile = '/proc/net/route') {
	const found = new Set();
	let lines;
	try {
		lines = fs.readFileSync(routeFile, 'utf8').split('\n').slice(1);
	} catch (_) {
		return found;
	}
	for (const line of lines) {
		const f = line.trim().split(/\s+/);
		if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
		if (!/^[0-9a-f]{8}$/i.test(f[2]) || (parseInt(f[3], 16) & 3) !== 3) continue;
		const ip = f[2]
			.match(/../g)
			.reverse()
			.map((b) => parseInt(b, 16))
			.join('.');
		if (ip !== '0.0.0.0') found.add(ip);
	}
	return found;
}

async function lookupAll(host) {
	const results = await dns.lookup(host, { all: true });
	return results.map((r) => r.address);
}

function createAccessGuard({ log = () => {}, lookup = lookupAll, gateways = hostGateways } = {}) {
	if (!isEnabled()) {
		log('access-control: BEIGNET_TRUST_ALL set; manager API is not source-restricted');
		const open = (req, res, next) => next();
		open.strict = open;
		open.ready = Promise.resolve();
		return open;
	}

	let proxies = new Set();
	let allowed = new Set();
	let known = false;
	let warnedFailOpen = false;
	let inflight = null;

	async function resolves(host) {
		try {
			return (await lookup(host)).map(normalizeIp);
		} catch (_) {
			/* this name is not resolvable on this system */
			return [];
		}
	}

	async function resolve() {
		const found = new Set();
		for (const host of PROXY_HOSTS) {
			for (const ip of await resolves(host)) found.add(ip);
		}
		/* if none resolved, keep the last good set */
		if (found.size) {
			if (!proxies.size) {
				const list = [...found].join(', ');
				log(`access-control: restricting manager API to app_proxy (${list}), the host and loopback`);
			}
			proxies = found;
		}
		const hosts = gateways();
		allowed = new Set([...proxies, ...hosts]);
		if (known) return;
		if (proxies.size) {
			known = true;
		} else if (hosts.size && (await resolves(SELF_HOST)).length) {
			known = true;
			const list = [...hosts].join(', ');
			log(`access-control: no app_proxy; restricting manager API to umbrelOS's app gateway (${list}) and loopback`);
		}
	}

	// Concurrent misses share one lookup rather than each starting their own.
	function refresh() {
		if (!inflight) {
			inflight = resolve()
				.catch(() => {})
				.finally(() => {
					inflight = null;
				});
		}
		return inflight;
	}

	const ready = refresh();
	const timer = setInterval(refresh, REFRESH_MS);
	if (timer.unref) timer.unref();

	const admits = (ip) => LOOPBACK.has(ip) || allowed.has(ip);

	function accessGuard(req, res, next) {
		const ip = normalizeIp(req.socket && req.socket.remoteAddress);
		if (admits(ip)) return next();
		if (!known) {
			// Not yet sure what fronts this box: allow, but warn once and keep
			// trying, so a resolution problem degrades to the old (open) behavior
			// instead of locking the user out.
			if (!warnedFailOpen) {
				log('access-control: app_proxy not resolved yet; allowing all sources until it resolves');
				warnedFailOpen = true;
			}
			refresh();
			return next();
		}
		// Re-resolve before refusing, in case app_proxy just started or its IP
		// just changed.
		refresh().then(() => (admits(ip) ? next() : forbidden(res)), next);
	}

	accessGuard.strict = function strictGuard(req, res, next) {
		const ip = normalizeIp(req.socket && req.socket.remoteAddress);
		if (admits(ip)) return next();
		refresh().then(() => {
			if (admits(ip)) return next();
			log(`access-control: refused ${req.method} ${req.originalUrl || req.url} from ${ip}`);
			return forbidden(res);
		}, next);
	};

	// The first lookup, for tests that need the guard settled before they call it.
	accessGuard.ready = ready;

	return accessGuard;
}

module.exports = { createAccessGuard, normalizeIp, hostGateways };
