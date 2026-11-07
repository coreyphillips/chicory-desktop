'use strict';

const { matchesTransactionBytes } = require('./floresta-transactions.cjs');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Invalid pending transaction from the managed node.');
const pageBytes = 512;

function validatePendingChunk(command, value) {
  if (value?.phase === 'unavailable' && Object.keys(value).length === 1) return null;
  if (value?.phase !== 'observed-transaction' || value.coverageComplete !== false ||
      !hash(command.txid) || value.txid !== command.txid || !hash(value.wtxid) || !hash(value.tipHash) ||
      !Number.isSafeInteger(value.tipHeight) || value.tipHeight < 0 || value.tipHeight > 0xffffffff ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || ![0, -1].includes(value.height) ||
      !Number.isSafeInteger(value.fee) || value.fee < 0 || value.fee > 21e6 * 1e8 ||
      !Number.isInteger(value.size) || value.size < 1 || value.size > 400000 ||
      command.offset !== value.offset || !Number.isInteger(value.offset) || value.offset < 0 ||
      value.offset >= value.size || value.offset % pageBytes !== 0 ||
      typeof value.chunk !== 'string' || value.chunk.length !== 2 * Math.min(pageBytes, value.size - value.offset) ||
      !/^[a-f0-9]+$/.test(value.chunk)) throw invalid();
  const { txid, wtxid, height, fee, tipHeight, tipHash, revision, size, offset, chunk } = value;
  return { txid, wtxid, height, fee, tipHeight, tipHash, revision, size, offset, chunk };
}

async function readPendingTransaction(send, owner, txid) {
  if (!hash(owner) || !hash(txid)) throw invalid();
  let anchor;
  let offset = 0;
  const pages = [];
  do {
    const item = await send({ action: 'pending-transaction', owner, txid, offset });
    if (!item) return null;
    const { chunk, offset: start, ...metadata } = item;
    if (start !== offset) throw invalid();
    if (anchor && JSON.stringify(metadata) !== JSON.stringify(anchor)) return null;
    anchor = metadata;
    pages.push(chunk);
    offset += chunk.length / 2;
  } while (offset < anchor.size);
  const hex = pages.join('');
  if (!matchesTransactionBytes(Buffer.from(hex, 'hex'), txid, anchor.wtxid)) throw invalid();
  const { size, ...observed } = anchor;
  return { ...observed, scope: 'observed-pending', confirmations: 0, coverageComplete: false, hex };
}

module.exports = { readPendingTransaction, validatePendingChunk };
