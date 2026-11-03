'use strict';

/**
 * Close the daemon side of a proxied GET when the browser goes away first.
 *
 * http-proxy 1.18.1 ends the upstream request only on the incoming request's
 * 'aborted' event, and Node 16 and later never emit that for a request that
 * finished arriving, which every GET has. A browser that leaves a wallet page
 * therefore leaves its GET /events stream open at the daemon until the daemon
 * restarts. beignet 0.24.0 refuses a 17th open stream per credential with a
 * 429, so after about fifteen page visits the dashboard stopped receiving live
 * events at all.
 *
 * Only GETs are released: they change nothing at the daemon, while a POST whose
 * browser left mid-flight (a payment, a channel open) keeps running there as it
 * always has.
 */
function releaseUpstreamOnClose(proxyReq, req, res) {
	if (req.method !== 'GET') return;
	res.on('close', () => {
		if (!res.writableFinished) proxyReq.destroy();
	});
}

module.exports = { releaseUpstreamOnClose };
