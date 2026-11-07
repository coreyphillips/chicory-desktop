'use strict';

/**
 * How much one offline receive can take right now: GET /receive/offline, the
 * figure Chicory mobile's engine reports beside its Receive offline switch.
 * The desktop daemon has no such route, so the Receive screen showed no limit
 * and an amount over it was only refused after review.
 *
 * The daemon decides an offline request's channel itself (OfflineReceive's
 * suitableChannel, unchanged from beignet 0.36.1 to 0.38.0): a channel with the primary, NORMAL and
 * able to take HTLCs, empty on this side unless the primary settles offline
 * receives concurrently, not reserved by another request, with no open
 * receiving epoch, and holding the amount plus a 50000 sat margin of inbound.
 * When none does, it offers a direct-funding request instead, which the
 * wallet client refuses for an offline receive. So the largest amount is the
 * most inbound one eligible channel has beyond that margin, worked out here
 * with the daemon's own rule from what it lists.
 *
 * Whether the primary settles concurrently is the primary's answer, which
 * only an offline quote asks for. A quote at the minimum amount is that
 * question: the daemon keeps nothing from it. The answer is kept for a minute
 * and is never waited on for long, so a slow primary cannot hold up a wallet
 * refresh; until it comes back no figure is given, as before.
 */

// The daemon's margin of inbound left over an offline receive.
const HEADROOM_SATS = 50000;
// The least an offline request over a channel takes: the engine's dust limit
// (DEFAULT_CHANNEL_CONFIG.dustLimitSatoshis).
const MINIMUM_SATS = 354;
const ANSWER_MS = 60000;
const RETRY_MS = 15000;
const WAIT_MS = 2500;

const live = (epoch) => !!epoch && !['CLOSED', 'ABORTED'].includes(epoch.state);

/** The largest offline receive one channel can hold, or 0 below the minimum. */
function offlineCapacity({ channels, epochs, reservedChannelIds, primary, concurrent }) {
	const reserved = new Set(reservedChannelIds || []);
	const most = (channels || [])
		.filter((c) => c.peerPubkey === primary && c.state === 'NORMAL' && c.htlcUsable === true &&
			(concurrent || c.localBalanceSats === 0) && !reserved.has(c.channelId) &&
			!live((epochs || []).find((e) => e.role === 'R' && e.channelId === c.channelId)))
		.reduce((max, c) => Math.max(max, (Number(c.remoteBalanceSats) || 0) - HEADROOM_SATS), 0);
	return most >= MINIMUM_SATS ? most : 0;
}

function createOfflineCapacity(manager, { now = Date.now, wait = WAIT_MS } = {}) {
	// Per wallet: the primary that answered, whether it settles concurrently,
	// when, and the question in flight.
	const answers = new Map();

	const ask = (id, record, primary) => {
		const held = answers.get(id);
		if (held?.pending) return held.pending;
		const pending = manager._daemonCall(record, 'GET', `/receive/quote?peer=${encodeURIComponent(primary)}&amountSats=${MINIMUM_SATS}`)
			.then((quote) => {
				// A direct-funding answer means no channel holds even the
				// minimum, which the capacity below shows anyway, and says nothing
				// about concurrency.
				const answer = quote?.mode === 'bolt11'
					? { primary, concurrent: quote.concurrent === true, at: now() }
					: { primary, concurrent: false, at: now(), unasked: true };
				answers.set(id, answer);
				return answer;
			})
			.catch(() => {
				answers.set(id, { primary, failed: true, at: now() });
				return null;
			});
		answers.set(id, { ...held, pending });
		return pending;
	};

	const answerFor = async (id, record, primary) => {
		const held = answers.get(id);
		const fresh = held && !held.pending && held.primary === primary &&
			now() - held.at < (held.failed || held.unasked ? RETRY_MS : ANSWER_MS);
		if (fresh) return held.failed ? null : held;
		const pending = ask(id, record, primary);
		let timer;
		const late = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), wait); });
		try {
			return await Promise.race([pending, late]);
		} finally {
			clearTimeout(timer);
		}
	};

	return async function offlineReceive(id) {
		const record = manager.registry.get(id);
		// With several ranked primaries the figure is the receive target's,
		// the node the engine sends the next receive to (coreyphillips/beignet#1924).
		const primary = record?.lfbw?.primariesReceiveTarget || record?.lfbw?.primaryPubkey;
		if (!record || !primary || !manager.offlineReceiveAvailable()) return { maxSats: 0 };
		// A wallet being emptied takes no new request.
		if (manager.channelizeHeld?.(id)) return { maxSats: 0 };
		const [channels, status, epochs] = await Promise.all([
			manager._daemonCall(record, 'GET', '/channels'),
			manager._daemonCall(record, 'GET', '/receive/status'),
			manager._daemonCall(record, 'GET', '/ffor/epochs')
		]);
		const answer = await answerFor(id, record, primary);
		// No answer yet, or the primary could not be asked: no figure, rather
		// than one that may be wrong.
		if (!answer) return {};
		return {
			maxSats: offlineCapacity({
				channels, epochs, reservedChannelIds: status?.reservedChannelIds, primary, concurrent: answer.concurrent
			})
		};
	};
}

module.exports = { createOfflineCapacity, offlineCapacity, HEADROOM_SATS, MINIMUM_SATS };
