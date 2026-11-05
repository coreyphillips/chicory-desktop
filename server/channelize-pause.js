'use strict';

// The durable channelize pause a wallet drain owns. Copied from the portable
// engine at commit 373b7fd, the one Chicory mobile ships, for the desktop
// wallet drain (issue #29).

function channelizePause({ read, write, busy, failure, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
	const status = () => {
		const saved = read();
		return saved?.paused === true
			? { paused: true, requestId: saved.requestId, since: saved.since }
			: { paused: false };
	};
	return {
		status,
		async set({ paused, requestId } = {}) {
			if (typeof paused !== 'boolean' || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId))
				failure('INVALID_PARAMS', 'paused and a stable requestId are required');
			const current = status();
			if (current.paused && current.requestId !== requestId)
				failure('CHANNELIZE_PAUSED', 'Another operation owns the channelize pause', 409);
			if (paused && !current.paused) write({ paused: true, requestId, since: now() });
			if (!paused) {
				if (current.paused) write(null);
				return status();
			}
			// A pass can already be inside the engine when the pause arrives.
			// Keep the pause durable, and acknowledge only after that pass exits.
			const deadline = now() + 15000;
			while (busy()) {
				if (now() >= deadline)
					failure('CHANNELIZE_BUSY', 'Channelize is paused but its current operation is still finishing', 409);
				await wait(20);
			}
			if (!status().paused || status().requestId !== requestId)
				failure('CHANNELIZE_PAUSE_RELEASED', 'The channelize pause was released while waiting', 409);
			return status();
		}
	};
}

module.exports = { channelizePause };
