'use strict';

/**
 * Settings > Empty wallet to an address on desktop (issue #29): the two-leg
 * drain Chicory mobile runs in its portable engine, served here on top of a
 * beignet daemon. The home channel closes cooperatively to the address, then
 * every loose coin the review saw is swept to it, and coins received after
 * the review stay in the wallet.
 *
 * The rules are the portable engine's, ported in drain.js, channelize-pause.js
 * and drain-fence.js. This module is what the portable runtime gives them in
 * process and a daemon only gives over HTTP: an engine read through its
 * routes, a durable journal and channelize pause in the wallet's private
 * directory, a fence in front of the wallet's mutating routes while a drain
 * holds it, the payout checked on the chain through Electrum, and a pass that
 * keeps a drain moving while no screen is asking about it.
 */

const crypto = require('crypto');
const lfbw = require('./lfbw');
const path = require('path');
const express = require('express');
const { address: bitcoinAddress, networks, Transaction } = require('bitcoinjs-lib');
const fs = require('./vault-files').fs;
const { drainCoordinator } = require('./drain');
const { channelizePause } = require('./channelize-pause');
const { drainFence } = require('./drain-fence');
const { electrumRequests } = require('./electrum-probe');

const SYNC_MS = 5000;
// Phases a drain is still moving through, as drain.js names them.
const ACTIVE = new Set(['preparing', 'closing', 'sweeping', 'pending', 'cancelling']);
const WALLET_PATH = /^\/(?:wallets\/([^/]+)\/api|api\/wallets\/([^/]+))(?:\/|$)/;

function failure(code, message, statusCode = 400) {
	throw Object.assign(new Error(message), { code, statusCode, status: statusCode });
}

function chainFor(network) {
	return network === 'mainnet' ? networks.bitcoin : network === 'testnet' ? networks.testnet : networks.regtest;
}

/** A file in the wallet's private directory, read through the vault. Missing is null. */
function journalFile(file, atomicSave) {
	let cached;
	return {
		read() {
			if (cached !== undefined) return cached;
			try {
				cached = JSON.parse(fs.readFileSync(file, 'utf8'));
			} catch (error) {
				// Unreadable is not empty: drain.js refuses an invalid journal, so
				// every mutation stays fenced until it is restored.
				cached = error.code === 'ENOENT' ? null : { unreadable: true };
			}
			return cached;
		},
		write(value) {
			atomicSave(file, value);
			cached = value == null ? null : JSON.parse(JSON.stringify(value));
		}
	};
}

/**
 * The fields of a daemon channel row that prove its cooperative close never
 * started. The portable engine reads the channel's full live and saved state;
 * the daemon lists less, but starting a shutdown moves a NORMAL channel to
 * SHUTTING_DOWN at once, and a close in any later stage carries closeStatus.
 * Anything unexpected reads as started, which only ever keeps a drain waiting.
 */
function channelUntouched(channel, channelId) {
	if (!channel || channel.channelId !== channelId) return false;
	const normal = channel.state === 'NORMAL' ||
		(channel.state === 'AWAITING_REESTABLISH' && channel.preReestablishState === 'NORMAL');
	return normal && !channel.closeStatus && !channel.restoreRecencyUnproven &&
		!channel.reestablishRecencyUnproven && !channel.reestablishSecretMissing &&
		!channel.restoreRevokedRisk && !channel.fundingUnaccounted &&
		typeof channel.fundingTxid === 'string' && Number.isInteger(channel.fundingOutputIndex);
}

