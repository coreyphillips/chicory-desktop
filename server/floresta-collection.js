'use strict';

const { createHash } = require('node:crypto');
const { SUPPORTED_NETWORKS } = require('./config');

const PUBLIC_KEY = '(?:\\[[0-9a-f]{8}(?:/[0-9]{1,10}h?){0,10}\\])?(?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]{107}/[01]/\\*';
const DESCRIPTOR = new RegExp('^(?:(?:pkh|wpkh|tr)\\(' + PUBLIC_KEY + '\\)|sh\\(wpkh\\(' + PUBLIC_KEY +
  '\\)\\)|wsh\\(sortedmulti\\((?:[1-9]|1[0-5])(?:,' + PUBLIC_KEY + '){1,15}\\)\\))#[a-z0-9]{8}$');
const HASH = /^[a-f0-9]{64}$/;
const POINT = /^[a-f0-9]{64}:(?:0|[1-9][0-9]{0,9})$/;
const SCRIPT = /^(?:[a-f0-9]{2})+$/;
const unavailable = () => ({ status: 'engine-unavailable', coverageComplete: false });
const limited = () => ({ status: 'collection-incomplete', coverageComplete: false });
const ownerFor = (network, id) => createHash('sha256').update(network + ':' + id).digest('hex');
let nextId = 0;

function request(child, action) {
  if (!child?.connected || typeof child.send !== 'function') return Promise.resolve(null);
  const id = ++nextId;
  return new Promise(resolve => {
    function done(value) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('disconnect', closed);
      child.off('exit', closed);
      resolve(value);
    }
    const closed = () => done(null);
    const onMessage = reply => {
      if (reply?.type === 'chicory-chain-reply/v1' && reply.id === id) done(reply.result);
    };
    const timer = setTimeout(closed, 4000);
    child.on('message', onMessage);
    child.once('disconnect', closed);
    child.once('exit', closed);
    try { child.send({ type: 'chicory-chain-control/v1', id, action }, err => { if (err) closed(); }); }
    catch { closed(); }
  });
}

// Rebuild the private parent message from public fields only. Never forward a
// child error object, a raw wallet object, arbitrary text or a descriptor with
// a private extended key. Bound cumulative output across a network as well.
function publicSnapshot(value, network, budget) {
  if (!value || value.coverageComplete !== false) return unavailable();
  if (['recovery-pending', 'wallet-data-unavailable', 'collection-incomplete'].includes(value.status)) {
    return { status: value.status, coverageComplete: false };
  }
  if (value.status !== 'observed' || value.network !== network || value.fromHeight !== 0 ||
      typeof value.generation !== 'string' || !HASH.test(value.generation) ||
      typeof value.acknowledged !== 'boolean') return unavailable();
  const { descriptors, scripts, outpoints, unresolvedHashes } = value;
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 32 ||
      ![scripts, outpoints, unresolvedHashes].every(entries => Array.isArray(entries) && entries.length <= 16384)) return limited();
  let size = 1024 + 128 * (outpoints.length + unresolvedHashes.length);
  const ranges = [];
  for (const d of descriptors) {
    if (typeof d?.descriptor !== 'string' || d.descriptor.length > 4096 || !DESCRIPTOR.test(d.descriptor) ||
        !Array.isArray(d.range) || d.range.length !== 2 || d.range[0] !== 0 ||
        !Number.isSafeInteger(d.range[1]) || d.range[1] < 0 || d.range[1] > 0x7fffffff) return unavailable();
    ranges.push({ descriptor: d.descriptor, range: [0, d.range[1]] });
    size += d.descriptor.length + 64;
  }
  for (const hex of scripts) {
    if (typeof hex !== 'string' || hex.length > 20000 || !SCRIPT.test(hex)) return unavailable();
    size += hex.length + 8;
    if (size > budget.remaining) return limited();
  }
  if (!unresolvedHashes.every(hash => typeof hash === 'string' && HASH.test(hash))) return unavailable();
  const points = [];
  for (const p of outpoints) {
    if (typeof p?.outpoint !== 'string' || !POINT.test(p.outpoint) || Number(p.outpoint.slice(65)) > 0xffffffff ||
        !(p.scriptHash === null || (typeof p.scriptHash === 'string' && HASH.test(p.scriptHash)))) return unavailable();
    points.push({ outpoint: p.outpoint, scriptHash: p.scriptHash });
  }
  if (size > budget.remaining) return limited();
  budget.remaining -= size;
  return { status: 'observed', coverageComplete: false, network, fromHeight: 0, generation: value.generation,
    acknowledged: value.acknowledged, descriptors: ranges, scripts, outpoints: points, unresolvedHashes };
}

