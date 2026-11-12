'use strict';

const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { config, SUPPORTED_NETWORKS, ELECTRUM_PRESETS, PUBLIC_ELECTRUM_SERVERS } = require('./config');
const desktopNetwork = require('./desktop-network');
const { WalletManager } = require('./wallet-manager');
const { createAccessGuard } = require('./access-control');
const { releaseUpstreamOnClose } = require('./proxy-release');
const { mountBrowserWalletApi, atomicSave } = require('./browser-wallet');
const { createDesktopDrains } = require('./desktop-drain');
const { createDesktopAccessGuard } = require('./desktop-access');
const { createUpdateHold } = require('./update-hold');
const { createSecureStore } = require('./secure-store');
const { openPaymentNotes } = require('./payment-notes');

// Cap on how much of a failed daemon response is buffered before logging it.
// Error bodies are small; this only stops a large one from being held in memory.
const MAX_LOGGED_BODY = 8192;

function asyncHandler(fn) {
	return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function swaggerAssetsPath() {
	try {
		return require('swagger-ui-dist').getAbsoluteFSPath();
	} catch (_) {
		return null;
	}
}

async function startManager({
	manager = new WalletManager(),
	desktopSessionToken = process.env.DESKTOP_SESSION_TOKEN,
	port = config.port,
	bindHost = config.bindHost,
	publicDir = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'dist')
} = {}) {
	if (process.env.CHICORY_ENCRYPTED_STORAGE === '1' && !require('./vault-files').isActive())
		throw new Error('Encrypted wallet storage must be opened before the manager.');
	if (process.env.DESKTOP_MODE === '1' && !desktopSessionToken)
		throw new Error('The desktop manager requires its private session token.');
	const desktopGuard = desktopSessionToken ? createDesktopAccessGuard(desktopSessionToken) : null;
	// Subscribe to safe bootstrap progress before automatic wallet starts.
	desktopNetwork.torStatus();
	await manager.init();
	if (desktopNetwork.enabled()) require('./desktop-diagnostics').installDesktopDiagnostics(manager);

	const app = express();
	app.disable('x-powered-by');
	// Desktop clients do not have Umbrel SSO. Authenticate every route,
	// including HTML and assets, before any request can reach the manager.
	if (desktopGuard) app.use(desktopGuard);
	let closing = false;
	app.use((_req, res, next) => closing
		? res.status(503).json({ ok: false, error: { code: 'SHUTTING_DOWN', message: 'Chicory is closing.' } })
		: next());
	const updateHold = createUpdateHold();
	app.use(updateHold.middleware);

	// Restrict the API to what fronts the browser with Umbrel's SSO (app_proxy,
	// or umbrelOS 2's app gateway on the host) and loopback, so other apps on
	// the shared network cannot reach the wallet control plane directly.
	// Mounted first so it covers every route below.
	const accessGuard = desktopGuard ? Object.assign((_req, _res, next) => next(), {
		strict: (_req, _res, next) => next()
	}) : createAccessGuard({ log: (m) => console.log(m) });
	app.use(accessGuard);
	// The wallet drain (issue #29) and its fence, mounted ahead of every other
	// wallet route so a held wallet refuses new sends and receives.
	const drains = createDesktopDrains(manager, { atomicSave });
	drains.mount(app);
	// Public request metadata and durable browser payment identities live on
	// the host because the stock daemon does not implement the portable routes.
	drains.useWallets(mountBrowserWalletApi(app, manager, { drainActivity: (id) => drains.activity(id) }));

	// --- Reverse proxy to the per-wallet beignet daemons. Mounted BEFORE the
	// JSON body parser so request bodies (e.g. POST /send) stream through intact.
	const proxy = createProxyMiddleware({
		target: 'http://127.0.0.1:1',
		changeOrigin: true,
		ws: false,
		logLevel: 'warn',
		router: (req) => manager.target(req.params.id),
		// Strip the /wallets/:id/api mount prefix so the daemon sees its own
		// routes (e.g. /info, /balance, /events). Anchored at the start, so
		// query strings and already-stripped paths are left intact.
		pathRewrite: { '^/wallets/[^/]+/api': '' },
		onProxyReq: (proxyReq, req, res) => {
			// This capability authorizes the manager, not the wallet daemon.
			proxyReq.removeHeader('x-chicory-session');
			try {
				proxyReq.setHeader('Authorization', `Bearer ${manager.token(req.params.id)}`);
			} catch (_) {
				/* token missing; daemon will reject */
			}
			// Without this a closed wallet page leaves its /events stream open at
			// the daemon, which caps them (see proxy-release.js).
			releaseUpstreamOnClose(proxyReq, req, res);
		},
		// Record failed daemon calls in the wallet's log. The daemon answers a
		// rejected action (a peer that will not complete the handshake, a channel
		// it will not open) to the browser that asked and nowhere else, so the
		// failure never reached the Logs tab and the tab looked empty at exactly
		// the moment someone went looking. Only errors are recorded, so a working
		// wallet does not fill its log with successful calls.
		onProxyRes: (proxyRes, req) => {
			const failed = proxyRes.statusCode >= 400;
			// Non-GETs are the actions worth reporting; they can also fail with a
			// 200 carrying {ok:false}, so their bodies are inspected either way.
			if (!failed && req.method === 'GET') return;
			if (!String(proxyRes.headers['content-type'] || '').includes('json')) return;
			let body = '';
			proxyRes.on('data', (chunk) => {
				if (body.length < MAX_LOGGED_BODY) body += chunk.toString('utf8');
			});
			proxyRes.on('end', () => {
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch (_) {
					return; // truncated or not JSON after all
				}
				const route = String(req.originalUrl || '').replace(/^\/wallets\/[^/]+\/api/, '').split('?')[0];
				// The dashboard edits the engine's ranked primaries directly; the
				// record follows each write that went through, so the new node
				// is trusted and dialed and the mirror the wallet client reads
				// names it (coreyphillips/beignet#1924).
				if (parsed && parsed.ok === true && req.method === 'POST' && /^\/primaries\/(add|remove|reorder|threshold)$/.test(route)) {
					manager.syncPrimaries(req.params.id).catch((err) =>
						manager.recordLog(req.params.id, `the ranked primaries could not be read back after ${route}: ${err.message}`)
					);
					return;
				}
				if (!parsed || parsed.ok !== false) return;
				const err = parsed.error || {};
				manager.recordLog(
					req.params.id,
					`${req.method} ${route} failed [${err.code || proxyRes.statusCode}] ${
						err.message || ''
					}`.trim()
				);
			});
		},
		onError: (err, req, res) => {
			if (!res.headersSent) {
				res.status(502).json({
					ok: false,
					error: { code: 'PROXY_ERROR', message: err.message }
				});
			}
		}
	});

	app.use('/wallets/:id/api', (req, res, next) => {
		if (!manager.target(req.params.id)) {
			return res
				.status(404)
				.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
		}
		if (!manager.runtimeState(req.params.id).proc) {
			return res
				.status(503)
				.json({ ok: false, error: { code: 'NOT_RUNNING', message: 'Wallet is not running' } });
		}
		return proxy(req, res, next);
	});

	// An export hands out every seed on the box, so these routes do not get the
	// guard's fail-open window: while app_proxy is unresolved they answer
	// loopback and the host only, rather than any app on the shared network.
	app.use('/api/backup', accessGuard.strict);
	// One wallet's seed, read back for its owner: the same stakes as an
	// export, so the same guard.
	app.use('/api/wallets/:id/recovery-phrase', accessGuard.strict);

	// A restore carries the whole archive in its body (base64), which on a box
	// with many wallets is larger than any other request here. Mounted first so
	// the general parser below leaves an already-parsed body alone.
	// A full backup also carries every channel database, base64 in the body,
	// up to the format's 256 MiB archive cap.
	app.use('/api/backup/full', express.json({ limit: '360mb' }));
	// A cached wallet view with a long history is larger than other requests.
	app.use('/api/secure-store', express.json({ limit: '10mb' }));
	app.use('/api/backup', express.json({ limit: '32mb' }));
	app.use(express.json({ limit: '1mb' }));

	// --- Management API ---
	const api = express.Router();

	// The manager-level faults worth reporting here are its two files on the
	// data volume: a registry or a settings file that could not be read. See
	// WalletManager#health for what each one costs.
	api.get('/health', (req, res) => {
		res.json({ ok: true, result: manager.health() });
	});

	api.get('/config', (req, res) => {
		const settings = manager.getSettings();
		res.json({
			ok: true,
			result: {
				defaultNetwork: settings.defaultNetwork,
				defaultElectrum: settings.defaultElectrum,
				hasDefaultElectrum: !!settings.defaultElectrum,
				supportedNetworks: SUPPORTED_NETWORKS,
				electrumPresets: ELECTRUM_PRESETS,
				electrumPublicServers: PUBLIC_ELECTRUM_SERVERS,

				torAvailable: desktopNetwork.enabled() || !!config.torProxy,
				torStatus: desktopNetwork.torStatus(),
				onionAvailable: manager.onionAvailable(),
				// The Tor proxy scoped to .onion peers (beignet #963): without it a
				// Clearnet or Hybrid wallet dials with no proxy at all.
				torProxyScopeAvailable: manager.torProxyScopeAvailable(),
				// Electrum TLS certificate verification (beignet #1776): without
				// it the dashboard offers no verify switch.
				electrumTlsVerifyAvailable: manager.electrumTlsVerifyAvailable(),
				irohAvailable: manager.irohAvailable(),
				// Why not, when it is not: 'engine' (the bundled engine predates
				// Iroh) or 'module' (no native Iroh module for this platform, where
				// an Iroh link is reached through its onion fallback alone).
				irohUnavailable: manager.irohUnavailable(),
				// Channel backup (the Recovery Protocol) needs an engine that
				// carries its surface; older engines get no controls for it.
				engineVersion: manager.engineVersion,
				recoveryAvailable: manager.recoveryAvailable(),
				recoveryGuardians: settings.recoveryGuardians,
				// When this box last wrote a backup archive, so the wallet list
				// can say so without a second call.
				lastBackupAt: settings.lastBackupAt,
				// Lightning-first wallets need JIT receive and direct funding,
				// which the engine gained after 0.9.3; probed on the bundle.
				lfbwAvailable: manager.lfbwAvailable(),
				// A fee quote before a just-in-time invoice exists (beignet
				// #687) and the daemon applying a peer-storage checkpoint by
				// itself (beignet #690), both probed on the bundle.
				jitQuoteAvailable: manager.jitQuoteAvailable(),
				recoveryAutoApplyAvailable: manager.recoveryAutoApplyAvailable(),
				// Wallets hosting a guardian for other beignet nodes, and node
				// URIs resolving to guardian entries (beignet #699).
				guardianHostingAvailable: manager.guardianHostingAvailable(),
				// A wallet moving to a new guardian set with its channels running
				// (beignet #701).
				guardianRotationAvailable: manager.guardianRotationAvailable(),
				// FFOR offline receive (beignet #729, #865): a wallet paid while
				// it is offline through a settlement peer, probed on the bundle.
				fforAvailable: manager.fforAvailable(),
				concurrentOfflineReceiveAvailable: manager.concurrentOfflineReceiveAvailable(),
				offlineReceiveAvailable: manager.offlineReceiveAvailable(),
				// Settings > Empty wallet to an address (issue #29): the two-leg
				// drain this manager serves when the bundled engine has its routes.
				drainAvailable: manager.drainAvailable(),
				// Several ranked primary nodes and an address send out of one or
				// several channels (coreyphillips/beignet#1924, engine 0.37.0).
				primariesAvailable: manager.primariesAvailable(),
				channelSendAvailable: manager.channelSendAvailable()
			}
		});
	});

	api.get('/settings', (req, res) =>
		res.json({ ok: true, result: manager.getSettings() })
	);

	api.put(
		'/settings',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.updateSettings(req.body || {}) });
		})
	);

	// The Electrum servers an Umbrel may run, each probed for whether it is
	// there, what software answers, which chain it serves and its tip. The
	// presets are probed together with a short bound each and the answers
	// stand for a few seconds, so the dashboard asks on every open of the
	// Electrum fields; ?refresh=1 asks again now. ?scope=public asks the
	// public servers instead, those for ?network= when it names one.
	api.get(
		'/electrum/discover',
		asyncHandler(async (req, res) => {
			res.setHeader('Cache-Control', 'no-store');
			res.json({
				ok: true,
				result: await manager.discoverElectrum({
					refresh: req.query.refresh === '1',
					scope: req.query.scope === 'public' ? 'public' : 'presets',
					network: typeof req.query.network === 'string' ? req.query.network : null
				})
			});
		})
	);

	// A server the user typed (another Umbrel on the LAN, a public server),
	// probed on request before it is saved anywhere.
	api.post(
		'/electrum/test',
		asyncHandler(async (req, res) => {
			res.setHeader('Cache-Control', 'no-store');
			res.json({ ok: true, result: await manager.testElectrum(req.body || {}) });
		})
	);

	// Everything about this box that the chain does not hold: the wallet
	// records, the app settings, and every wallet's seed and API token, in one
	// passphrase-encrypted archive. The response is the file itself.
	api.post(
		'/backup/export',
		asyncHandler(async (req, res) => {
			const { archive, filename } = await manager.exportBackup(req.body || {});
			res.setHeader('Content-Type', 'application/octet-stream');
			res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
			res.setHeader('Content-Length', String(archive.length));
			// Nothing about a file holding every seed on the box belongs in a
			// cache, a proxy's or the browser's.
			res.setHeader('Cache-Control', 'no-store');
			res.end(archive);
		})
	);

	// What an archive holds and what restoring it here would do, before
	// anything is written.
	api.post(
		'/backup/inspect',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: manager.inspectBackup(req.body || {}) });
		})
	);

	// Recreate records, secrets and settings from an archive. Starts nothing:
	// each restored wallet waits until it is started by hand.
	api.post(
		'/backup/restore',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: manager.restoreBackup(req.body || {}) });
		})
	);

	// Private interface state on desktop: offline request drafts, cached
	// wallet views, auto-pay policy and network profiles, encrypted at rest
	// with the wallet storage and gated by the app lock like the rest of /api.
	const secureStore = createSecureStore({ dataDir: config.dataDir });
	api.get('/secure-store', asyncHandler(async (req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.json({ ok: true, result: secureStore.list() });
	}));
	api.get('/secure-store/:service', asyncHandler(async (req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		res.json({ ok: true, result: secureStore.get(req.params.service) });
	}));
	api.put('/secure-store/:service', asyncHandler(async (req, res) => {
		res.json({ ok: true, result: secureStore.set(req.params.service, req.body || {}) });
	}));
	api.delete('/secure-store/:service', asyncHandler(async (req, res) => {
		res.json({ ok: true, result: secureStore.remove(req.params.service) });
	}));

	if (desktopGuard) {
		const notes = req => openPaymentNotes(manager, req.params.id, req.params.network);
		api.route('/wallets/:id/payment-notes/:network')
			.get((req, res) => res.json({ ok: true, result: notes(req).read() }))
			.put((req, res) => res.json({ ok: true, result: notes(req).save(req.body) }))
			.post((req, res) => res.json({ ok: true, result: notes(req).move(req.body) }));
	}

	// The portable full backup: every wallet with its channel databases,
	// under a passphrase, for a fresh profile on another computer or OS
	// account. Distinct from the settings archive above and from a recovery
	// phrase. On desktop these routes also need the app lock's fresh grant.
	api.post(
		'/backup/full/export',
		asyncHandler(async (req, res) => {
			const { archive, filename } = await manager.exportFullBackup(req.body || {});
			res.setHeader('Content-Type', 'application/octet-stream');
			res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
			res.setHeader('Content-Length', String(archive.length));
			res.setHeader('Cache-Control', 'no-store');
			res.end(archive);
		})
	);
	api.post(
		'/backup/full/inspect',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: manager.inspectFullBackup(req.body || {}) });
		})
	);
	api.post(
		'/backup/full/restore',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.restoreFullBackup(req.body || {}) });
		})
	);

	// A beignet node's Lightning URI to a guardian entry, asked through any
	// running Lightning wallet's daemon; adopts nothing (beignet #699).
	api.post(
		'/recovery/resolve-guardian',
		asyncHandler(async (req, res) => {
			const { uri } = req.body || {};
			res.json({ ok: true, result: await manager.resolveGuardianUri(uri) });
		})
	);

	// The wallets on this Umbrel that serve as guardians, with the addresses
	// to reach them at.
	api.get('/guardians/candidates', (req, res) =>
		res.json({ ok: true, result: manager.guardianCandidates() })
	);

	api.get('/wallets', (req, res) => res.json({ ok: true, result: manager.list() }));

	api.post(
		'/wallets',
		asyncHandler(async (req, res) => {
			const { record, mnemonic } = await manager.createWallet(req.body || {});
			res.json({ ok: true, result: { record, mnemonic } });
		})
	);

	api.post(
		'/wallets/import',
		asyncHandler(async (req, res) => {
			const { record } = await manager.importWallet(req.body || {});
			res.json({ ok: true, result: { record } });
		})
	);

	api.get('/wallets/:id', (req, res) => {
		const record = manager.publicRecord(req.params.id);
		if (!record) {
			return res
				.status(404)
				.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
		}
		res.json({ ok: true, result: record });
	});

	api.patch(
		'/wallets/:id',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.updateWallet(req.params.id, req.body || {}) });
		})
	);

	// The wallet's recovery phrase, shown again on request. A POST, so no
	// link, prefetch or cache ever fetches it, and never stored by one.
	api.post(
		'/wallets/:id/recovery-phrase',
		asyncHandler(async (req, res) => {
			res.setHeader('Cache-Control', 'no-store');
			res.json({ ok: true, result: manager.recoveryPhrase(req.params.id) });
		})
	);

	// FFOR offline receive: the siblings a wallet can pick as its settlement
	// peer, and a manual re-run of the return the manager performs on start.
	api.get(
		'/wallets/:id/ffor/candidates',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: manager.fforCandidates(req.params.id) });
		})
	);

	// Start an epoch with witnesses and an issuer in one go, or provision
	// them on an epoch that is already ACTIVE.
	api.post(
		'/wallets/:id/ffor/epoch',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.fforSetupEpoch(req.params.id, req.body || {}) });
		})
	);

	api.post(
		'/wallets/:id/ffor/provision',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.fforProvision(req.params.id, req.body || {}) });
		})
	);

	api.post(
		'/wallets/:id/ffor/enforce',
		asyncHandler(async (req, res) => {
			const { channelId } = req.body || {};
			res.json({ ok: true, result: await manager.fforEnforce(req.params.id, { channelId }) });
		})
	);

	api.post(
		'/wallets/:id/ffor/return',
		asyncHandler(async (req, res) => {
			const { channelId } = req.body || {};
			res.json({ ok: true, result: await manager.fforReturn(req.params.id, { channelId }) });
		})
	);

	api.post(
		'/wallets/:id/start',
		asyncHandler(async (req, res) => {
			await manager.startWallet(req.params.id);
			res.json({ ok: true, result: manager.publicRecord(req.params.id) });
		})
	);

	api.post(
		'/wallets/:id/stop',
		asyncHandler(async (req, res) => {
			await manager.stopWallet(req.params.id);
			res.json({ ok: true, result: manager.publicRecord(req.params.id) });
		})
	);

	api.delete(
		'/wallets/:id',
		asyncHandler(async (req, res) => {
			await manager.deleteWallet(req.params.id, { purge: req.query.purge === 'true' });
			res.json({ ok: true, result: { deleted: true } });
		})
	);

	// Re-run a lightning-first wallet's setup (trust, direct-funding policy,
	// peer connection, the first channel). It runs by itself on every start;
	// this is the dashboard's Retry after a failure.
	api.post(
		'/wallets/:id/lfbw/setup',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.setupLfbw(req.params.id) });
		})
	);

	// One channelize pass now, skipping the fee wait: the dashboard's
	// "Move now anyway" for a deposit the owner wants in Lightning at any
	// price. The channel minimums still hold.
	api.post(
		'/wallets/:id/lfbw/channelize',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.channelizeNow(req.params.id) });
		})
	);

	// Re-pointing the primary leaves the old home channel open (umbrel #86):
	// this closes it cooperatively so channelize can carry the funds into the
	// new one once the payout confirms.
	api.post(
		'/wallets/:id/lfbw/move-home',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.moveHome(req.params.id) });
		})
	);

	// Close the home channel, optionally turning lightning-first off first
	// so the payout is not moved straight back into a new channel.
	api.post(
		'/wallets/:id/lfbw/close-home',
		asyncHandler(async (req, res) => {
			const { channelId, turnOff } = req.body || {};
			res.json({ ok: true, result: await manager.closeHome(req.params.id, { channelId, turnOff: !!turnOff }) });
		})
	);

	// Move a wallet to a new guardian set with its channels running (beignet
	// #701): the daemon rotates, the record follows.
	api.post(
		'/wallets/:id/recovery/rotate',
		asyncHandler(async (req, res) => {
			const { guardians } = req.body || {};
			res.json({ ok: true, result: await manager.rotateGuardians(req.params.id, guardians) });
		})
	);

	api.get('/wallets/:id/logs', (req, res) =>
		res.json({ ok: true, result: manager.logs(req.params.id) })
	);

	// Node-level errors captured from the daemon's event stream. These carry the
	// reason a channel open failed, which is otherwise reported nowhere.
	api.get('/wallets/:id/errors', (req, res) => {
		const since = parseInt(req.query.since, 10);
		res.json({
			ok: true,
			result: manager.nodeErrors(req.params.id, {
				since: Number.isFinite(since) ? since : undefined
			})
		});
	});

	// Durable channel history captured from the daemon's event stream: opening,
	// ready, closing, and the reason an automatic force-close fired. Unlike the
	// error ring this survives manager restarts, so a channel that closed while
	// nobody was watching can still explain itself in the detail view.
	api.get('/wallets/:id/channel-events', (req, res) => {
		const channelId =
			typeof req.query.channelId === 'string' ? req.query.channelId : undefined;
		res.json({
			ok: true,
			result: manager.channelEvents(req.params.id, { channelId })
		});
	});

	// Direct fundings that degraded into an ordinary payment, and the reason.
	// The payer's daemon says why in the answer to the one call that asked, and
	// the transaction that goes out instead is an ordinary send: nothing on
	// either end of the payment can say afterwards that it was meant to be a
	// direct funding. The dashboard reports the pair here and reads it back
	// onto the payment's activity row (umbrel #121).
	api.get('/wallets/:id/direct-funding/fallbacks', (req, res) =>
		res.json({ ok: true, result: manager.directFundingFallbacks(req.params.id) })
	);

	api.post(
		'/wallets/:id/direct-funding/fallbacks',
		asyncHandler(async (req, res) => {
			await manager.catchUpDirectFundingSteps(req.params.id);
			res.json({
				ok: true,
				result: manager.recordDirectFundingFallback(req.params.id, req.body || {})
			});
		})
	);

	// The steps of the latest attempt to pay a direct-funding request from
	// this wallet: the routes tried and skipped, the offer, the receipt. The
	// daemon logs most of them where only GET /logs can read them (umbrel #147).
	api.get(
		'/wallets/:id/direct-funding/steps',
		asyncHandler(async (req, res) => {
			const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
			res.json({ ok: true, result: await manager.directFundingSteps(req.params.id, { requestId }) });
		})
	);

	// Fetch the wallet daemon's OpenAPI spec and rewrite its server URL so the
	// Swagger UI "Try it out" calls route back through this manager (with auth).
	api.get(
		'/wallets/:id/openapi.json',
		asyncHandler(async (req, res) => {
			const id = req.params.id;
			const target = manager.target(id);
			if (!target) {
				return res
					.status(404)
					.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
			}
			const upstream = await fetch(`${target}/openapi.json`, {
				signal: AbortSignal.timeout(5000)
			});
			const spec = await upstream.json();
			spec.servers = [{ url: `/wallets/${id}/api`, description: 'Beignet wallet (via manager)' }];
			res.json(spec);
		})
	);

	app.use('/api', api);

	// --- Static assets + SPA ---
	const swaggerPath = swaggerAssetsPath();
	if (swaggerPath) {
		app.use('/vendor/swagger', express.static(swaggerPath));
	}
	app.use(express.static(publicDir));
	// Client-side routing fallback: serve index.html for non-API GET routes.
	app.get('*', (req, res, next) => {
		if (
			req.path.startsWith('/api') ||
			req.path.startsWith('/wallets') ||
			req.path.startsWith('/vendor')
		) {
			return next();
		}
		res.sendFile(path.join(publicDir, 'index.html'), (err) => err && next());
	});

	// --- Error handler (must be last) ---
	// eslint-disable-next-line no-unused-vars
	app.use((err, req, res, next) => {
		const status = err.statusCode || 500;
		if (status >= 500) console.error(err);
		res.status(status).json({
			ok: false,
			error: {
				code: err.code || 'ERROR',
				message: err.message,
				// Structured context for a refusal the dashboard can act on
				// (which wallets depend on a primary, say).
				...(err.details ? { details: err.details } : {})
			}
		});
	});

	let server;
	try {
		server = await new Promise((resolve, reject) => {
			const listening = app.listen(desktopGuard ? 0 : port, desktopGuard ? '127.0.0.1' : bindHost);
			listening.once('error', reject);
			listening.once('listening', () => {
				listening.removeListener('error', reject);
				resolve(listening);
			});
		});
	} catch (error) {
		await manager.shutdown();
		throw error;
	}
	let closePromise;
	const close = () => {
		if (closePromise) return closePromise;
		closing = true;
		drains.close();
		const httpClosed = new Promise((resolve) => server.close(resolve));
		server.closeIdleConnections?.();
		closePromise = (async () => {
			// Wallets get their existing 18 second drain plus process reap before
			// held streams are closed. Do not orphan them by exiting early.
			try { await manager.shutdown(); }
			finally { server.closeAllConnections?.(); }
			await httpClosed;
		})();
		return closePromise;
	};
	return { app, server, manager, close, updateHold };
}

