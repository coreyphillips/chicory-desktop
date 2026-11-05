'use strict';

// Installed at beignet/dist. Only the private desktop bootstrap can enable
// collection. Each child belongs to one wallet and one configured network.
const { createHash, randomBytes } = require('node:crypto');
let state;
let liveNode;
const LIMIT = 16_384;
const BYTE_LIMIT = 4 * 1024 * 1024;

function enable({ requireWatchAck = false } = {}) {
  if (state) {
    if (requireWatchAck && !state.requireWatchAck) throw new Error('An observation session cannot enable enforcement.');
    return;
  }
  state = { session: randomBytes(32), scripts: new Map(), points: new Map(), hashes: new Set(),
    bytes: 0, incomplete: false, requireWatchAck, node: null, ack: null };
  const existing = liveNode?.deref();
  if (existing) {
    attach(existing);
    // A wallet already running at opt-in can supply its retained watches.
    // Older hash-only rows stay unresolved. Avoid a network lookup here.
    const watcher = existing.node?.getChainWatcher();
    if (watcher) {
      script(watcher.destinationScript);
      for (const watch of watcher.watchedFundings.values()) funding(watch);
      for (const watch of watcher.watchedOutputs.values()) {
        outpoint(watch.txid, watch.outputIndex);
        checkHash(watch.scriptHash);
      }
      for (const input of watcher.watchedSpliceInputs.values()) {
        outpoint(input.txid, input.vout);
        if (input.scriptHash) checkHash(input.scriptHash);
      }
    }
  }
}

function disableObservation() {
  if (state?.requireWatchAck) return false;
  state = undefined;
  return true;
}

function remember(map, key, value) {
  if (map.has(key)) return;
  if (map.size >= LIMIT || state.bytes + key.length + value.length > BYTE_LIMIT) {
    state.incomplete = true;
    return;
  }
  map.set(key, value);
  state.bytes += key.length + value.length;
}

function hashScript(bytes) {
  return createHash('sha256').update(bytes).digest().reverse().toString('hex');
}

function script(bytes) {
  if (!state) return;
  if (!(bytes instanceof Uint8Array) || bytes.length > 10000 || !bytes.length) {
    state.incomplete = true;
    return;
  }
  const hash = hashScript(bytes);
  remember(state.scripts, hash, Buffer.from(bytes).toString('hex'));
  return hash;
}

// Requirements accumulate during this child lifetime. A superseded funding
// attempt or pre-splice leg can matter again after a reorg.
function outpoint(txid, vout, bytes) {
  if (!state) return;
  if (!/^[a-f0-9]{64}$/.test(txid) || !Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
    state.incomplete = true;
    return;
  }
  const key = txid + ':' + vout;
  const hash = bytes === undefined ? '' : script(bytes);
  remember(state.points, key, hash || '');
  if (hash && state.points.has(key)) {
    const previous = state.points.get(key);
    if (previous && previous !== hash) state.incomplete = true;
    else state.points.set(key, hash);
  }
}

function funding(watch) {
  if (!state) return;
  outpoint(watch.txid, watch.outputIndex, watch.script);
  for (const candidate of watch.candidates || []) outpoint(candidate.txid, candidate.outputIndex, watch.script);
  for (const attempt of watch.discoverAttemptInputs || []) {
    for (const point of attempt) {
      const [txid, index] = point.split(':');
      outpoint(txid, /^\d+$/.test(index) ? Number(index) : NaN);
    }
  }
}

function attach(node) {
  liveNode = new WeakRef(node);
  if (!state) return;
  if (state.node === node) return;
  if (state.node && state.node !== node) {
    state.incomplete = true;
    return;
  }
  state.node = node;
  if (state.requireWatchAck) {
    for (const name of ['getNewAddress', 'getFreshReceiveAddress']) {
      const issue = node[name];
      node[name] = async function (...args) {
        const wallet = this.wallet;
        const address = await issue.apply(this, args);
        checkAddress(wallet, address);
        return address;
      };
    }
  }
}

function verifyParent(transaction, expected) {
  if (state && transaction.getId() !== expected) throw new Error('Watch parent transaction identity mismatch.');
}

function checkHash(hash) {
  if (!state) return;
  if (!/^[a-f0-9]{64}$/.test(hash) || (state.hashes.size >= LIMIT && !state.hashes.has(hash))) {
    state.incomplete = true;
  } else {
    state.hashes.add(hash);
  }
  if (state.requireWatchAck && (availability() || state.incomplete || !state.ack?.hashes.has(hash))) {
    throw new Error('Chain watch coverage is pending.');
  }
}

function checkAddress(wallet, address) {
  if (!state?.requireWatchAck) return;
  if (state.node?.wallet !== wallet) throw new Error('Wallet identity changed.');
  const bytes = require('bitcoinjs-lib').address.toOutputScript(address, wallet.getBitcoinNetwork());
  checkHash(script(bytes));
}

