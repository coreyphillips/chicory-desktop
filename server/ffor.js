'use strict';

/**
 * FFOR offline receive (Fast-Forward Offline Receive, spec at
 * github.com/coreyphillips/ffor, beignet #729 and #865): the pure rules the
 * manager applies before it spawns a daemon or asks one to act. A wallet
 * that opts in settles offline receives for its siblings (the settlement
 * peer, S in the spec); any Lightning wallet can be the receiver (R). The
 * daemon validates the same switches and refuses by name, but a refusal at
 * spawn time only ever shows up in the Logs tab after a restart loop, so
 * the manager checks first and answers the request that made it with a 400.
 *
 * Nothing here does I/O. wallet-manager.js is the I/O around it.
 */

// The settlement peer's terms. The caps are what the daemon reads from
// BEIGNET_FFOR_MAX_BUDGET_MSAT and BEIGNET_FFOR_MAX_EPOCH_BLOCKS (unset
// means no cap), the fees are the floor a receiver's book must meet.
const SETTLE_DEFAULTS = Object.freeze({
	enabled: false,
	acceptConcurrent: true,
	maxBudgetMsat: null,
	maxEpochBlocks: null,
	feeBaseMsat: 0,
	feePpm: 0
});

// The receipt witness's caps (BEIGNET_FFOR_WITNESS_MAX_MAILBOXES and
// _MAX_BYTES, unset means the engine's defaults) and the issuer switch,
// which the daemon refuses to start with unless the witness is on: the
// issuer is co-hosted with the first receipt witness.
const FUNDING_DEFAULTS = Object.freeze({
	enabled: false,
	maxChannels: 20,
	maxChannelsPerPeer: 5,
	maxChannelSats: 1000000,
	maxTotalSats: 5000000
});
const FUNDING_BOUNDS = Object.freeze({
	maxChannels: [1, 100000, false],
	maxChannelsPerPeer: [1, 100000, false],
	maxChannelSats: [1, Number.MAX_SAFE_INTEGER, false],
	maxTotalSats: [1, Number.MAX_SAFE_INTEGER, false]
});

const WITNESS_DEFAULTS = Object.freeze({ enabled: false, maxMailboxes: null, maxBytes: null });
const ISSUER_DEFAULTS = Object.freeze({ enabled: false });
const WITNESS_BOUNDS = Object.freeze({
	maxMailboxes: [1, 100000, true],
	maxBytes: [1024, Number.MAX_SAFE_INTEGER, true]
});

// [min, max, optional]. An optional cap clears with null or ''.
const SETTLE_BOUNDS = Object.freeze({
	maxBudgetMsat: [1, Number.MAX_SAFE_INTEGER, true],
	// The engine refuses a book whose voucher expiry sits under the
	// settlement deadline plus 1008 blocks, so a cap below that would
	// refuse every epoch; a year is the upper bound for a pre-signed book.
	maxEpochBlocks: [1008, 52560, true],
	feeBaseMsat: [0, 1000000, false],
	feePpm: [0, 100000, false]
});

// The epoch states the daemon reports (its FforState enum, as strings).
const EPOCH_STATES = Object.freeze([
	'NEGOTIATING',
	'VOUCHERS_COMMITTED',
	'ACTIVATING',
	'ACTIVE',
	'DRAINING',
	'CLOSED',
	'ABORTED'
]);

// A receiver's epoch in one of these states has a settlement peer that
// may hold credits for it, so a fresh start reconciles it.
const RETURN_STATES = Object.freeze(['ACTIVE', 'DRAINING']);

// Every event the daemon relays for the feature (beignet #729).
const FFOR_EVENTS = Object.freeze([
	'ffor:state',
	'ffor:slot-resolved',
	'ffor:settled',
	'ffor:delegated-failed',
	'ffor:enforce',
	'ffor:witness-provisioned',
	'ffor:witness-recorded',
	'ffor:witness-released',
	'ffor:issuer-provisioned',
	'ffor:issuer-issued'
]);

// The two that name the epoch's channel and belong in its history.
const FFOR_CHANNEL_EVENTS = Object.freeze(['ffor:state', 'ffor:enforce']);

// How long an epoch start waits for the two sides to sign the book, and
// how long a witness provision waits for the acknowledgement to land on
// the epoch record (the daemon awaits the ack, so this is a backstop).
const SETUP_ACTIVE_TIMEOUT_MS = 60000;
const SETUP_ACK_TIMEOUT_MS = 15000;

