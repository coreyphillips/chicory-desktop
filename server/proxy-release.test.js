'use strict';

/**
 * Run with: npm test (from server/).
 *
 * The dashboard reaches each daemon through http-proxy-middleware, which never
 * closed the daemon side of a GET /events stream when the browser left, so
 * every wallet-page visit left one stream open. beignet 0.24.0 caps open
 * streams per credential at 16, so the leak ended live events after about
 * fifteen visits. These tests put the same proxy in front of a stand-in daemon
 * that counts its open streams.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { releaseUpstreamOnClose } = require('./proxy-release');

// The daemon's own per-credential cap, which the leaked streams used to reach.
const DAEMON_STREAM_CAP = 16;

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(check, what, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function setup(t) {
	const daemon = { open: 0, peak: 0 };
	const daemonServer = http.createServer((req, res) => {
		if (req.method === 'GET' && req.url === '/events') {
			daemon.open += 1;
			daemon.peak = Math.max(daemon.peak, daemon.open);
			req.on('close', () => {
				daemon.open -= 1;
			});
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
			res.write(': connected\n\n');
			return;
		}
		if (req.method === 'GET' && req.url === '/info') {
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ ok: true, data: { auth: req.headers.authorization } }));
			return;
		}
		if (req.method === 'POST' && req.url === '/echo') {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({ ok: true, data: JSON.parse(body) }));
			});
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	const daemonPort = await listen(daemonServer);

	// The same options the manager's proxy uses, pointed at the stand-in.
	const app = express();
	app.use(
		'/wallets/:id/api',
		createProxyMiddleware({
			target: `http://127.0.0.1:${daemonPort}`,
			changeOrigin: true,
			ws: false,
			logLevel: 'silent',
			pathRewrite: { '^/wallets/[^/]+/api': '' },
			onProxyReq: (proxyReq, req, res) => {
				proxyReq.setHeader('Authorization', 'Bearer test-token');
				releaseUpstreamOnClose(proxyReq, req, res);
			}
		})
	);
	const proxyServer = http.createServer(app);
	const proxyPort = await listen(proxyServer);

	t.after(() => {
		proxyServer.closeAllConnections();
		daemonServer.closeAllConnections();
		proxyServer.close();
		daemonServer.close();
	});
	return { daemon, proxyPort };
}

/** Open a stream through the proxy, wait for the daemon's first line, then leave. */
function visitAndLeave(proxyPort) {
	return new Promise((resolve, reject) => {
		const req = http.get(
			{ host: '127.0.0.1', port: proxyPort, path: '/wallets/w1/api/events', agent: false },
			(res) => {
				assert.equal(res.statusCode, 200);
				res.setEncoding('utf8');
				res.once('data', (chunk) => {
					assert.match(chunk, /: connected/);
					req.destroy();
					resolve();
				});
			}
		);
		req.on('error', (err) => {
			if (!req.destroyed) reject(err);
		});
	});
}

function request(proxyPort, method, path, body) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const req = http.request(
			{
				host: '127.0.0.1',
				port: proxyPort,
				path,
				method,
				agent: false,
				headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
			},
			(res) => {
				let text = '';
				res.setEncoding('utf8');
				res.on('data', (c) => (text += c));
				res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
			}
		);
		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

test('a browser that leaves closes its event stream at the daemon', async (t) => {
	const { daemon, proxyPort } = await setup(t);
	await visitAndLeave(proxyPort);
	await waitFor(() => daemon.open === 0, 'the daemon to see the stream close');
});

test('more page visits than the daemon allows streams never pile up', async (t) => {
	const { daemon, proxyPort } = await setup(t);
	for (let i = 0; i < DAEMON_STREAM_CAP + 4; i++) {
		await visitAndLeave(proxyPort);
		await waitFor(() => daemon.open === 0, `stream ${i + 1} to close at the daemon`);
	}
	assert.equal(daemon.peak, 1);
});

test('ordinary GETs and POSTs still round-trip through the proxy', async (t) => {
	const { proxyPort } = await setup(t);
	const info = await request(proxyPort, 'GET', '/wallets/w1/api/info');
	assert.equal(info.status, 200);
	assert.equal(info.body.data.auth, 'Bearer test-token');
	const echo = await request(proxyPort, 'POST', '/wallets/w1/api/echo', { amountSats: 1000 });
	assert.equal(echo.status, 200);
	assert.deepEqual(echo.body.data, { amountSats: 1000 });
});
