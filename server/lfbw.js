'use strict';

/**
 * Lightning-first wallet rules the manager enforces, kept pure so they can
 * be tested without a registry, a process or a daemon (the same shape as
 * recovery.js).
 *
 * A lightning-first wallet (LFBW) has one balance the user sees and one
 * "primary node" it keeps a single home channel with. Everything that lands
 * on-chain moves into that channel once it confirms, inbound capacity is
 * provisioned by the primary just in time (the engine's JIT receive), and
 * sending to a bitcoin address is a splice-out of the home channel. The
 * primary is either a sibling wallet under this manager (internal, paired
 * both ways, zero-conf by default) or an external node given as
 * pubkey@host:port.
 *
 * Numbers here are the prototype's, kept because they were exercised on a
 * live regtest pair: a channel below 20k sats trips common peer minimums, a
 * splice-in below the floor pays more fee than it is worth, and 2k sats is
 * the rough funding fee margin a wallet must hold beyond the amount.
 */

const NODE_URI_RE = /^([0-9a-fA-F]{66})@([^:\s]+):(\d+)$/;

// On-chain funds below this wait; at or above it they move into the home
// channel once every UTXO has confirmed.
const CHANNELIZE_FLOOR_SATS = 25000;
// Smallest channel the wallet will open with its primary.
const MIN_CHANNEL_SATS = 20000;
// Rough funding fee margin held beyond an amount when sizing an open.
const FUNDING_FEE_MARGIN_SATS = 2000;
// Inbound an external primary is asked to sell alongside a first open.
const DEFAULT_INBOUND_SATS = 100000;
// Headroom asked of a JIT provisioning so the channel is not exhausted by
// the very payment that created it.
const INBOUND_HEADROOM_SATS = 10000;
// One daemon call from the manager. The engine waits 15s for a JIT ack, so
// this must stay above that or an LSP that is merely slow reads as absent.
const CALL_TIMEOUT_MS = 20000;
// How long setup waits for a daemon to answer /health.
const HEALTH_TIMEOUT_MS = 90000;
// A move pays a real transaction fee. Below this multiple of the quoted
// fee the funds wait for the rate to come down or for more to arrive, so
// the fee stays under a twentieth of what moves (umbrel #88). The owner
// can override the wait for a deposit they want in Lightning at any price.
const CHANNELIZE_FEE_MULTIPLE = 20;
// Channelize backstop cadence and the pause after a failed attempt.
const CHANNELIZE_POLL_MS = 60000;
const CHANNELIZE_RETRY_MS = 2 * 60 * 1000;
const CHANNELIZE_DEBOUNCE_MS = 2000;
// The daemon events that mean a lightning-first wallet may have something to
// move. transaction:received as well as transaction:confirmed: the engine
// relays confirmed only on a transition, so a deposit first seen in a block
// (a catch-up sync, a payment mined before the wallet noticed it) arrives
// as received with confirmed true and never confirms again.
const CHANNELIZE_EVENTS = Object.freeze(['transaction:received', 'transaction:confirmed', 'channel:ready']);
// Price ceiling for inbound bought from an external primary (bLIP-51). The
// open aborts if the LSP asks more; the engine budgets the lease fee out of
// the contribution against exactly these numbers.
const MAX_LEASE_RATES = Object.freeze({
	fundingWeightWitness: 1000,
	leaseFeeBasis: 100,
	leaseFeeBaseSat: 10000,
	channelFeeMaxBaseMsat: 5000,
	channelFeeMaxProportionalThousandths: 3
});

// What a liquidity provider (a wallet serving as an internal primary) runs
// with unless the operator edits it. Fees are zero because the provider's
// clients are, by default, the operator's own wallets; the caps are the
// engine's own defaults, written out so the operator can see them.
const JIT_DEFAULTS = Object.freeze({
	waiveClientReserve: true,
	flatFeeSat: 0,
	feePpm: 0,
	maxClientFundingSats: 1000000,
	maxConcurrentFundings: 3,
	maxTotalFundingSats: null
});

const JIT_BOUNDS = Object.freeze({
	flatFeeSat: [0, 0xffffffff],
	feePpm: [0, 1000000],
	maxClientFundingSats: [0, Number.MAX_SAFE_INTEGER],
	maxConcurrentFundings: [0, 1000],
	maxTotalFundingSats: [0, Number.MAX_SAFE_INTEGER]
});