// How long a fresh start waits for the channel to the settlement peer to
// reestablish before asking the daemon to reconcile anyway. A sibling on
// loopback is back within seconds; a peer through Tor can take a minute.
const RETURN_REESTABLISH_TIMEOUT_MS = 90000;
const RETURN_POLL_MS = 2000;
// How long a return waits for the cooperative close to drain after the
// peer accepted it, before recording whatever the epoch reads; and how
// long the manager keeps watching a drain that outlasted that, updating
// the record when it completes.
const RETURN_DRAIN_TIMEOUT_MS = 30000;
const DRAIN_TRACK_TIMEOUT_MS = 10 * 60 * 1000;
const DRAIN_TRACK_POLL_MS = 5000;

// A channel in one of these states takes no channel actions any more: an
// epoch on it is enforced on-chain (or long gone), never reconciled.
const CLOSED_CHANNEL_STATES = Object.freeze(['CLOSED', 'FORCE_CLOSED']);

function httpError(status, code, message) {
	const err = new Error(message);
	err.status = status;
	err.statusCode = status;
	err.code = code;
	return err;
}

// One role block: the switch plus its bounded caps, an edit keeping what
// it does not name, an optional cap clearing on null or ''.
function normalizeRole(name, input, base, bounds) {
	const out = { ...base };
	if (input === undefined) return out;
	if (input === null || typeof input !== 'object') {
		throw httpError(400, 'BAD_FFOR', `ffor.${name} must be an object`);
	}
	if ('enabled' in input) out.enabled = !!input.enabled;
	if (name === 'settle' && 'acceptConcurrent' in input) {
		if (typeof input.acceptConcurrent !== 'boolean') throw httpError(400, 'BAD_FFOR', 'acceptConcurrent must be a boolean');
		 out.acceptConcurrent = input.acceptConcurrent;
	}
	for (const key of Object.keys(bounds)) {
		if (!(key in input)) continue;
		const raw = input[key];
		const [lo, hi, optional] = bounds[key];
		if (raw === null || raw === '') {
			if (optional) {
				out[key] = null;
				continue;
			}
			throw httpError(400, 'BAD_FFOR', `${key} must be a whole number`);
		}
		if (typeof raw !== 'number' && typeof raw !== 'string') {
			throw httpError(400, 'BAD_FFOR', `${key} must be a whole number`);
		}
		const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
		if (!Number.isInteger(n) || n < lo || n > hi) {
			throw httpError(400, 'BAD_FFOR', `${key} must be a whole number between ${lo} and ${hi}`);
		}
		out[key] = n;
	}
	return out;
}

/** Validated FFOR block for a record, defaults filled in, or throws. */
function normalizeFfor(input, existing) {
	const ex = existing || {};
	const base = {
		concurrent: { enabled: true, ...(ex.concurrent || {}) },
		settle: { ...SETTLE_DEFAULTS, ...(ex.settle || {}) },
		funding: { ...FUNDING_DEFAULTS, ...(ex.funding || {}) },
		witness: { ...WITNESS_DEFAULTS, ...(ex.witness || {}) },
		issuer: { ...ISSUER_DEFAULTS, ...(ex.issuer || {}) }
	};
	if (input === undefined || input === null) return base;
	if (typeof input !== 'object') throw httpError(400, 'BAD_FFOR', 'ffor must be an object');
	const out = {
		concurrent: normalizeRole('concurrent', input.concurrent, base.concurrent, {}),
		settle: normalizeRole('settle', input.settle, base.settle, SETTLE_BOUNDS),
		funding: normalizeRole('funding', input.funding, base.funding, FUNDING_BOUNDS),
		witness: normalizeRole('witness', input.witness, base.witness, WITNESS_BOUNDS),
		issuer: normalizeRole('issuer', input.issuer, base.issuer, {})
	};
	// The daemon refuses to start with the issuer and no witness (the
	// issuer is co-hosted with the first receipt witness), so the record
	// refuses the same combination on the request that made it.
	if (out.funding.enabled && !out.settle.enabled)
		throw httpError(400, 'BAD_FFOR', 'Enable settlement before receive-channel funding.');
	if (out.issuer.enabled && !out.witness.enabled) {
		throw httpError(400, 'BAD_FFOR', 'The issuer runs on a receipt witness: turn on the witness too.');
	}
	return out;
}

/** True when the record opts in as a settlement peer and runs Lightning. */
function isSettler(rec) {
	return !!(rec && !rec.onchainOnly && rec.ffor && rec.ffor.settle && rec.ffor.settle.enabled);
}

/** True when the record serves as a receipt witness and runs Lightning. */
function isWitness(rec) {
	return !!(rec && !rec.onchainOnly && rec.ffor && rec.ffor.witness && rec.ffor.witness.enabled);
}

