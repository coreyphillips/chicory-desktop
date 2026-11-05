'use strict';

const { readConfirmedTransaction } = require('./floresta-transactions.cjs');

const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const money = value => Number.isSafeInteger(value) && value >= 0 && value <= 21e6 * 1e8;
const key = row => [row.height, row.position, row.vout ?? 0].map(n => n.toString(16).padStart(8, '0')).join('');
const invalid = () => new Error('Invalid confirmed script page from the managed node.');

function validateConfirmedPage(command, value) {
  if (value?.phase === 'unavailable' && Object.keys(value).length === 1) return null;
  const { kind, scriptHash, after } = command.query;
  if (value?.phase !== 'confirmed-only' || value.kind !== kind || value.scriptHash !== scriptHash ||
      !uint(value.tipHeight) || !hash(value.tipHash) || !Array.isArray(value.rows) || value.rows.length > 12) throw invalid();
  let last = after;
  const rows = value.rows.map(row => {
    if (!hash(row?.txid) || !uint(row.height) || row.height > value.tipHeight || !uint(row.position) ||
        (kind === 'unspent' && (!uint(row.vout) || !money(row.value)))) throw invalid();
    const { txid, height, position } = row;
    const result = kind === 'history' ? { txid, height, position } : { txid, height, position, vout: row.vout, value: row.value };
    const cursor = key(result);
    if (last && cursor <= last) throw invalid();
    last = cursor;
    return result;
  });
  if (value.next !== null && (rows.length !== 12 || value.next !== last)) throw invalid();
  return { scope: 'confirmed-only', tipHeight: value.tipHeight, tipHash: value.tipHash, rows, next: value.next };
}

// Only a trusted manager can mint a session. The wallet caller cannot select
// the owner or child pipe on a read. Revoke on wallet close or generation change.
function openConfirmedWallet(watch, owner, signal, status) {
  if (!hash(owner) || !(signal instanceof AbortSignal) || !watch?.confirmedReadsActive || !watch.transactionsActive) {
    throw new Error('The managed node cannot authorize this confirmed wallet session.');
  }
  const lifetime = watch.lifetime?.signal;
  let closed = false;
  function active() {
    if (closed || lifetime?.aborted || !watch.active || signal.aborted) throw new Error('Confirmed wallet session closed.');
  }
  active();
  async function send(command) {
    active();
    const reply = await watch.request(command);
    active();
    return reply;
  }
  function current(tip) {
    const state = status();
    return state.historicalVerification === 'verified' && state.tipSynced && state.tipHash === tip.tipHash &&
      state.height === tip.tipHeight && state.validatedHeight === tip.tipHeight;
  }
  async function scriptRows(kind, scriptHash) {
    if (!hash(scriptHash)) throw new Error('Invalid confirmed script hash.');
    const rows = [];
    let anchor;
    let after = null;
    do {
      const page = await send({ action: 'confirmed', owner, query: { kind, scriptHash, after } });
      if (!page || !current(page) || (anchor && (anchor.tipHash !== page.tipHash || anchor.tipHeight !== page.tipHeight))) return null;
      anchor = page;
      rows.push(...page.rows);
      if (rows.length > 65536) throw new Error('Confirmed script query exceeds the qualified history limit.');
      after = page.next;
    } while (after);
    return { scope: 'confirmed-only', tipHeight: anchor.tipHeight, tipHash: anchor.tipHash, rows };
  }
  async function transaction(txid) {
    const coverage = await send({ action: 'coverage', owner });
    if (coverage.phase !== 'caught-up') return null;
    const proof = await readConfirmedTransaction(send, owner, txid);
    if (!proof || !current(proof) || proof.tipHeight !== coverage.height || proof.tipHash !== coverage.hash) return null;
    return { scope: 'confirmed-only', ...proof };
  }
  return Object.freeze({
    close() { closed = true; },
    history: scriptHash => scriptRows('history', scriptHash),
    unspent: scriptHash => scriptRows('unspent', scriptHash),
    async balance(scriptHash) {
      const result = await scriptRows('unspent', scriptHash);
      if (!result) return null;
      const { rows, ...tip } = result;
      const confirmed = rows.reduce((sum, row) => sum + row.value, 0);
      if (!money(confirmed)) throw invalid();
      return { ...tip, confirmed };
    },
    transaction,
    async merkle(txid, height) {
      if (!uint(height)) throw new Error('Invalid confirmed transaction height.');
      const proof = await transaction(txid);
      if (!proof || proof.height !== height) return null;
      const { scope, tipHeight, tipHash, blockHash, position, merkle } = proof;
      return { scope, tipHeight, tipHash, blockHash, height, position, merkle };
    },
  });
}

module.exports = { openConfirmedWallet, validateConfirmedPage };