function addDesktopWatches(view, targets) {
  const scripts = new Set(view.scripts);
  const points = new Map(view.outpoints.map(point => [point.outpoint, point.scriptHash]));
  const previousSize = scripts.size + points.size;
  for (const source of targets) {
    for (const hex of source.scripts) scripts.add(hex);
    for (const { txid, vout } of source.outpoints) {
      if (typeof txid !== 'string' || !HASH.test(txid) || !Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
        return limited();
      }
      const point = txid + ':' + vout;
      if (!points.has(point)) points.set(point, null);
    }
  }
  if (scripts.size + points.size === previousSize) return view;
  const merged = { ...view, scripts: [...scripts].sort(), outpoints: [...points.keys()].sort().map(outpoint => ({
    outpoint, scriptHash: points.get(outpoint),
  })) };
  merged.generation = createHash('sha256').update(JSON.stringify([view.generation, merged.scripts, merged.outpoints])).digest('hex');
  merged.acknowledged = false;
  return merged;
}

class FlorestaCollection {
  constructor(manager) {
    this.manager = manager;
    this.networks = new Map();
  }

  setEnabled(network, enabled) {
    if (!SUPPORTED_NETWORKS.includes(network) || typeof enabled !== 'boolean' || enabled === this.networks.has(network)) return;
    if (enabled) this.networks.set(network, {});
    else this.networks.delete(network);
    for (const [id, runtime] of this.manager.runtime) {
      if (this.manager.registry.get(id)?.network === network) {
        void request(runtime.proc, enabled ? 'enable-observation' : 'disable-observation');
      }
    }
  }

  snapshots(network) {
    const session = this.networks.get(network);
    if (!session || this.manager.shuttingDown) return Promise.resolve([]);
    if (!session.pending) {
      session.pending = this.collect(network, session).finally(() => { session.pending = null; });
    }
    return session.pending;
  }

  async collect(network, session) {
    const current = () => session === this.networks.get(network) && !this.manager.shuttingDown;
    const records = this.manager.registry.list().filter(rec => rec.network === network);
    // Fail the network explicitly if it cannot fit a bounded response.
    if (records.length > 128) return [{ owner: ownerFor(network, 'collection-limit'), snapshot: limited() }];
    const budget = { remaining: 8 * 1024 * 1024 };
    const wallets = [];
    for (let i = 0; i < records.length && current(); i += 8) {
      await Promise.all(records.slice(i, i + 8).map(async ({ id }) => {
        const proc = this.manager.runtime.get(id)?.proc;
        const value = await request(proc, 'watch-snapshot');
        if (!current() || this.manager.registry.get(id)?.network !== network) return;
        const rt = this.manager.runtime.get(id);
        let snapshot = unavailable();
        if (proc && rt?.proc === proc && !rt.stopping) {
          try {
            let view = value;
            if (value?.status === 'observed' && this.desktopWatches) {
              view = publicSnapshot(value, network, { remaining: budget.remaining });
              if (view.status === 'observed') view = addDesktopWatches(view, this.desktopWatches(id));
            }
            snapshot = publicSnapshot(view, network, budget);
          } catch { snapshot = limited(); }
        }
        wallets.push({ owner: ownerFor(network, id), snapshot });
      }));
    }
    return current() ? wallets : [];
  }
}

module.exports = { FlorestaCollection, publicSnapshot };