/** True when the record answers BOLT 12 requests as an issuer (implies witness). */
function isIssuer(rec) {
	return isWitness(rec) && !!(rec.ffor.issuer && rec.ffor.issuer.enabled);
}

/** True when the record holds any FFOR role. */
function hasFforRole(rec) {
	return isSettler(rec) || isWitness(rec);
}

/**
 * The env fragment for a wallet that settles offline receives. Nothing for
 * anyone else, so a wallet that does not opt in sees the env it always saw
 * and an engine that predates the feature never meets the switch. The
 * daemon reads exactly the string 'true'; the caps ride only when set.
 */
function fforEnv(rec) {
	if (rec?.onchainOnly) return {};
	const { settle, witness, issuer, funding, concurrent } = normalizeFfor(undefined, rec?.ffor);
	const env = {};
	if (!concurrent.enabled) env.BEIGNET_FFOR_CONCURRENT = 'false';
	if (settle.enabled) {
		env.BEIGNET_FFOR_SETTLE = 'true';
		if (!settle.acceptConcurrent) env.BEIGNET_FFOR_SETTLE_CONCURRENT = 'false';
		if (funding.enabled) env.BEIGNET_FFOR_RECEIVE_FUNDING = JSON.stringify(funding);
		env.BEIGNET_FFOR_FEE_BASE_MSAT = String(settle.feeBaseMsat);
		env.BEIGNET_FFOR_FEE_PPM = String(settle.feePpm);
		if (settle.maxBudgetMsat !== null && settle.maxBudgetMsat !== undefined) {
			env.BEIGNET_FFOR_MAX_BUDGET_MSAT = String(settle.maxBudgetMsat);
		}
		if (settle.maxEpochBlocks !== null && settle.maxEpochBlocks !== undefined) {
			env.BEIGNET_FFOR_MAX_EPOCH_BLOCKS = String(settle.maxEpochBlocks);
		}
	}
	if (witness.enabled) {
		env.BEIGNET_FFOR_WITNESS = 'true';
		if (witness.maxMailboxes !== null && witness.maxMailboxes !== undefined) {
			env.BEIGNET_FFOR_WITNESS_MAX_MAILBOXES = String(witness.maxMailboxes);
		}
		if (witness.maxBytes !== null && witness.maxBytes !== undefined) {
			env.BEIGNET_FFOR_WITNESS_MAX_BYTES = String(witness.maxBytes);
		}
		// The issuer rides the witness: the daemon refuses it alone.
		if (issuer.enabled) env.BEIGNET_FFOR_ISSUER = 'true';
	}
	return env;
}

/** True when a running daemon spawned with `spawned` needs a restart for the FFOR role the record wants. */
function fforRoleChanged(spawnedEnv, rec) {
	const want = fforEnv(rec);
	const have = spawnedEnv || {};
	const keys = new Set([...Object.keys(want), ...Object.keys(have).filter((k) => /^BEIGNET_FFOR_/.test(k))]);
	for (const k of keys) {
		if ((want[k] || null) !== (have[k] || null)) return true;
	}
	return false;
}

/**
 * The siblings a wallet can pick an FFOR party among: same network, not
 * itself, holding a role, with a node id the dashboard can match against
 * the wallet's channels. Each carries which roles it holds (a settlement
 * peer, a receipt witness, an issuer). Every beignet node advertises the
 * FFOR feature bit whether or not it serves, so the record is the only
 * honest source.
 */
function settlementCandidates(records, self, runningOf = () => false) {
	return (records || [])
		.filter((rec) => rec && rec.id !== self.id && rec.network === self.network && hasFforRole(rec) && rec.nodeId)
		.map((rec) => ({
			id: rec.id,
			name: rec.name,
			nodeId: rec.nodeId,
			running: !!runningOf(rec),
			settles: isSettler(rec),
			witnesses: isWitness(rec),
			issues: isIssuer(rec)
		}));
}

/**
 * The path-template hop a witness contributes to the issuer's blinded
 * payment paths: the witness's own channel toward the settlement peer and
 * the forwarding policy it applies on it (GET /channel/policy on the
 * witness). The engine appends S (with the epoch's fee terms) and R.
 */
