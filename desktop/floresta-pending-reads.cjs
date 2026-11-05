'use strict';

const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const money = value => Number.isSafeInteger(value) && value >= 0 && value <= 21e6 * 1e8;
const invalid = () => new Error('Invalid pending observations from the managed node.');
// Rust orders Txid by consensus bytes. Displayed transaction IDs reverse those bytes.
const order = id => Buffer.from(id, 'hex').reverse();
const PENDING_LINE_BYTES = 49152;

function validatePendingPage(command, value) {
  if (value?.phase === 'unavailable' && Object.keys(value).length === 1) return null;
  if (value?.phase !== 'observed' || value.coverageComplete !== false || !hash(value.tipHash) || !uint(value.tipHeight) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.rows) || value.rows.length > 12) throw invalid();
  let last = command.pending.after;
  const rows = value.rows.map(row => {
    if (!hash(row?.txid) || (last && order(last).compare(order(row.txid)) >= 0) || ![0, -1].includes(row.height) || !money(row.fee) ||
        !Array.isArray(row.spent) || row.spent.length > 256 || !Array.isArray(row.created) || !(row.spent.length || row.created.length)) throw invalid();
    last = row.txid;
    const inputs = new Set();
    const spent = row.spent.map(input => {
      if (!hash(input?.txid) || !uint(input.vout) || !money(input.value)) throw invalid();
      const outpoint = input.txid + ':' + input.vout;
      if (inputs.has(outpoint)) throw invalid();
      inputs.add(outpoint);
      return { txid: input.txid, vout: input.vout, value: input.value };
    });
    let previous = -1;
    const created = row.created.map(output => {
      if (!uint(output?.vout) || !money(output.value) || output.vout <= previous) throw invalid();
      previous = output.vout;
      return { vout: output.vout, value: output.value };
    });
    return { txid: row.txid, height: row.height, fee: row.fee, spent, created };
  });
  if (value.next !== null && (!rows.length || value.next !== last)) throw invalid();
  return { tipHash: value.tipHash, tipHeight: value.tipHeight, revision: value.revision, rows, next: value.next };
}

function openPendingWallet(watch, owner, signal, status) {
  if (!hash(owner) || !(signal instanceof AbortSignal) || !watch?.pendingActive) {
    throw new Error('The managed node cannot authorize this pending wallet session.');
  }
  let closed = false;
  function active() {
    if (closed || !watch.active || !watch.pendingActive || signal.aborted) throw new Error('Pending wallet session closed.');
  }
  function current(page) {
    const state = status();
    return state.historicalVerification === 'verified' && state.tipSynced && state.tipHash === page.tipHash &&
      state.height === page.tipHeight && state.validatedHeight === page.tipHeight;
  }
  active();
  return Object.freeze({
    close() { closed = true; },
    async transaction(txid) {
      active();
      if (!hash(txid)) throw new Error('Invalid pending transaction ID.');
      if (!watch.pendingTransactionActive) return null;
      const { readPendingTransaction } = require('./floresta-pending-transaction.cjs');
      const result = await readPendingTransaction(async command => {
        active();
        const reply = await watch.request(command);
        active();
        return reply;
      }, owner, txid);
      active();
      return watch.pendingTransactionActive && result && current(result) ? result : null;
    },
    async observations(scriptHash) {
      if (!hash(scriptHash)) throw new Error('Invalid pending script hash.');
      const rows = [];
      let bytes = 0;
      let anchor;
      let after;
      do {
        active();
        const page = await watch.request({ action: 'pending', owner, pending: { scriptHash, ...(after && { after }) } });
        active();
        if (!page) return null;
        if (!current(page) ||
            (anchor && (page.revision !== anchor.revision || page.tipHash !== anchor.tipHash || page.tipHeight !== anchor.tipHeight))) return null;
        anchor = page;
        bytes += Buffer.byteLength(JSON.stringify(page.rows));
        if (rows.length + page.rows.length > 4096 || bytes > 16 * 1024 * 1024) throw new Error('Pending observation query exceeds its size limit.');
        rows.push(...page.rows);
        after = page.next;
      } while (after);
      return { scope: 'observed-pending', coverageComplete: false, tipHash: anchor.tipHash, tipHeight: anchor.tipHeight,
        revision: anchor.revision, rows };
    },
  });
}

module.exports = { openPendingWallet, validatePendingPage, PENDING_LINE_BYTES };
