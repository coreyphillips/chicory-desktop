'use strict';

const { randomUUID } = require('node:crypto');

const progress = new WeakMap();
const networks = new Set(['mainnet', 'testnet', 'regtest']);
const hexId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function setWatchCollection(manager, network, enabled) {
  if (!manager?.connected || !networks.has(network)) return;
  manager.send({ type: 'floresta:collect', network, enabled: enabled === true }, () => {});
}

async function snapshots(manager, network, signal) {
  const requestId = randomUUID();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (err, value) => {
      manager.removeListener('message', receive);
      manager.removeListener('disconnect', disconnected);
      signal.removeEventListener('abort', cancelled);
      if (err) reject(err);
      else resolve(value);
    };
    const disconnected = () => finish(new Error('Wallet manager disconnected.'));
    const cancelled = () => finish(new Error('Wallet watch collection stopped.'));
    const receive = reply => {
      if (reply?.type !== 'floresta:snapshots-result' || reply.requestId !== requestId) return;
      if (!Array.isArray(reply.wallets)) finish(new Error('Wallet watches unavailable.'));
      else finish(null, reply.wallets);
    };
    manager.on('message', receive);
    manager.once('disconnect', disconnected);
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      manager.send({ type: 'floresta:snapshots', network, requestId }, error => { if (error) disconnected(); });
    } catch { disconnected(); }
  });
}

// Work is bounded per poll. A high address index keeps the wallet pending and
// resumes on the next poll. The node independently enforces contiguous ranges.
function* registrations(owner, view) {
  for (const { descriptor, range } of view.descriptors) {
    if (!Array.isArray(range) || range.length !== 2 || range[0] !== 0 ||
        !Number.isSafeInteger(range[1]) || range[1] < 0 || range[1] >= 0x80000000) {
      throw new Error('Invalid wallet descriptor range.');
    }
    for (let start = 0; start <= range[1]; start += 256) {
      yield { owner, scripts: [], outpoints: [], descriptors: [{ descriptor, range: [start, Math.min(start + 255, range[1])] }] };
    }
  }
  let batch = { owner, scripts: [], outpoints: [] };
  let size = 0;
  for (const field of ['scripts', 'outpoints']) {
    for (const item of view[field]) {
      const value = field === 'outpoints' ? item?.outpoint : item;
      if (typeof value !== 'string') throw new Error('Invalid wallet watch.');
      const bytes = Buffer.byteLength(value) + 3;
      if (size + bytes > 60000 || batch.scripts.length + batch.outpoints.length >= 512) {
        yield batch;
        batch = { owner, scripts: [], outpoints: [] };
        size = 0;
      }
      batch[field].push(value);
      size += bytes;
    }
  }
  if (size) yield batch;
}

async function reconcileQualificationWatches({ node, network, manager, signal }) {
  if (!networks.has(network) || !manager?.connected || node.status().network !== network) throw new Error('Wallet manager unavailable.');
  const activity = signal ?? new AbortController().signal;
  const requestSignal = AbortSignal.any([activity, AbortSignal.timeout(20000)]);
  const wallets = await snapshots(manager, network, requestSignal);
  let cache = progress.get(node);
  if (cache?.manager !== manager) {
    cache = { manager, wallets: new Map() };
    progress.set(node, cache);
  }
  const active = new Set();
  let caughtUp = 0;
  for (const { owner, snapshot: view } of wallets) {
    activity.throwIfAborted();
    if (!hexId(owner) || active.has(owner)) throw new Error('Invalid wallet watch owner.');
    active.add(owner);
    if (view?.status !== 'observed' || view.network !== network || !hexId(view.generation) || view.fromHeight !== 0 ||
        !Array.isArray(view.descriptors) || !Array.isArray(view.scripts) || !Array.isArray(view.outpoints) ||
        !Array.isArray(view.unresolvedHashes)) {
      cache.wallets.delete(owner);
      continue;
    }
    let task = cache.wallets.get(owner);
    if (task?.generation !== view.generation) {
      task = { generation: view.generation, batches: registrations(owner, view), next: null, finished: false };
      cache.wallets.set(owner, task);
    }
    try {
      for (let i = 0; !task.finished && i < 16; i++) {
        activity.throwIfAborted();
        task.next ??= task.batches.next();
        if (task.next.done) {
          task.finished = true;
          task.batches = null;
        } else {
          await node.registerWatches(task.next.value);
          task.next = null;
        }
      }
      if (task.finished) {
        activity.throwIfAborted();
        const coverage = await node.watchCoverage(owner);
        if (coverage.phase === 'caught-up' && view.unresolvedHashes.length === 0 &&
            view.outpoints.every(point => hexId(point.scriptHash))) caughtUp++;
      }
    } catch (err) {
      // Never infer that a new child or a changed volume retained a receipt.
      // Re-register additively after any uncertainty, including a lost reply.
      cache.wallets.delete(owner);
      throw err;
    }
  }
  for (const owner of cache.wallets.keys()) if (!active.has(owner)) cache.wallets.delete(owner);
  return { observedWallets: wallets.length, confirmedScansCaughtUp: caughtUp };
}

module.exports = { setWatchCollection, snapshots, registrations, reconcileQualificationWatches };
