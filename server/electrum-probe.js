'use strict';

/**
 * Asking an Electrum server about itself.
 *
 * The dashboard offers one-click presets for the Electrum servers an Umbrel
 * may run and lets a user type any other, such as another Umbrel on the home
 * network. Whether a preset is installed, what software answers, which chain
 * it serves and how far it has synced are all one short conversation away, so
 * this module holds that conversation: one TCP or TLS connection, a few
 * JSON-RPC requests, the replies filed by id, and a hard deadline. Discovery,
 * the Test button and the wrong-chain guard in the manager all read the same
 * result shape from here, and the manager's own tip probe is one request
 * through the same socket code.
 */

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { certificateAccepted } = require('./electrum-tls');

// A server that does not answer at all in this long is reported as such. The
// same bound the manager uses before starting a wallet.
const PROBE_TIMEOUT_MS = 3000;
// How long a probe result stands in for a fresh one. Discover, then Test,
// then Save can each ask about the same server within seconds; one
// connection answers all three, and a wallet saved right after the dashboard
// probed its server does not wait for the probe again.
const CACHE_TTL_MS = 10000;
// The most a server may send in one conversation. Three replies are a few
// kilobytes; a peer that keeps sending without a newline is not answering,
// and the buffer must not grow until the deadline, which an untrusted
// address could otherwise use to tie up the manager's memory.
const MAX_REPLY_BYTES = 1 << 20;

// Genesis block hashes, as `server.features.genesis_hash` reports them
// (display order), to the network name the manager uses. testnet4 is listed
// apart from testnet because beignet's `testnet` is testnet3: a testnet4
// server is a real mismatch, and the message should say which it is.
const GENESIS_CHAINS = {
	'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f': 'mainnet',
	'000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943': 'testnet',
	'00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043': 'testnet4',
	'00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6': 'signet',
	'0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206': 'regtest'
};

/** The network a genesis hash names, or 'unknown' for anything else. */
function chainOfGenesis(hash) {
	if (typeof hash !== 'string') return 'unknown';
	return GENESIS_CHAINS[hash.trim().toLowerCase()] || 'unknown';
}

/**
 * A block header's hash as the chain names it: double SHA-256 of its 80
 * bytes, in display (reversed) order. Null for anything that is not one
 * header in hex.
 */
function headerHash(hex) {
	if (typeof hex !== 'string' || !/^[0-9a-f]{160}$/i.test(hex)) return null;
	const once = crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest();
	return Buffer.from(crypto.createHash('sha256').update(once).digest()).reverse().toString('hex');
}

function codedError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

/**
 * Open one connection to an Electrum server, send every request, and resolve
 * once each has been answered: `{ replies: { [id]: message }, certificate }`.
 *
 * Rejects with code TLS_REJECTED when the wallet's verification rule
 * (electrum-tls.js) would refuse the certificate, carrying what was seen so
 * the user can pin it; with code TIMEOUT when the deadline passes, carrying
 * the replies that did arrive; with code TLS_HANDSHAKE when the TCP
 * connection was made but TLS never came up (what a plaintext server looks
 * like to a TLS client); with code TLS_WANTED when a plaintext request was
 * answered with a TLS record, or with nothing at all before the connection
 * was closed or reset, which is how a TLS server treats a plaintext client
 * (Node's own TLS server closes without sending the alert); with
 * BAD_REPLY for anything else that is not Electrum; with CLOSED, carrying
 * the replies so far, when the server hung up early; and with the socket's
 * own error otherwise. Every error says in `connected` whether the TCP
 * connection was ever made, which is what separates a server that is there
 * from an address where nothing is.
 *
 * The deadline is a timer of its own and not only `socket.setTimeout`, which
 * measures idleness: a server that trickles one byte every second would
 * otherwise never time out.
 *
 * `transport` is the pair of modules that open sockets, so a test can hand
 * in one whose connection never completes.
 */
