'use strict';

const { createHash, randomUUID } = require('node:crypto');
const idHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const expired = () => new Error('The private wallet bridge lease is unavailable.');

// Trusted main-process callers supply a grant tied to the unlocked wallet and
// its observation generation. No owner or routing choice comes from a wallet
// query. A new managed child always requires a fresh grant.
async function grantWalletBridge({ qualification, manager, node, owner, signal }, readOnly = false) {
  if (qualification !== true || !manager?.connected || !idHash(owner) || !(signal instanceof AbortSignal)) throw expired();
  signal.throwIfAborted();
  const network = node.status().network;
  if (network !== 'regtest') throw expired();
  const id = randomUUID();
  const control = new AbortController();
  const activity = AbortSignal.any([control.signal, signal]);
  const confirmed = node.openConfirmedWallet(owner, activity);
  const pending = node.openPendingWallet(owner, activity);
  const child = node.watch;
  let approved;
  let issued = false;
  let renewing = false;
  let revoke;
  let accept;
  let reject;
  const ready = new Promise((ok, fail) => { accept = ok; reject = fail; });
  const startTimer = setTimeout(() => revoke(), 5000);
  const expiry = setTimeout(() => revoke(), 30 * 60 * 1000).unref();
  const inflight = new Set();
  function send(message) {
    if (!manager.connected) throw expired();
    manager.send({ ...message, id }, error => { if (error) revoke(); });
  }
  revoke = () => {
    if (control.signal.aborted) return;
    control.abort();
    clearTimeout(startTimer); clearTimeout(expiry);
    manager.removeListener('message', receive);
    manager.removeListener('disconnect', revoke);
    signal.removeEventListener('abort', revoke);
    child?.lifetime?.signal.removeEventListener('abort', revoke);
    confirmed.close(); pending.close();
    reject(expired());
    if (manager.connected) {
      try { manager.send({ type: 'floresta:bridge-revoke', id }, () => {}); } catch { /* manager already exited */ }
    }
  };
  function alive() {
    if (activity.aborted || !child?.active || node.watch !== child) { revoke(); throw expired(); }
  }
  async function reopenConfirmedFunding(funding) {
    if (!control.signal.aborted || signal.aborted || renewing || !manager.connected) throw expired();
    const { txid, wtxid, scriptHash, vout, value } = funding || {};
    if (![txid, wtxid, scriptHash].every(idHash) || !uint(vout) || !Number.isSafeInteger(value) || value < 1 || value > 21e6 * 1e8) throw expired();
    renewing = true;
    let next, view, observations;
    try {
      const watch = node.watch;
      const lifetime = watch?.lifetime?.signal;
      const initial = node.status();
      function current() {
        const state = node.status();
        if (signal.aborted || !manager.connected || node.watch !== watch || !watch?.active || !lifetime ||
            lifetime.aborted || lifetime !== watch.lifetime.signal ||
            state.network !== 'regtest' || state.phase !== 'running' || state.historicalVerification !== 'verified' ||
            state.tipSynced !== true || !uint(state.height) || state.validatedHeight !== state.height ||
            !idHash(state.tipHash) || state.tipHash !== initial.tipHash || state.height !== initial.height) throw expired();
      }
      current();
      view = node.openConfirmedWallet(owner, signal);
      observations = node.openPendingWallet(owner, signal);
      async function pending() {
        const page = await observations.observations(scriptHash);
        current();
        if (page?.scope !== 'observed-pending' || page.coverageComplete !== false ||
            page.tipHash !== initial.tipHash || page.tipHeight !== initial.height ||
            !Number.isSafeInteger(page.revision) || page.revision < 0 || !Array.isArray(page.rows) ||
            page.rows.some(row => row.spent.some(point => point.txid === txid && point.vout === vout))) throw expired();
        return page.revision;
      }
      const revision = await pending();
      const [proof, unspent] = await Promise.all([view.transaction(txid), view.unspent(scriptHash)]);
      current();
      if (![proof, unspent].every(row => row?.scope === 'confirmed-only' && row.tipHash === initial.tipHash && row.tipHeight === initial.height) ||
          proof.txid !== txid || proof.wtxid !== wtxid || !uint(proof.confirmations) || proof.confirmations < 6 ||
          !unspent.rows.some(row => row.txid === txid && row.vout === vout && row.value === value && row.height === proof.height)) throw expired();
      next = await grantWalletBridge({ qualification, manager, node, owner, signal }, true);
      if (await pending() !== revision) throw expired();
      current();
      return { ...next, funding: { txid, wtxid, scriptHash, vout, value, height: proof.height,
        tipHash: initial.tipHash, tipHeight: initial.height } };
    } catch (error) {
      next?.close();
      renewing = false;
      throw error;
    } finally {
      observations?.close(); view?.close();
    }
  }
  async function read(method, args) {
    alive();
    if (!Array.isArray(args) || args.length > 2) throw expired();
    if (method === 'status' && !args.length) {
      const { network, phase, historicalVerification, tipSynced, validatedHeight, height, tipHash } = node.status();
      return { network, phase, historicalVerification, tipSynced, validatedHeight, height, tipHash };
    }
    const [first, second] = args;
    if (method === 'header' && uint(first) && uint(second?.tipHeight) && idHash(second.tipHash)) return node.readHeader(first, second);
    if (method === 'broadcast') {
      if (!approved || !child.walletOffersActive || typeof first !== 'string' || !first.length || first.length > 60000 ||
          first.length % 2 || !/^[a-f0-9]+$/.test(first) || second?.tipHash !== approved.tipHash ||
          second?.tipHeight !== approved.tipHeight) throw expired();
      const firstHash = createHash('sha256').update(Buffer.from(first, 'hex')).digest();
      const wtxid = createHash('sha256').update(firstHash).digest().reverse().toString('hex');
      if (wtxid !== approved.wtxid) throw expired();
      const { txid, tipHash } = approved;
      approved = null;
      return child.request({ action: 'broadcast', owner, txid, offer: { hex: first, tip: tipHash } });
    }
    if (!idHash(first)) throw expired();
    if (method === 'merkle' && args.length === 2 && uint(second)) return confirmed.merkle(first, second);
    if (args.length !== 1) throw expired();
    if (method === 'observations') return pending.observations(first);
    if (method === 'pending-transaction') return pending.transaction(first);
    if (['history', 'unspent', 'transaction'].includes(method)) return confirmed[method](first);
    throw expired();
  }
  function receive(message) {
    if (message?.id !== id || control.signal.aborted) return;
    if (message.type === 'floresta:bridge-closed') { revoke(); return; }
    if (message.type === 'floresta:bridge-ready') {
      const e = message.endpoint;
      if (e?.host !== '127.0.0.1' || e.tls !== true || !uint(e.port) || !e.port || e.port > 65535 || !idHash(e.psk)) { revoke(); return; }
      clearTimeout(startTimer);
      accept({ endpoint: { host: '127.0.0.1', tls: true, port: e.port, psk: e.psk }, close: revoke, reopenConfirmedFunding, authorizeBroadcast(txid, wtxid) {
        alive();
        const state = node.status();
        if (readOnly || !idHash(txid) || !idHash(wtxid) || issued || !child.walletOffersActive || state.phase !== 'running' || state.network !== 'regtest' ||
            state.historicalVerification !== 'verified' || !state.tipSynced || state.validatedHeight !== state.height || !idHash(state.tipHash)) throw expired();
        issued = true;
        approved = { txid, wtxid, tipHash: state.tipHash, tipHeight: state.height };
      } });
      return;
    }
    if (message.type !== 'floresta:bridge-read') return;
    const { requestId } = message;
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(requestId) || inflight.has(requestId) || inflight.size >= 16) { revoke(); return; }
    inflight.add(requestId);
    Promise.resolve().then(() => read(message.method, message.params)).then(value => {
      alive();
      if (Buffer.byteLength(JSON.stringify(value)) > 8400000) throw expired();
      send({ type: 'floresta:bridge-result', requestId, value });
    }).catch(() => {
      if (!control.signal.aborted) {
        try { send({ type: 'floresta:bridge-result', requestId, error: true }); } catch { revoke(); }
      }
    }).finally(() => inflight.delete(requestId));
  }
  manager.on('message', receive);
  manager.once('disconnect', revoke);
  signal.addEventListener('abort', revoke, { once: true });
  child?.lifetime?.signal.addEventListener('abort', revoke, { once: true });
  try { send({ type: 'floresta:bridge-open', network }); } catch { revoke(); }
  return ready;
}

module.exports = { grantWalletBridge };