function witnessHop(witnessNodeId, channel, policy) {
	if (!channel || !channel.shortChannelId) return null;
	if (!policy) return null;
	return {
		nodeId: witnessNodeId,
		shortChannelId: String(channel.shortChannelId),
		feeBaseMsat: Number(policy.feeBaseMsat) || 0,
		feeProportionalMillionths: Number(policy.feeProportionalMillionths) || 0,
		cltvExpiryDelta: Number(policy.cltvExpiryDelta) || 0,
		htlcMinimumMsat: policy.htlcMinimumMsat != null ? String(policy.htlcMinimumMsat) : '1',
		htlcMaximumMsat: policy.htlcMaximumMsat != null ? String(policy.htlcMaximumMsat) : '0'
	};
}

/**
 * The fee terms a book on a channel with a sibling settlement peer must
 * carry: the peer's own forwarding policy on that channel (what a payer
 * reads off the graph when the channel is public), never under the floor
 * the peer's settle role sets. Null when the policy could not be read.
 */
function settlerTerms(policy, settler) {
	if (!policy || policy.feeBaseMsat == null || policy.feeProportionalMillionths == null) return null;
	const floor = normalizeFfor(undefined, settler && settler.ffor).settle;
	return {
		feeBaseMsat: Math.max(Number(policy.feeBaseMsat) || 0, floor.feeBaseMsat || 0),
		feeProportionalMillionths: Math.max(Number(policy.feeProportionalMillionths) || 0, floor.feePpm || 0)
	};
}

/**
 * Validate an epoch setup request against the siblings: every witness a
 * sibling that witnesses, none of them the settlement peer itself (the
 * witness sits upstream of S), the issuer one of the witnesses and an
 * issuer. Returns the resolved parties or throws a 400.
 */
function planSetup({ witnessWalletIds = [], issuer = null, concurrent = false, concurrentVersion }, candidates, settlerNodeId) {
	if (concurrent && concurrentVersion !== 2) throw httpError(400, 'BAD_FFOR_SETUP', 'Concurrent setup requires version 2');
	if (concurrent && issuer) throw httpError(400, 'BAD_FFOR_SETUP', 'Concurrent version 2 issuer provisioning is not available');
	const byId = new Map((candidates || []).map((c) => [c.id, c]));
	const witnesses = [];
	for (const walletId of witnessWalletIds) {
		const c = byId.get(walletId);
		if (c && settlerNodeId && c.nodeId === settlerNodeId) {
			throw httpError(
				400,
				'BAD_FFOR_SETUP',
				`"${c.name}" is the settlement peer; a witness sits on the path before it`
			);
		}
		if (!c || !c.witnesses)
			throw httpError(400, 'BAD_FFOR_SETUP', `"${walletId}" is not a sibling that keeps receipts`);
		if (!c.running) throw httpError(400, 'BAD_FFOR_SETUP', `"${c.name}" is not running`);
		if (!witnesses.some((w) => w.id === c.id)) witnesses.push(c);
	}
	let issuerParty = null;
	if (issuer && issuer.walletId) {
		const c = byId.get(issuer.walletId);
		if (!c || !c.issues)
			throw httpError(400, 'BAD_FFOR_SETUP', `"${issuer.walletId}" is not a sibling that issues invoices`);
		if (!witnesses.some((w) => w.id === c.id)) {
			throw httpError(400, 'BAD_FFOR_SETUP', `The issuer "${c.name}" must be one of the witnesses`);
		}
		const description = typeof issuer.description === 'string' ? issuer.description.trim() : '';
		if (!description) throw httpError(400, 'BAD_FFOR_SETUP', 'The offer needs a description');
		issuerParty = { ...c, description };
	}
	return { witnesses, issuer: issuerParty, ...(concurrent ? { concurrent: true, concurrentVersion: 2 } : {}) };
}

/**
 * The channel ids of this wallet's own epochs a fresh start should
 * reconcile: ACTIVE or DRAINING, on a channel that still operates. An
 * epoch on a force-closed channel is being claimed on-chain; asking the
 * daemon to recover it would only report the peer as unreachable.
 */
function returnJobs(epochs, channels, withProfile = false) {
	const closed = new Set(
		(Array.isArray(channels) ? channels : [])
			.filter((c) => c && CLOSED_CHANNEL_STATES.includes(c.state))
			.map((c) => String(c.channelId))
	);
	return (Array.isArray(epochs) ? epochs : [])
		.filter(
			(e) => e && e.role === 'R' && RETURN_STATES.includes(e.state) && e.channelId && !closed.has(String(e.channelId))
		)
		.map((e) => withProfile ? { channelId: String(e.channelId), concurrentVersion: e.concurrentVersion } : String(e.channelId));
}