function electrumRequests(electrum, requests, { timeoutMs = PROBE_TIMEOUT_MS, transport = { net, tls } } = {}) {
	const { host, port, tls: useTls } = electrum;
	return new Promise((resolve, reject) => {
		let done = false;
		let buf = '';
		let received = 0;
		let connected = false;
		let secured = !useTls;
		let socket;
		let timer = null;
		const replies = {};
		const pending = new Set(requests.map((r) => r.id));
		let certificate = null;
		const finish = (err, value) => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			try {
				socket.destroy();
			} catch (_) {
				/* already gone */
			}
			if (err) {
				err.connected = connected;
				reject(err);
			} else resolve(value);
		};
		const timedOut = () => {
			const err = codedError('TIMEOUT', `No answer from ${host}:${port} within ${timeoutMs} ms`);
			err.replies = replies;
			err.certificate = certificate;
			finish(err);
		};
		// A TLS client that connected and then failed before the handshake
		// finished met something that does not speak TLS, in all likelihood a
		// plaintext Electrum server: the wrong-version and unexpected-message
		// errors, a reset, or a plain close all land here.
		const handshakeFailed = (cause) => {
			const err = codedError('TLS_HANDSHAKE', `${host}:${port} accepted the connection but did not complete a TLS handshake`);
			err.cause = cause;
			finish(err);
		};
		try {
			socket = useTls
				? transport.tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false })
				: transport.net.connect({ host, port });
		} catch (err) {
			return reject(err);
		}
		timer = setTimeout(timedOut, timeoutMs);
		socket.setTimeout(timeoutMs);
		// A TLS socket raises 'connect' for the TCP connection and
		// 'secureConnect' once the handshake is done; a plain one only the first.
		socket.once('connect', () => {
			connected = true;
		});
		socket.once(useTls ? 'secureConnect' : 'connect', () => {
			secured = true;
			if (useTls) {
				const cert = socket.getPeerCertificate();
				certificate = {
					authorized: !!socket.authorized,
					fingerprint: cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : null,
					accepted: certificateAccepted(socket, electrum)
				};
				// A wallet that verifies its server's certificate would not talk
				// to this one, so nothing is asked of it either.
				if (!certificate.accepted) {
					const err = codedError('TLS_REJECTED', `The certificate of ${host}:${port} is not trusted`);
					err.certificate = certificate;
					return finish(err);
				}
			}
			if (!pending.size) return finish(null, { replies, certificate });
			for (const r of requests) {
				socket.write(`${JSON.stringify({ id: r.id, method: r.method, params: r.params || [] })}\n`);
			}
		});
		socket.on('data', (chunk) => {
			// A TLS record (handshake 0x16 or alert 0x15) as the first byte of
			// a plaintext conversation is a TLS server answering a client that
			// did not tick TLS; no JSON starts that way.
			if (received === 0 && !useTls && chunk.length && (chunk[0] === 0x16 || chunk[0] === 0x15)) {
				return finish(codedError('TLS_WANTED', `${host}:${port} answered with TLS, not plaintext`));
			}
			received += chunk.length;
			if (received > MAX_REPLY_BYTES) {
				return finish(codedError('BAD_REPLY', `${host}:${port} sent more than ${MAX_REPLY_BYTES} bytes without finishing an answer`));
			}
			buf += chunk.toString('utf8');
			// Replies are newline-delimited JSON, possibly several per chunk and
			// possibly one across two chunks, in any order.
			let nl;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg;
				try {
					msg = JSON.parse(line);
				} catch (_) {
					return finish(codedError('BAD_REPLY', `${host}:${port} answered something other than JSON`));
				}
				if (msg && pending.has(msg.id)) {
					replies[msg.id] = msg;
					pending.delete(msg.id);
				}
			}
			if (!pending.size) finish(null, { replies, certificate });
		});
		socket.once('timeout', timedOut);
		// A plaintext client whose requests were met with a close or a reset
		// and not one byte met a server that was waiting for a TLS handshake.
		const silentlyDropped = () => !useTls && connected && received === 0;
		const tlsWanted = () => finish(codedError('TLS_WANTED', `${host}:${port} dropped a plaintext request without a word, as a TLS server does`));
		socket.once('error', (err) => {
			if (useTls && connected && !secured) return handshakeFailed(err);
			if (silentlyDropped() && err && err.code === 'ECONNRESET') return tlsWanted();
			finish(err);
		});
		socket.once('close', () => {
			if (!pending.size) return;
			if (useTls && connected && !secured) return handshakeFailed(null);
			if (silentlyDropped()) return tlsWanted();
			const err = codedError('CLOSED', `${host}:${port} closed the connection`);
			err.replies = replies;
			err.certificate = certificate;
			finish(err);
		});
	});
}

const EMPTY = {
	reachable: false,
	software: null,
	protocol: null,
	chain: 'unknown',
	genesisHash: null,
	height: null,
	certificate: null,
	error: null
};

function readReplies(replies) {
	const out = {};
	const version = replies[1] && Array.isArray(replies[1].result) ? replies[1].result : null;
	if (version) {
		out.software = typeof version[0] === 'string' ? version[0] : null;
		out.protocol = typeof version[1] === 'string' ? version[1] : null;
	}
	// The chain is the one server.features names, or failing that the one
	// block 0's header hashes to. Not every server answers server.features
	// (Bitkit's closes the connection over it), but every one serves headers.
	const features = replies[4] && replies[4].result && typeof replies[4].result === 'object' ? replies[4].result : null;
	const claimed = features && typeof features.genesis_hash === 'string' ? features.genesis_hash.toLowerCase() : null;
	const genesisHash = claimed || headerHash(replies[2] && replies[2].result);
	if (genesisHash) {
		out.genesisHash = genesisHash;
		out.chain = chainOfGenesis(genesisHash);
	}
	const tip = replies[3] && replies[3].result;
	if (tip && typeof tip.height === 'number') out.height = tip.height;
	return out;
}