// Reverse swaps (beignet #737): a wallet that serves them takes a Lightning
// payment and pays the same amount, minus these fees, to an address the
// payer chose, from its own on-chain balance. Off by default: it commits
// the wallet's coins to a contract the payer can claim, so the operator
// switches it on knowingly. The engine's own defaults for the caps, except
// the flat fee: the engine's quote prices only the funding transaction
// (its miner fee rides the quote), never the provider's own refund
// transaction, which the provider pays when a swap is never claimed. A
// 160 vbyte refund at roughly 3 sat/vb is about 480 sats, so 500 sats
// covers it with a small margin; at 0 every small swap is subsidised.
const SWAP_DEFAULTS = Object.freeze({
	enabled: false,
	flatFeeSat: 500,
	feePpm: 1000,
	minSat: 10000,
	maxSat: 1000000,
	maxExposureSat: 5000000,
	maxConcurrent: 8,
	// The submarine direction (beignet #743, on-chain to Lightning): the node
	// pays a wallet's invoice once the coins the wallet locked to it have
	// confirmed, and claims them with the preimage the payment reveals. Its
	// own margins: how many blocks before the wallet's refund opens the
	// claim must be in by, and the routing fee the payment may spend. The
	// fee, size and exposure caps above apply to both directions.
	submarine: false,
	claimSafetyBlocks: 24,
	paymentMaxFeePpm: 5000
});

const SWAP_BOUNDS = Object.freeze({
	flatFeeSat: [0, 0xffffffff],
	feePpm: [0, 1000000],
	minSat: [1, Number.MAX_SAFE_INTEGER],
	maxSat: [1, Number.MAX_SAFE_INTEGER],
	maxExposureSat: [1, Number.MAX_SAFE_INTEGER],
	maxConcurrent: [1, 1000],
	claimSafetyBlocks: [1, 2016],
	paymentMaxFeePpm: [0, 1000000]
});

function httpError(status, code, message) {
	const err = new Error(message);
	err.status = status;
	err.statusCode = status;
	err.code = code;
	return err;
}

/** `pubkey@host:port` to its parts, or throws naming what is wrong. */
function parseNodeUri(input) {
	const uri = String(input || '').trim();
	const m = uri.match(NODE_URI_RE);
	if (!m) throw new Error('External node URI must be pubkey@host:port');
	const port = parseInt(m[3], 10);
	if (!(port >= 1 && port <= 65535)) throw new Error('External node port must be 1..65535');
	return { pubkey: m[1].toLowerCase(), host: m[2], port, uri: `${m[1].toLowerCase()}@${m[2]}:${port}` };
}

function isLfbw(rec) {
	return !!(rec && rec.lfbw && rec.lfbw.enabled);
}

/**
 * The record block for a lightning-first request, or null when the wallet
 * is not lightning-first. `existing` is the wallet's current block, kept
 * (setup state, the one-time initial open) when the primary is unchanged so
 * an edit that only touches trust does not re-run a first open.
 */