/**
 * What a return came to, read off the epoch and the channel rather than
 * the daemon's action: the action says what the recover call initiated,
 * and it answers 'nothing' for a drain in progress and for an epoch that
 * already closed as well as for a peer that is not there.
 *
 *   closed      the epoch closed cooperatively (credit through the bitmap)
 *   force-closed the recover call force-closed the channel
 *   draining    the peer accepted the close; the vouchers are settling
 *   enforced    the channel is closed on-chain while the epoch reads
 *               ACTIVE: the settled vouchers are claimed as it confirms
 *   unreachable the epoch is live and the peer did not answer
 *   failed      the daemon refused the call
 */
function returnOutcome({ action, epoch, channelState, error }) {
	if (error) return 'failed';
	const state = epoch ? epoch.state : null;
	if (state === 'CLOSED' || state === 'ABORTED') return action === 'force-closed' ? 'force-closed' : 'closed';
	if (action === 'force-closed') return 'force-closed';
	if (state === 'DRAINING') return 'draining';
	if (channelState && CLOSED_CHANNEL_STATES.includes(channelState)) return 'enforced';
	if (action === 'synced' && state === 'ACTIVE') return 'synced';
	return 'unreachable';
}

/**
 * What a return produced, from the daemon's /ffor/recover answer. Never
 * complete while the peer was unreachable (action 'nothing') or a slot the
 * wallet could still be owed reads unsettled: the credit is only real once
 * the epoch closed with the settled bitmap in hand.
 */
function describeReturn(result) {
	if (!result || typeof result !== 'object') return null;
	const epoch = result.epoch || null;
	const slots = (epoch && Array.isArray(epoch.slots) ? epoch.slots : []).map((s) => s.state);
	const concurrent = epoch?.concurrent === true;
	const settled = slots.filter((s) => s === (concurrent ? 'redeemed' : 'settled')).length;
	const unsettled = concurrent ? slots.filter((s) => !['redeemed', 'cancelled'].includes(s)).length : slots.filter((s) => s === 'unsettled').length;
	// preimagesKnown is what the witnesses returned before the close; a
	// cooperative close credits through the settled bitmap, so the larger of
	// the two is what the wallet can claim.
	const credited = concurrent ? settled : Math.max(Array.isArray(result.preimagesKnown) ? result.preimagesKnown.length : 0, settled);
	const action = result.action || 'nothing';
	const outcome =
		result.outcome || returnOutcome({ action, epoch, channelState: result.channelState, error: result.error });
	return {
		action,
		outcome,
		credited,
		settled,
		unsettled,
		total: slots.length,
		state: epoch ? epoch.state : null,
		complete: (outcome === 'closed' || outcome === 'force-closed') && unsettled === 0
	};
}

/** One log line for a return outcome. */
function returnLogLine(channelId, result, err) {
	const short = String(channelId || '').slice(0, 16);
	if (err) return `ffor return ${short}: failed, ${err.message}`;
	const d = describeReturn(result);
	if (!d) return `ffor return ${short}: no answer`;
	switch (d.outcome) {
		case 'unreachable':
			return `ffor return ${short}: settlement peer not reachable, ${d.settled} of ${d.total} slots settled so far`;
		case 'draining':
			return `ffor return ${short}: closing with the peer, ${d.settled} of ${d.total} slots settled so far`;
		case 'enforced':
			return `ffor return ${short}: the channel is closed on-chain, ${d.settled} of ${d.total} slots claimed through it`;
		default:
			return `ffor return ${short}: ${d.outcome}, ${d.settled} of ${d.total} slots settled, ${d.credited} preimage${
				d.credited === 1 ? '' : 's'
			} known`;
	}
}

module.exports = {
	SETTLE_DEFAULTS,
	SETTLE_BOUNDS,
	SETUP_ACTIVE_TIMEOUT_MS,
	SETUP_ACK_TIMEOUT_MS,
	witnessHop,
	planSetup,
	settlerTerms,
	WITNESS_DEFAULTS,
	WITNESS_BOUNDS,
	ISSUER_DEFAULTS,
	isWitness,
	isIssuer,
	hasFforRole,
	EPOCH_STATES,
	RETURN_STATES,
	FFOR_EVENTS,
	FFOR_CHANNEL_EVENTS,
	RETURN_REESTABLISH_TIMEOUT_MS,
	RETURN_POLL_MS,
	RETURN_DRAIN_TIMEOUT_MS,
	DRAIN_TRACK_TIMEOUT_MS,
	DRAIN_TRACK_POLL_MS,
	CLOSED_CHANNEL_STATES,
	returnOutcome,
	normalizeFfor,
	isSettler,
	fforEnv,
	fforRoleChanged,
	settlementCandidates,
	returnJobs,
	describeReturn,
	returnLogLine
};
