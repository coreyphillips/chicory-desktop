'use strict';

const express = require('express');
const { isPorchUri, PORCH_UNSUPPORTED } = require('./lfbw');

/**
 * The fail-closed half of Porch links as a primary (coreyphillips/beignet#1980).
 *
 * The dashboard adds a ranked primary at the engine itself: POST
 * /wallets/:id/api/primaries/add is proxied, so a Porch link does not pass
 * the record's rules on its way in. On an engine that dials a WebSocket peer
 * outside the proxy (before beignet #1995, 0.39.0), a wallet in Tor mode
 * would then reach the relay directly, and the engine redials its primaries
 * without being asked. So the link is refused here, before the engine holds
 * it.
 *
 * With an engine that routes the dial this does nothing at all: the request
 * goes on to the proxy with its body unread. Only on an engine without it is
 * the body read. A Porch link is refused, and any other add is handed to the
 * daemon here, since a body that has been read can no longer be proxied.
 */
function createPorchGate(manager) {
	const json = express.json({ limit: '64kb' });
	return (req, res, next) => {
		if (manager.porchPrimaryAvailable()) return next();
		return json(req, res, async (parseError) => {
			if (parseError) return next(parseError);
			const body = req.body && typeof req.body === 'object' ? req.body : {};
			if (isPorchUri(body.uri)) {
				return res.status(400).json({ ok: false, error: { code: 'PORCH_UNSUPPORTED', message: PORCH_UNSUPPORTED } });
			}
			const rec = manager.registry.get(req.params.id);
			if (!rec) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
			try {
				const result = await manager._daemonCall(rec, 'POST', '/primaries/add', body);
				// As the proxy does after a write that went through: the record
				// follows, so the new node is trusted and dialed.
				manager.syncPrimaries(req.params.id).catch((err) =>
					manager.recordLog(req.params.id, `the ranked primaries could not be read back after /primaries/add: ${err.message}`)
				);
				return res.json({ ok: true, result });
			} catch (err) {
				return res.status(400).json({ ok: false, error: { code: err.code || 'DAEMON_ERROR', message: err.message } });
			}
		});
	};
}

module.exports = { createPorchGate };
