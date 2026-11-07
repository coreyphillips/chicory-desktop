'use strict';

const { randomUUID } = require('node:crypto');
const { openWalletBridge } = require('./floresta-wallet-bridge');

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const expired = () => new Error('Private wallet bridge lease expired.');

// Only the private Electron parent can mint a lease on this manager fork.
// Wallet HTTP, renderer IPC and saved wallet settings have no route here.
function installBridgeControl(channel, { qualification = false } = {}) {
  if (qualification !== true) return () => {};
  const leases = new Map();
  function send(message) {
    if (!channel.connected) throw expired();
    channel.send(message, error => { if (error) stop(); });
  }
  function drop(id, notify = true) {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    lease.controller.abort();
    clearTimeout(lease.expiry);
    for (const request of lease.requests.values()) { clearTimeout(request.timer); request.reject(expired()); }
    if (notify && channel.connected) send({ type: 'floresta:bridge-closed', id });
  }
  async function open(id, network) {
    if (leases.has(id) || leases.size >= 8 || network !== 'regtest') return;
    const lease = { controller: new AbortController(), requests: new Map() };
    leases.set(id, lease);
    lease.expiry = setTimeout(() => drop(id), 30 * 60 * 1000).unref();
    function read(method, ...params) {
      if (leases.get(id) !== lease || lease.requests.size >= 16) throw expired();
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => drop(id), 30000);
        lease.requests.set(requestId, { resolve, reject, timer });
        send({ type: 'floresta:bridge-read', id, requestId, method, params });
      });
    }
    const close = () => drop(id);
    try {
      const bridge = await openWalletBridge({ qualification: true, network, signal: lease.controller.signal, status: () => read('status'), readHeader: (...p) => read('header', ...p),
        broadcast: (raw, tip) => read('broadcast', raw, tip),
        confirmed: { close, history: h => read('history', h), unspent: h => read('unspent', h), transaction: t => read('transaction', t),
          merkle: (t, h) => read('merkle', t, h) },
        pending: { close, observations: h => read('observations', h), transaction: t => read('pending-transaction', t) } });
      if (leases.get(id) === lease) send({ type: 'floresta:bridge-ready', id, endpoint: bridge.endpoint });
      else bridge.close();
    } catch { drop(id); }
  }
  function onMessage(message) {
    if (!uuid(message?.id)) return;
    const { type, id } = message;
    if (type === 'floresta:bridge-open') { void open(id, message.network); return; }
    if (type === 'floresta:bridge-revoke') { drop(id, false); return; }
    if (type !== 'floresta:bridge-result' || !uuid(message.requestId)) return;
    const lease = leases.get(id);
    const req = lease?.requests.get(message.requestId);
    if (!req) return;
    lease.requests.delete(message.requestId);
    clearTimeout(req.timer);
    if (message.error) req.reject(expired()); else req.resolve(message.value);
  }
  function stop() {
    channel.removeListener('message', onMessage);
    channel.removeListener('disconnect', stop);
    for (const id of leases.keys()) drop(id, false);
  }
  channel.on('message', onMessage);
  channel.once('disconnect', stop);
  return stop;
}

module.exports = { installBridgeControl };