/**
 * Everything the dashboard shows about a server, in one `ProbeResult`:
 *
 *   { reachable, software, protocol, chain, genesisHash, height,
 *     certificate: null | { accepted, authorized, fingerprint },
 *     error: null | 'unreachable' | 'timeout' | 'tls-rejected' | 'tls-mismatch'
 *          | 'bad-reply',
 *     probedAt }
 *
 * `reachable` means the TCP connection was made: something is listening at
 * that address, whatever it turned out to be. 'tls-mismatch' is a server
 * that is there but on the other side of the TLS switch from what was asked
 * (a plaintext server asked over TLS, or a TLS server asked in plaintext),
 * the likeliest mistake with these fields.
 *
 * `server.version` goes first because some servers refuse every other
 * method until the client has introduced itself, and `server.features`
 * last because a server that does not offer it may hang up when asked,
 * and by then the rest has been answered. Never throws: a server that
 * cannot be reached is a result, not a failure.
 */
async function probeElectrum(electrum, { timeoutMs = PROBE_TIMEOUT_MS, transport } = {}) {
	const requests = [
		{ id: 1, method: 'server.version', params: ['beignet-umbrel', '1.4'] },
		{ id: 2, method: 'blockchain.block.header', params: [0] },
		{ id: 3, method: 'blockchain.headers.subscribe', params: [] },
		{ id: 4, method: 'server.features', params: [] }
	];
	const probedAt = Date.now();
	try {
		const { replies, certificate } = await electrumRequests(electrum, requests, { timeoutMs, transport });
		return { ...EMPTY, reachable: true, certificate, ...readReplies(replies), probedAt };
	} catch (err) {
		const partial = err.replies ? readReplies(err.replies) : {};
		if (err.code === 'TLS_REJECTED') {
			return { ...EMPTY, reachable: true, certificate: err.certificate, error: 'tls-rejected', probedAt };
		}
		if (err.code === 'TIMEOUT') {
			// A slow server may have answered some of it; keep what arrived. A
			// connection that never completed is nothing at that address, not a
			// server that kept quiet.
			return { ...EMPTY, reachable: !!err.connected, certificate: err.certificate || null, ...partial, error: 'timeout', probedAt };
		}
		if (err.code === 'TLS_HANDSHAKE' || err.code === 'TLS_WANTED') {
			return { ...EMPTY, reachable: true, error: 'tls-mismatch', probedAt };
		}
		if (err.code === 'CLOSED') {
			// A server that answered and then hung up before the last reply has
			// still said what it is; what it said stands. One that said nothing
			// before closing did not speak Electrum.
			if (Object.keys(partial).length) {
				return { ...EMPTY, reachable: true, certificate: err.certificate || null, ...partial, probedAt };
			}
			return { ...EMPTY, reachable: true, error: 'bad-reply', probedAt };
		}
		if (err.code === 'BAD_REPLY') {
			return { ...EMPTY, reachable: true, error: 'bad-reply', probedAt };
		}
		return { ...EMPTY, reachable: !!err.connected, error: 'unreachable', probedAt };
	}
}

const cache = new Map();

function cacheKey(electrum) {
	const pins = Array.isArray(electrum.tlsFingerprints) ? electrum.tlsFingerprints.join('+') : '';
	return `${electrum.host}:${electrum.port}:${electrum.tls ? 1 : 0}:${electrum.tlsVerify === true ? 1 : 0}:${pins}`;
}

/**
 * `probeElectrum` behind a short cache. A probe in flight is shared with
 * every caller that asks meanwhile; `refresh` throws the cached one away.
 * Entries past their time are dropped whenever a new one is filed, so a
 * run of Test requests against ever-different addresses does not leave a
 * result behind for each of them.
 */
function cachedProbe(electrum, { ttlMs = CACHE_TTL_MS, refresh = false, timeoutMs } = {}) {
	const key = cacheKey(electrum);
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && !refresh && now - hit.at < ttlMs) return hit.promise;
	if (hit && refresh && hit.inflight) return hit.promise;
	for (const [k, e] of cache) {
		if (!e.inflight && now - e.at >= e.ttlMs) cache.delete(k);
	}
	const entry = { at: now, ttlMs, inflight: true, promise: null };
	entry.promise = probeElectrum(electrum, { timeoutMs }).then((result) => {
		entry.inflight = false;
		return result;
	});
	cache.set(key, entry);
	return entry.promise;
}

function clearProbeCache() {
	cache.clear();
}

/** How many results the cache holds, for tests. */
function probeCacheSize() {
	return cache.size;
}

/**
 * Every preset probed at once, each within its own bound, so the answer
 * lands in about one timeout no matter how many presets there are.
 */
async function discoverServers(presets, opts = {}) {
	const at = Date.now();
	const servers = await Promise.all(presets.map((p) => cachedProbe(p, opts).then((r) => ({ ...p, ...r }))));
	return { at, servers };
}

module.exports = {
	PROBE_TIMEOUT_MS,
	CACHE_TTL_MS,
	MAX_REPLY_BYTES,
	GENESIS_CHAINS,
	chainOfGenesis,
	headerHash,
	electrumRequests,
	probeElectrum,
	cachedProbe,
	clearProbeCache,
	probeCacheSize,
	discoverServers
};