function normalizeLfbw(input, { network, selfId, getRecord, available, existing } = {}) {
	if (!input || !input.enabled) return null;
	if (!available) {
		throw httpError(
			400,
			'LFBW_UNSUPPORTED',
			'The bundled beignet predates lightning-first wallets (JIT receive and direct funding).'
		);
	}
	const sats = parseInt(input.initialChannelSats, 10);
	const initialChannelSats = Number.isFinite(sats) && sats > 0 ? sats : 0;
	let block;
	if (input.primaryWalletId) {
		const peer = getRecord ? getRecord(input.primaryWalletId) : null;
		if (!peer) throw httpError(400, 'BAD_LFBW_PEER', 'The selected primary node does not exist');
		if (selfId && peer.id === selfId) {
			throw httpError(400, 'BAD_LFBW_PEER', 'A wallet cannot be its own primary node');
		}
		if (peer.network !== network) {
			throw httpError(
				400,
				'BAD_LFBW_PEER',
				`The selected primary node is on ${peer.network}, not ${network}`
			);
		}
		if (peer.onchainOnly) {
			throw httpError(
				400,
				'BAD_LFBW_PEER',
				'The selected primary node is on-chain only; a primary must run Lightning'
			);
		}
		if (isLfbw(peer)) {
			throw httpError(
				400,
				'BAD_LFBW_PEER',
				'A lightning-first wallet cannot be another wallet\'s primary node'
			);
		}
		block = {
			enabled: true,
			mode: 'internal',
			primaryWalletId: peer.id,
			primaryUri: null,
			primaryPubkey: peer.nodeId || null,
			// Zero-conf both ways is the point of pairing with your own node;
			// it can be switched off, in which case channels confirm first.
			trusted: input.trusted === undefined ? true : !!input.trusted,
			initialChannelSats
		};
	} else {
		let parsed;
		try {
			parsed = parseNodeUri(input.primaryUri);
		} catch (err) {
			throw httpError(400, 'BAD_LFBW_PEER', err.message);
		}
		block = {
			enabled: true,
			mode: 'external',
			primaryWalletId: null,
			primaryUri: parsed.uri,
			primaryPubkey: parsed.pubkey,
			// The wallet's trust toward its primary is what lets the primary's
			// zero-conf channel (a JIT open) be used the moment the payment
			// arrives; without it the primary cannot provision inbound just in
			// time (its open is refused as untrusted), only deposits and
			// direct funding work, and they confirm first. On by default in
			// both modes; the external node's trust toward us is its own.
			trusted: input.trusted === undefined ? true : !!input.trusted,
			// A starting channel is opened FROM the primary, which we cannot
			// command on an external node.
			initialChannelSats: 0
		};
	}
	const samePrimary =
		existing &&
		existing.enabled &&
		existing.mode === block.mode &&
		existing.primaryWalletId === block.primaryWalletId &&
		existing.primaryUri === block.primaryUri;
	return {
		...block,
		initialChannelOpened: samePrimary ? !!existing.initialChannelOpened : false,
		setup: samePrimary ? existing.setup || 'pending' : 'pending',
		setupError: samePrimary ? existing.setupError || null : null,
		setupAt: samePrimary ? existing.setupAt || null : null,
		previousPrimary: previousPrimaryAfterEdit(existing, block, samePrimary)
	};
}

/**
 * Re-pointing the primary does not close the channel with the old one: the
 * simple view lists channels with the CURRENT primary only, so without a
 * record of the old one its balance would vanish from "Your channel" while
 * Total still counts it (umbrel #86). The old primary is remembered here
 * until the wallet has no channel with it any more (previousPrimaryDone),
 * so the Overview can show that channel and offer to move its funds.
 *
 * Switching back to the remembered primary forgets it (its channel is the
 * home channel again); any other change replaces it, since the channel with
 * an intermediate primary is what channelize will have been funding.
 */
function previousPrimaryAfterEdit(existing, block, samePrimary, now = Date.now()) {
	if (!existing || !existing.enabled) return null;
	if (samePrimary) return existing.previousPrimary || null;
	if (!existing.primaryPubkey) return existing.previousPrimary || null;
	if (block.primaryPubkey && block.primaryPubkey === existing.primaryPubkey) return null;
	if (existing.previousPrimary && block.primaryPubkey === existing.previousPrimary.pubkey) return null;
	return {
		pubkey: existing.primaryPubkey,
		walletId: existing.mode === 'internal' ? existing.primaryWalletId || null : null,
		at: now
	};
}

/** Whether the wallet has no live channel with its previous primary left. */
function previousPrimaryDone(previousPrimary, channels) {
	if (!previousPrimary || !previousPrimary.pubkey) return true;
	return !(channels || []).some((c) => c.peerPubkey === previousPrimary.pubkey && isLive(c));
}

/** The live channels with the previous primary that a move should close: the usable ones. */
function previousPrimaryChannels(previousPrimary, channels) {
	if (!previousPrimary || !previousPrimary.pubkey) return [];
	return (channels || []).filter((c) => c.peerPubkey === previousPrimary.pubkey && isLive(c));
}