async function main() {
	let service;
	let shutdownRequested = false;
	let shuttingDown = false;
	const shutdown = async () => {
		shutdownRequested = true;
		if (!service) return;
		if (shuttingDown) return;
		shuttingDown = true;
		console.log('shutting down; stopping wallet daemons...');
		try {
			await service.close();
			process.exit(0);
		} catch (error) {
			console.error('shutdown failed:', error.message);
			process.exit(1);
		}
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
	process.on('message', (message) => {
		if (message && message.type === 'shutdown') void shutdown();
		// The desktop shell asks before installing an update. It shuts the
		// manager down next, so a granted hold is never released here.
		if (message && message.type === 'update:hold' && typeof message.requestId === 'string') {
			const reply = (ok) => process.connected &&
				process.send({ type: 'update:hold-result', requestId: message.requestId, ok }, () => {});
			if (!service || shuttingDown) reply(false);
			else void service.updateHold.hold().then(reply, () => reply(false));
		}
		if (message && message.type === 'update:release') service?.updateHold.release();
	});
	// Closing or crashing the parent must not leave unattended wallet daemons.
	if (process.connected) process.on('disconnect', shutdown);
	service = await startManager();
	if (shutdownRequested) return shutdown();
	const address = service.server.address();
	console.log(`chicory manager listening on :${address.port} (data dir ${config.dataDir})`);
	if (process.send) process.send({
		type: 'ready', host: address.address, port: address.port,
		origin: `http://127.0.0.1:${address.port}`
	});
}

if (require.main === module) main().catch((err) => {
	console.error('fatal:', err);
	process.exit(1);
});

module.exports = { startManager, main };