function createDesktopDrains(manager, { atomicSave, electrum = electrumRequests, syncMs = SYNC_MS } = {}) {
	const entries = new Map();
	let wallets = () => null;

	const call = (id, method, route, body) => {
		const record = manager.registry.get(id);
		if (!record) failure('NOT_FOUND', 'Wallet not found', 404);
		return manager._daemonCall(record, method, route, body);
	};
	const query = async (id, method, params) => {
		const record = manager.registry.get(id);
		const { replies } = await electrum(record.electrum, [{ id: 1, method, params }], { timeoutMs: 5000 });
		if (!replies?.[1] || replies[1].error) throw new Error('Bitcoin evidence could not be read');
		return replies[1].result;
	};

	function entry(id) {
		if (entries.has(id)) return entries.get(id);
		const base = manager.paths(id).base;
		const journal = journalFile(path.join(base, 'drains.json'), atomicSave);
		const held = journalFile(path.join(base, 'drain-pause.json'), atomicSave);
		const rt = () => manager.runtimeState(id);
		const running = () => !!rt().proc && !rt().stopping;
		const cache = { peers: [], payments: [], channels: [], utxos: [], transactions: [], offline: {}, tip: 0 };
		const engine = {
			listPeers: () => cache.peers,
			listPayments: () => cache.payments,
			listChannels: () => cache.channels,
			listUtxos: () => cache.utxos,
			listOnchainTransactions: () => cache.transactions,
			getFeeEstimates: () => call(id, 'GET', '/fees/estimates'),
			closeQuote: (channelId, address, acceptStaleStateRisk) =>
				call(id, 'POST', '/channel/close-quote', { channelId, address, acceptStaleStateRisk: acceptStaleStateRisk === true }),
			quoteOnchain: (body) => call(id, 'POST', '/tx/quote', body),
			prepareOnchainSweep: (body) => call(id, 'POST', '/onchain/sweep/prepare', body),
			submitOnchainSweep: (requestId) => call(id, 'POST', '/onchain/sweep/submit', { requestId }),
			cancelOnchainSweep: (requestId) => call(id, 'POST', '/onchain/sweep/cancel', { requestId }),
			getOnchainSweep: async (requestId) => {
				try {
					return await call(id, 'GET', `/onchain/sweep?requestId=${encodeURIComponent(requestId)}`);
				} catch (error) {
					if (error.code === 'NOT_FOUND') return null;
					throw error;
				}
			},
			// The portable node answers {ok, error}. The daemon answers a refusal
			// as CLOSE_FAILED, and anything else (a timeout, a lost reply) is
			// thrown, which drain.js treats as a close that may have started.
			closeChannel: async (channelId, acceptStaleStateRisk, address) => {
				try {
					await call(id, 'POST', '/channel/close', { channelId, address, acceptStaleStateRisk: acceptStaleStateRisk === true });
					return { ok: true };
				} catch (error) {
					if (error.code === 'CLOSE_FAILED') return { ok: false, error: error.message };
					throw error;
				}
			}
		};
		const refresh = async () => {
			const [peers, payments, channels, utxos, transactions, info, offline] = await Promise.all([
				call(id, 'GET', '/peers'),
				call(id, 'GET', '/payments'),
				call(id, 'GET', '/channels'),
				call(id, 'GET', '/utxos'),
				call(id, 'GET', '/transactions'),
				call(id, 'GET', '/info'),
				manager.offlineReceiveAvailable() ? call(id, 'GET', '/receive/status') : {}
			]);
			if (![peers, payments, channels, utxos, transactions].every(Array.isArray))
				failure('DRAIN_UNAVAILABLE', 'The wallet returned an incomplete view. Try again', 503);
			Object.assign(cache, { peers, payments, channels, utxos, transactions, offline: offline || {}, tip: Number(info?.blockHeight) || 0 });
		};
		const depth = (height) => (height > 0 && cache.tip >= height ? cache.tip - height + 1 : 0);
		const pause = channelizePause({
			read: () => held.read(),
			write: (value) => held.write(value),
			busy: () => rt().lfbwBusy === true,
			failure
		});
		const value = { id, running };
		value.coordinator = drainCoordinator({
			// The daemon process a step started with. A restart or stop ends the step.
			lifecycle: () => rt().proc,
			operational: running,
			read: () => journal.read(),
			write: (next) => journal.write(next),
			node: () => (running() && manager.drainAvailable() ? engine : null),
			refresh,
			primaries: () => lfbw.primaryPubkeys(manager.registry.get(id)?.lfbw),
			ready: () => {
				const record = manager.registry.get(id);
				if (!running() || !rt().healthy || record?.lfbw?.setup !== 'ready')
					failure('DRAIN_UNAVAILABLE', 'Wait for the wallet to reconnect and finish syncing', 409);
			},
			busy: () => rt().lfbwBusy === true || value.fence.pending() > 0,
			activityPending: () => {
				try {
					const store = wallets(id);
					return !!store && store.load().activity.some((row) => ['pending', 'uncertain'].includes(row.status));
				} catch {
					// Payment history that cannot be read cannot show nothing is pending.
					return true;
				}
			},
			offline: () => cache.offline,
			pause,
			// The durable journal is the receive fence, as on mobile.
			disableReceive: async () => {},
			restoreReceive: async () => {},
			closeNotStarted: async (channelId) => {
				try {
					const channels = await call(id, 'GET', '/channels');
					return channelUntouched(channels.find((channel) => channel.channelId === channelId), channelId);
				} catch {
					return false;
				}
			},
			// The close pays the destination directly. It counts only once the
			// chain shows that transaction spending the reviewed channel funding
			// and paying the address the amount the engine signed.
			observe: async (payout, row) => {
				const record = manager.registry.get(id);
				const script = bitcoinAddress.toOutputScript(row.address, chainFor(record.network));
				const scriptHash = crypto.createHash('sha256').update(script).digest().reverse().toString('hex');
				const history = await query(id, 'blockchain.scripthash.get_history', [scriptHash]);
				if (!Array.isArray(history)) throw new Error('The destination history is unavailable');
				const seen = history.find((item) => item?.tx_hash === payout.txid);
				if (!seen) return { exists: false, height: 0, depth: 0 };
				const tx = Transaction.fromHex(await query(id, 'blockchain.transaction.get', [payout.txid, false]));
				const matched = tx.getId() === payout.txid &&
					tx.ins.some((input) => Buffer.from(input.hash).reverse().toString('hex') === row.fundingTxid &&
						input.index === row.fundingOutputIndex) &&
					tx.outs.some((output) => output.script.equals(script) && output.value === payout.valueSats);
				const height = Number.isSafeInteger(seen.height) && seen.height > 0 ? seen.height : 0;
				return { exists: matched, height, depth: depth(height) };
			},
			sweepDepth: (txid) => depth(cache.transactions.find((tx) => tx.txid === txid)?.height ?? 0),
			failure
		});
		value.fence = drainFence({ active: () => value.coordinator.blocksWallet(), failure });
		value.pause = pause;
		value.tracking = () => {
			const saved = journal.read();
			return Array.isArray(saved?.records) &&
				saved.records.some((row) => ACTIVE.has(row?.phase) || (row?.phase === 'completed' && !row.finalized));
		};
		entries.set(id, value);
		return value;
	}

	const known = (id) => typeof id === 'string' && !!manager.registry?.get(id);
	// One pass at a time per wallet, joined by whoever asks while it runs.
	const passes = new Map();
	const sync = (id) => {
		const drain = entry(id);
		if (!drain.running() || !manager.drainAvailable()) return Promise.resolve(null);
		if (!passes.has(id)) passes.set(id, drain.coordinator.sync().finally(() => passes.delete(id)));
		return passes.get(id);
	};

	/** The drain's rows for Activity, the same rows the portable runtime lists. */
	async function activity(id) {
		if (!known(id)) return [];
		await sync(id).catch(() => {});
		return entry(id).coordinator.list()
			.filter((row) => row.phase !== 'review' && (row.phase !== 'cancelled' || row.startedAt !== undefined))
			.map((row) => ({
				id: `drain:${row.requestId}`, requestId: row.requestId, type: 'send', method: 'drain',
				status: row.phase === 'completed' ? 'completed' : row.phase === 'cancelled' ? 'failed' : 'pending',
				title: row.phase === 'completed' ? 'Wallet emptied' : row.phase === 'cancelled' ? 'Wallet drain cancelled' : 'Emptying wallet',
				address: row.address, amountSats: row.amountSats, feeSats: row.feeSats,
				debitSats: row.debitSats, reviewedDebitSats: row.reviewedDebitSats,
				feeEstimated: row.feeEstimated, txids: row.txids,
				txid: row.txids[0] ?? null, reference: row.requestId, drain: row,
				timestamp: row.createdAt, description: row.phase === 'completed'
					? 'Reviewed funds sent to the destination.'
					: row.error ?? 'Closing the home channel and sending the reviewed loose coins.',
				residualSats: row.residualSats
			}));
	}

	/**
	 * While a drain holds a wallet, its sends, receives, quotes that reserve
	 * capacity and record edits are refused, and admitted ones are counted so
	 * a drain waits for them. Reads, the drain's own routes, start and stop
	 * pass, as drain-fence.js decides.
	 */
	function fence(req, res, next) {
		const match = WALLET_PATH.exec(req.path);
		let id;
		try {
			id = match && decodeURIComponent(match[1] ?? match[2]);
		} catch {
			return next();
		}
		if (!id || !known(id)) return next();
		entry(id).fence.run({ method: req.method, path: req.originalUrl.split('?')[0] }, () => new Promise((resolve) => {
			res.once('finish', resolve);
			res.once('close', resolve);
			next();
		})).catch(next);
	}

	function mount(app) {
		const router = express.Router({ mergeParams: true });
		const handle = (operation) => (req, res, next) => Promise.resolve()
			.then(() => {
				if (!known(req.params.id)) failure('NOT_FOUND', 'Wallet not found', 404);
				if (!manager.drainAvailable()) failure('DRAIN_UNAVAILABLE', 'This engine does not support wallet draining', 409);
				return operation(entry(req.params.id).coordinator, req);
			})
			.then((result) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, result }); })
			.catch(next);
		const json = express.json({ limit: '16kb' });
		router.post('/drain/quote', json, handle((drain, req) => drain.quote(req.body ?? {})));
		router.post('/drain/send', json, handle((drain, req) => drain.send(req.body?.requestId)));
		router.post('/drain/cancel', json, handle((drain, req) => drain.cancel(req.body?.requestId)));
		router.get('/drain', handle(async (drain, req) => {
			await sync(req.params.id);
			return typeof req.query.requestId === 'string' ? drain.get(req.query.requestId) : drain.list();
		}));
		app.use(fence);
		app.use('/wallets/:id/api', router);
	}

	// A drain keeps moving, and its payouts keep being checked to their final
	// depth, while no screen is asking about it.
	const timer = setInterval(() => {
		let records = [];
		try {
			records = manager.registry?.list() ?? [];
		} catch {
			return;
		}
		for (const record of records) {
			try {
				if (manager.runtimeState(record.id).healthy && entry(record.id).tracking()) sync(record.id).catch(() => {});
			} catch {
				/* An unreadable journal is reported on the wallet's own requests. */
			}
		}
	}, syncMs);
	timer.unref?.();

	// Channelize spends into the home channel, so it waits while a drain holds
	// the wallet or owns the pause.
	manager.channelizeHeld = (id) => {
		try {
			const drain = entry(id);
			return drain.pause.status().paused || drain.coordinator.blocksWallet();
		} catch {
			return true;
		}
	};

	return {
		mount,
		activity,
		sync,
		useWallets(get) { wallets = get; },
		close() { clearInterval(timer); }
	};
}

module.exports = { createDesktopDrains, channelUntouched };