/** The lightning-first wallets whose internal primary is `rec`. */
function dependentsOf(rec, records) {
	if (!rec) return [];
	return (records || []).filter(
		(r) =>
			r.id !== rec.id &&
			isLfbw(r) &&
			r.lfbw.mode === 'internal' &&
			r.lfbw.primaryWalletId === rec.id
	);
}

/** Validated JIT provider policy, defaults filled in, or throws. */
function normalizeJit(input, existing) {
	const base = { ...JIT_DEFAULTS, ...(existing || {}) };
	base.waiveClientReserve = base.waiveClientReserve === true;
	if (input === undefined || input === null) return base;
	if (typeof input !== 'object') throw httpError(400, 'BAD_JIT', 'jit must be an object');
	const out = { ...base };
	if ('waiveClientReserve' in input) {
		if (typeof input.waiveClientReserve !== 'boolean') {
			throw httpError(400, 'BAD_JIT', 'waiveClientReserve must be a boolean');
		}
		out.waiveClientReserve = input.waiveClientReserve;
	}
	for (const key of Object.keys(JIT_BOUNDS)) {
		if (!(key in input)) continue;
		const raw = input[key];
		if (raw === null || raw === '') {
			if (key === 'maxTotalFundingSats') {
				out[key] = null;
				continue;
			}
			throw httpError(400, 'BAD_JIT', `${key} must be a whole number`);
		}
		const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
		const [lo, hi] = JIT_BOUNDS[key];
		if (!Number.isInteger(n) || n < lo || n > hi) {
			throw httpError(400, 'BAD_JIT', `${key} must be a whole number between ${lo} and ${hi}`);
		}
		out[key] = n;
	}
	return out;
}

/** Validated reverse swap policy, defaults filled in, or throws. */
function normalizeSwaps(input, existing) {
	const base = { ...SWAP_DEFAULTS, ...(existing || {}) };
	if (input === undefined || input === null) return base;
	if (typeof input !== 'object') throw httpError(400, 'BAD_SWAPS', 'swaps must be an object');
	const out = { ...base };
	if ('enabled' in input) out.enabled = !!input.enabled;
	if ('submarine' in input) out.submarine = !!input.submarine;
	for (const key of Object.keys(SWAP_BOUNDS)) {
		if (!(key in input)) continue;
		const raw = input[key];
		if (raw === null || raw === '' || (typeof raw !== 'number' && typeof raw !== 'string')) {
			throw httpError(400, 'BAD_SWAPS', `${key} must be a whole number`);
		}
		const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
		const [lo, hi] = SWAP_BOUNDS[key];
		if (!Number.isInteger(n) || n < lo || n > hi) {
			throw httpError(400, 'BAD_SWAPS', `${key} must be a whole number between ${lo} and ${hi}`);
		}
		out[key] = n;
	}
	if (out.minSat > out.maxSat) {
		throw httpError(400, 'BAD_SWAPS', 'minSat must not exceed maxSat');
	}
	if (out.maxExposureSat < out.maxSat) {
		throw httpError(400, 'BAD_SWAPS', 'maxExposureSat must be at least maxSat');
	}
	return out;
}

/**
 * The env fragment for a wallet that serves swaps. Only a liquidity
 * provider that runs Lightning can: the role needs the listener and the
 * on-chain wallet the engine funds from and claims to. Nothing for anyone
 * else, so a wallet that does not serve swaps sees the env it always saw.
 * The submarine direction rides the same switch (BEIGNET_SWAP_SUBMARINE
 * means nothing to the engine without BEIGNET_SWAPS) and adds its own two
 * margins only when it is on, so a reverse-only provider's env is unchanged.
 */
function swapsEnv(rec) {
	if (!rec || !rec.liquidityProvider || rec.onchainOnly) return {};
	const swaps = normalizeSwaps(undefined, rec.swaps);
	if (!swaps.enabled) return {};
	const env = {
		BEIGNET_SWAPS: 'true',
		BEIGNET_SWAP_FLAT_FEE_SAT: String(swaps.flatFeeSat),
		BEIGNET_SWAP_FEE_PPM: String(swaps.feePpm),
		BEIGNET_SWAP_MIN_SAT: String(swaps.minSat),
		BEIGNET_SWAP_MAX_SAT: String(swaps.maxSat),
		BEIGNET_SWAP_MAX_EXPOSURE_SAT: String(swaps.maxExposureSat),
		BEIGNET_SWAP_MAX_CONCURRENT: String(swaps.maxConcurrent)
	};
	if (swaps.submarine) {
		env.BEIGNET_SWAP_SUBMARINE = 'true';
		env.BEIGNET_SWAP_CLAIM_SAFETY_BLOCKS = String(swaps.claimSafetyBlocks);
		env.BEIGNET_SWAP_PAYMENT_MAX_FEE_PPM = String(swaps.paymentMaxFeePpm);
	}
	return env;
}