function validateHistory(scriptHash, response) {
  if (state?.requireWatchAck) checkHash(scriptHash);
  const entries = response?.data;
  const rows = entries?.[0]?.result;
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.error || !Array.isArray(rows) ||
      !rows.every(tx => typeof tx?.tx_hash === 'string' && /^[a-f0-9]{64}$/.test(tx.tx_hash) &&
        Number.isSafeInteger(tx.height) && tx.height >= -1)) throw new Error('Incomplete Electrum history response.');
}

function availability() {
  const node = state.node;
  const status = node && recoveryPending(node) ? 'recovery-pending' :
    !node?.wallet || !node.node || node.destroyed ? 'engine-unavailable' : null;
  if (state.status !== status || state.wallet !== node?.wallet) {
    invalidate();
    state.status = status;
    state.wallet = node?.wallet;
  }
  return status;
}

function recoveryPending(node) {
  return node.restorePending || node._resuming || node._restoreInFlight ||
    node.node?.startupRepairPending || node.node?.getRecoveryOwnershipHold() != null;
}

function range(data, wallet, type, internal) {
  const cached = data[internal ? 'changeAddresses' : 'addresses'][type];
  const current = data[internal ? 'changeAddressIndex' : 'addressIndex'][type].index;
  const last = data[internal ? 'lastUsedChangeAddressIndex' : 'lastUsedAddressIndex'][type].index;
  const gap = wallet.gapLimitOptions[internal ? 'lookAheadChange' : 'lookAhead'];
  if (!Number.isSafeInteger(gap) || gap < 1) throw new Error('Invalid wallet gap.');
  let end = Math.max(0, current, last) + gap;
  for (const { index } of Object.values(cached)) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid derived index.');
    end = Math.max(end, index);
  }
  if (![current, last].every(index => Number.isSafeInteger(index) && index >= -1) ||
      !Number.isSafeInteger(end) || end >= 0x80000000) throw new Error('Invalid descriptor range.');
  return [0, end];
}

function collectWallet(node) {
  const wallet = node.wallet;
  const data = require('./wallet/live-data.js').liveWalletData(wallet);
  const { descriptors } = node.exportDescriptors();
  const ranges = [];
  for (const item of descriptors) {
    for (const branch of ['external', 'internal']) {
      const descriptor = item[branch];
      // From the built-in neutered descriptor exporter. Refuse an unexpected
      // future shape instead of serializing arbitrary wallet objects.
      if (typeof descriptor !== 'string' || !/\/(?:0|1)\/\*/.test(descriptor) ||
          !/(?:xpub|tpub)/.test(descriptor) || /(?:\]|\(|,)(?:[xtyzuYZUV]prv)/.test(descriptor)) throw new Error('Invalid public descriptor.');
      ranges.push({ descriptor, range: range(data, wallet, item.addressType, branch === 'internal') });
    }
  }
  if (!ranges.length) throw new Error('Missing wallet descriptors.');
  for (const utxo of [...data.utxos, ...data.blacklistedUtxos]) {
    let bytes;
    try { bytes = require('bitcoinjs-lib').address.toOutputScript(utxo.address, wallet.getBitcoinNetwork()); } catch {}
    outpoint(utxo.tx_hash, utxo.tx_pos, bytes);
  }
  return ranges;
}

function snapshot() {
  if (!state) return { status: 'disabled', coverageComplete: false };
  const node = state.node;
  const status = availability();
  if (status) return { status, coverageComplete: false };
  let descriptors;
  try { descriptors = collectWallet(node); }
  catch {
    state.ack = null;
    return { status: 'wallet-data-unavailable', coverageComplete: false };
  }
  const scripts = [...state.scripts.entries()].sort(([a], [b]) => a.localeCompare(b));
  const points = [...state.points.keys()].sort().map(outpoint => ({ outpoint, scriptHash: state.points.get(outpoint) || null }));
  const unresolvedHashes = [...state.hashes].filter(hash => !state.scripts.has(hash)).sort();
  const body = { network: node.networkName, fromHeight: 0, descriptors,
    scripts: scripts.map(([,hex]) => hex), outpoints: points, unresolvedHashes };
  const generation = createHash('sha256').update(state.session).update(JSON.stringify(body)).digest('hex');
  return { ...body, generation, status: state.incomplete ? 'collection-incomplete' : 'observed',
    coverageComplete: false, acknowledged: state.ack?.wallet === node.wallet && state.ack.generation === generation };
}

function acknowledge(generation) {
  const view = snapshot();
  // Only the trusted manager calls this AFTER registering and scanning the
  // specific public data. Acknowledgement cannot authorize unobserved scripts.
  if (view.status !== 'observed' || view.generation !== generation || view.unresolvedHashes.length ||
      view.outpoints.some(point => !point.scriptHash)) return { accepted: false };
  state.ack = { generation, hashes: new Set(state.scripts.keys()), wallet: state.node.wallet };
  return { accepted: true, coverageComplete: false };
}

function invalidate() {
  if (state) {
    state.session = randomBytes(32);
    state.ack = null;
  }
}

module.exports = { enable, disableObservation, attach, script, funding, outpoint, verifyParent, checkHash, checkAddress,
  validateHistory, snapshot, acknowledge, invalidate };
