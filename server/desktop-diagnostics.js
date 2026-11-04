'use strict';

const fs = require('node:fs');
const { VAULT_FORMAT } = require('./vault-files');

// Only Linux exposes a thread count without a native module.
function threadCount(platform = process.platform, read = fs.readFileSync) {
	if (platform !== 'linux') return undefined;
	try {
		const match = /^Threads:\s+(\d+)$/m.exec(read('/proc/self/status', 'utf8'));
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}

/**
 * Counters for the desktop support report, read only when it is asked for.
 * Wallet names, ids and addresses stay here; only counts and exit codes leave.
 */
function snapshot(manager, { clock = Date.now, threads = threadCount } = {}) {
	const memory = process.memoryUsage();
	const usage = process.resourceUsage();
	const wallets = { total: 0 };
	let restarts = 0;
	let lastExit = null;
	let lastStartError = null;
	for (const rec of manager.registry.list()) {
		wallets.total += 1;
		const rt = manager.runtime.get(rec.id);
		const status = rt?.status || 'stopped';
		wallets[status] = (wallets[status] || 0) + 1;
		if (!rt) continue;
		restarts += rt.restartCount || 0;
		if (rt.lastExit && (!lastExit || rt.lastExit.at > lastExit.at)) lastExit = rt.lastExit;
		if (rt.lastStartError && (!lastStartError || rt.lastStartError.at > lastStartError.at)) lastStartError = rt.lastStartError;
	}
	const count = threads();
	return {
		at: clock(),
		engineVersion: manager.engineVersion || null,
		node: process.version,
		vaultFormat: VAULT_FORMAT,
		health: manager.health().status,
		resources: {
			rssKb: Math.round(memory.rss / 1024),
			heapUsedKb: Math.round(memory.heapUsed / 1024),
			externalKb: Math.round(memory.external / 1024),
			cpuUserMs: Math.round(usage.userCPUTime / 1000),
			cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
			activeResources: process.getActiveResourcesInfo().length,
			uptimeSec: Math.round(process.uptime()),
			threads: count === undefined ? 'unsupported' : count
		},
		wallets: {
			...wallets,
			restarts,
			lastExit: lastExit && { code: lastExit.code, signal: lastExit.signal, at: lastExit.at, expected: lastExit.expected },
			lastStartError: lastStartError && { message: String(lastStartError.message || '').slice(0, 300), at: lastStartError.at }
		}
	};
}

/** Answers the desktop main process's diagnostics requests over the IPC channel. */
function installDesktopDiagnostics(manager, transport = process, options) {
	if (typeof transport.send !== 'function') return () => {};
	const listener = (message) => {
		if (message?.type !== 'diagnostics:request' || typeof message.requestId !== 'string' || message.requestId.length > 64) return;
		let result = null;
		try {
			result = snapshot(manager, options);
		} catch {}
		if (transport.connected) transport.send({ type: 'diagnostics:result', requestId: message.requestId, result }, () => {});
	};
	transport.on('message', listener);
	return () => transport.off('message', listener);
}

module.exports = { snapshot, installDesktopDiagnostics, threadCount };