/**
 * The env fragment for a wallet that provides liquidity to lightning-first
 * wallets: the engine's JIT LSP role with its fee and exposure caps, and
 * the blind relay for direct-funding frames. Nothing for anyone else, so a
 * wallet that is not a provider sees the env it always saw.
 */
function providerEnv(rec) {
	if (!rec || !rec.liquidityProvider || rec.onchainOnly) return {};
	const jit = normalizeJit(undefined, rec.jit);
	const env = {
		BEIGNET_JIT_RECEIVE: 'true',
		BEIGNET_WAIVE_CLIENT_RESERVE: String(jit.waiveClientReserve),
		BEIGNET_JIT_FLAT_FEE_SAT: String(jit.flatFeeSat),
		BEIGNET_JIT_FEE_PPM: String(jit.feePpm),
		BEIGNET_JIT_MAX_CLIENT_FUNDING_SAT: String(jit.maxClientFundingSats),
		BEIGNET_JIT_MAX_CONCURRENT_FUNDINGS: String(jit.maxConcurrentFundings),
		BEIGNET_DF_RELAY: 'true'
	};
	if (jit.maxTotalFundingSats !== null && jit.maxTotalFundingSats !== undefined) {
		env.BEIGNET_JIT_MAX_TOTAL_FUNDING_SAT = String(jit.maxTotalFundingSats);
	}
	return Object.assign(env, swapsEnv(rec));
}

// Operator-level engine policy passed through from the manager's own env,
// exactly as written: the daemon validates them and refuses startup by
// name, which the Logs tab shows.
const OPERATOR_PASSTHROUGH = Object.freeze([
	'BEIGNET_FEE_BASE_MSAT',
	'BEIGNET_FEE_PPM',
	'BEIGNET_CLTV_DELTA',
	'BEIGNET_LEASE_RATES',
	'BEIGNET_DF_MIN_AMOUNT'
]);

function operatorEnv(source = process.env) {
	const env = {};
	for (const key of OPERATOR_PASSTHROUGH) {
		if (source[key] !== undefined && String(source[key]).trim() !== '') env[key] = source[key];
	}
	return env;
}

/** True when a running daemon spawned with `spawned` needs a restart to serve as a provider. */
function providerRoleChanged(spawnedEnv, rec) {
	const want = providerEnv(rec);
	const have = spawnedEnv || {};
	const keys = new Set([...Object.keys(want), ...Object.keys(have).filter((k) => /^BEIGNET_(JIT_|DF_RELAY|WAIVE_CLIENT_RESERVE)/.test(k))]);
	for (const k of keys) {
		if ((want[k] || null) !== (have[k] || null)) return true;
	}
	return false;
}

/**
 * The direct-funding policy a lightning-first wallet arms on its own daemon.
 * The primary is the liquidity peer every direct-funded channel is
 * negotiated with, and its reachable address is signed into every request
 * as the relay descriptor for payers who cannot reach the wallet directly.
 * `allowSplice` is what keeps ONE home channel: a paired payer's payment
 * grows it rather than opening a second. `allowUnpairedSplice` extends that
 * to every beignet payer (beignet #760): a stranger's confirmed coin splices
 * the home channel too, locking only after the engine's depth (three
 * confirmations by default) so the coin is never the live funding before
 * the chain has it, and a double spent coin is reverted with the primary.
 * Both are sent only when the engine has the fields, because an engine
 * that lacks them refuses unknown keys nowhere but would also do nothing
 * with them.
 */
function directFundingConfig(lf, primary, { allowSpliceSupported = true } = {}) {
	const cfg = {
		lspPubkey: primary.pubkey,
		lspHost: primary.relayHost,
		lspPort: primary.relayPort,
		// Internal pairs buy no inbound alongside (JIT covers it for free);
		// an external primary is asked to sell the default target.
		targetInboundSat: lf.mode === 'external' ? DEFAULT_INBOUND_SATS : 0,
		trusted: lf.trusted === true
	};
	if (allowSpliceSupported) {
		cfg.allowSplice = true;
		cfg.allowUnpairedSplice = true;
	}
	return cfg;
}


/**
 * Where a payer can reach this wallet, signed into its payment requests: the
 * public address first, at the host port the app publishes (umbrel #193),
 * because it is the faster path and a phone payer rarely has Tor; else the
 * onion when the wallet announces one. The public host is the wallet's own
 * when it announces one, else a host the operator exposed themselves
 * (PUBLIC_HOST on the manager, for the regtest harness and LAN setups),
 * paired with the listen port when no published port is known. Null means
 * the request carries no direct address and payers reach the wallet through
 * the primary's relay or the onion-message lane.
 */
function walletReach({ onionAddress, listenPort, publicHost, publicPort } = {}) {
	const host = publicHost && String(publicHost).trim();
	const port = publicPort || listenPort;
	if (host && port) return { host, port };
	if (onionAddress) {
		const at = onionAddress.lastIndexOf(':');
		return { host: onionAddress.slice(0, at), port: parseInt(onionAddress.slice(at + 1), 10) };
	}
	return null;
}

/** sat/vB to the sat/kw the splice routes take, never under the 253 floor. */
function perkwFromSatVb(satsPerVbyte) {
	const rate = Number(satsPerVbyte);
	if (!Number.isFinite(rate) || rate <= 0) return 253;
	return Math.max(253, Math.round(rate * 250));
}

function isUsable(c) {
	return c.htlcUsable != null ? !!c.htlcUsable : c.state === 'NORMAL';
}

function isLive(c) {
	return c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED';
}

/** The channels a lightning-first wallet has with its primary, split by usability. */
function channelsWithPrimary(channels, primaryPubkey) {
	const live = (channels || []).filter((c) => c.peerPubkey === primaryPubkey && isLive(c));
	return {
		usable: live.filter(isUsable),
		pending: live.filter((c) => !isUsable(c)),
		home: live.find(isUsable) || null
	};
}

/**
 * What channelize should do next, from the wallet's live state and before
 * any quote is fetched. RBF safety: an on-chain deposit can be replaced by
 * its sender until it confirms, and channelizing an unconfirmed deposit
 * would hand the pair a channel whose funding the depositor can still yank,
 * so nothing moves while any UTXO is unconfirmed; one block settles it.
 */
function channelizeTarget({ onchainSats, utxos, channels, primaryPubkey }) {
	if (!(onchainSats >= CHANNELIZE_FLOOR_SATS)) return { action: 'wait', reason: 'below-floor' };
	if (!Array.isArray(utxos)) return { action: 'wait', reason: 'no-utxos' };
	if (utxos.some((u) => !u.height || u.height <= 0)) return { action: 'wait', reason: 'unconfirmed' };
	const { home, pending } = channelsWithPrimary(channels, primaryPubkey);
	if (home) {
		if (home.state === 'SPLICING') return { action: 'wait', reason: 'splicing' };
		return { action: 'splice-in', channelId: home.channelId };
	}
	if (pending.length > 0) return { action: 'wait', reason: 'channel-pending' };
	return { action: 'open' };
}

/**
 * The daemon call that carries out a channelize target, once the quote for
 * it is in hand. Splice: the daemon prices the splice and its maxAmountSats
 * is already net of the fee. Open: the wallet quotes the exact max a channel
 * funding can carry at this rate; an external primary is first asked to sell
 * inbound in a dual-funded open (bLIP-51), with the lease fee ceiling and
 * the funding margin budgeted out of the contribution, and the plain open is
 * the fallback the manager runs if that is refused.
 */
function channelizeOrder(
	target,
	{ spliceQuote, txQuote, feeNormal, mode, trusted, blockHeight, primary, force = false } = {}
) {
	const satsPerVbyte = feeNormal > 0 ? feeNormal : 2;
	if (target.action === 'splice-in') {
		const amount = spliceQuote ? spliceQuote.maxAmountSats : 0;
		if (!amount || amount < CHANNELIZE_FLOOR_SATS - FUNDING_FEE_MARGIN_SATS) {
			return { action: 'wait', reason: 'quote-too-small' };
		}
		const feeWait = feeTooHigh(amount, spliceQuote.feeSats, force);
		if (feeWait) return feeWait;
		return {
			action: 'splice-in',
			body: { channelId: target.channelId, amountSats: amount, feeratePerkw: perkwFromSatVb(satsPerVbyte) }
		};
	}
	if (target.action === 'open') {
		const amount = txQuote && txQuote.maxSendSats;
		if (!amount || amount < MIN_CHANNEL_SATS) return { action: 'wait', reason: 'quote-too-small' };
		const feeWait = feeTooHigh(amount, txQuote.feeSats, force);
		if (feeWait) return feeWait;
		const open = {
			pubkey: primary.pubkey,
			host: primary.connectHost,
			port: primary.connectPort,
			amountSats: amount,
			satsPerVbyte,
			max: true,
			// Zero-conf is explicit opt-in per open: a paired internal primary
			// negotiates option_zeroconf so the channel is usable at broadcast;
			// an external primary that does not trust us would reject the type.
			trusted: mode === 'internal' && trusted === true
		};
		if (mode === 'external') {
			const requested = Math.min(amount, DEFAULT_INBOUND_SATS);
			const leaseFeeCeil =
				MAX_LEASE_RATES.leaseFeeBaseSat + Math.ceil((requested * MAX_LEASE_RATES.leaseFeeBasis) / 10000);
			const v2Amount = amount - leaseFeeCeil - FUNDING_FEE_MARGIN_SATS;
			if (v2Amount >= MIN_CHANNEL_SATS && blockHeight > 0) {
				return {
					action: 'open-v2',
					body: {
						pubkey: primary.pubkey,
						amountSats: v2Amount,
						requestFunds: { requestedSats: requested, blockheight: blockHeight },
						maxLeaseRates: { ...MAX_LEASE_RATES }
					},
					fallback: { action: 'open', body: open }
				};
			}
		}
		return { action: 'open', body: open };
	}
	return target;
}

/**
 * The fee rule: the amount a move carries must be at least the multiple of
 * the fee the daemon quoted for it, unless the owner forces the move. The
 * channel minimums above are never forced past; only the fee wait is. A
 * quote that carries no fee (an older daemon) cannot be judged and passes.
 */
function feeTooHigh(amountSats, feeSats, force) {
	const fee = Number(feeSats) || 0;
	if (force || fee <= 0) return null;
	if (amountSats >= CHANNELIZE_FEE_MULTIPLE * fee) return null;
	return { action: 'wait', reason: 'fee-too-high', feeSats: fee, amountSats };
}

module.exports = {
	NODE_URI_RE,
	CHANNELIZE_FLOOR_SATS,
	CHANNELIZE_FEE_MULTIPLE,
	MIN_CHANNEL_SATS,
	FUNDING_FEE_MARGIN_SATS,
	DEFAULT_INBOUND_SATS,
	INBOUND_HEADROOM_SATS,
	CALL_TIMEOUT_MS,
	HEALTH_TIMEOUT_MS,
	CHANNELIZE_POLL_MS,
	CHANNELIZE_RETRY_MS,
	CHANNELIZE_DEBOUNCE_MS,
	CHANNELIZE_EVENTS,
	MAX_LEASE_RATES,
	JIT_DEFAULTS,
	SWAP_DEFAULTS,
	SWAP_BOUNDS,
	normalizeSwaps,
	swapsEnv,
	OPERATOR_PASSTHROUGH,
	parseNodeUri,
	isLfbw,
	normalizeLfbw,
	previousPrimaryAfterEdit,
	previousPrimaryDone,
	previousPrimaryChannels,
	dependentsOf,
	normalizeJit,
	providerEnv,
	operatorEnv,
	providerRoleChanged,
	directFundingConfig,
	walletReach,
	perkwFromSatVb,
	channelsWithPrimary,
	channelizeTarget,
	channelizeOrder
};
