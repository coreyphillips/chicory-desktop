'use strict';

const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');

const CHUNK_BYTES = 512;
const MAX_TX_BYTES = 4_000_000;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
const invalid = () => new Error('Invalid confirmed transaction proof from the managed node.');
const sha256d = bytes => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();

function validateTransactionChunk(command, value) {
  if (value?.phase === 'unavailable' && Object.keys(value).length === 1) return null;
  if (value?.phase !== 'confirmed' || value.txid !== command.txid || !hash(value.txid) || !hash(value.wtxid) ||
      !uint(value.height) || !uint(value.tipHeight) || value.tipHeight < value.height ||
      !hash(value.blockHash) || !hash(value.tipHash) || typeof value.header !== 'string' || !/^[a-f0-9]{160}$/.test(value.header) ||
      !uint(value.position) || !Array.isArray(value.merkle) || value.merkle.length > 24 || !value.merkle.every(hash) ||
      value.position >= 2 ** value.merkle.length || !uint(value.size) || !value.size || value.size > MAX_TX_BYTES ||
      value.offset !== command.offset || !uint(value.offset) || value.offset >= value.size ||
      typeof value.chunk !== 'string' || value.chunk.length !== 2 * Math.min(CHUNK_BYTES, value.size - value.offset) ||
      !/^[0-9a-f]+$/.test(value.chunk)) throw invalid();
  const { txid, wtxid, height, tipHeight, blockHash, tipHash, header, position, merkle, size, offset, chunk } = value;
  return { txid, wtxid, height, tipHeight, blockHash, tipHash, header, position, merkle, size, offset, chunk };
}

// The daemon serves only an owner's verified matches and their direct inputs.
// Each chunk rechecks the active chain. Reject a lookup spanning different
// anchors rather than assembling bytes from two branches of the chain.
async function readConfirmedTransaction(send, owner, txid) {
  if (!hash(owner) || !hash(txid)) throw new Error('Invalid managed transaction lookup.');
  let anchor;
  const chunks = [];
  let offset = 0;
  do {
    const value = await send({ action: 'transaction', owner, txid, offset });
    if (!value) return null;
    const { chunk, offset: start, ...metadata } = value;
    if (start !== offset) throw invalid();
    if (anchor && JSON.stringify(metadata) !== JSON.stringify(anchor)) return null;
    anchor = metadata;
    chunks.push(chunk);
    offset += chunk.length / 2;
  } while (offset < anchor.size);
  const raw = Buffer.from(chunks.join(''), 'hex');
  const root = process.versions.electron && require('electron').app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
  const { Transaction } = createRequire(path.join(root, 'server/package.json'))('bitcoinjs-lib');
  const header = Buffer.from(anchor.header, 'hex');
  if (Transaction.fromBuffer(raw).getId() !== txid || sha256d(raw).reverse().toString('hex') !== anchor.wtxid ||
      sha256d(header).reverse().toString('hex') !== anchor.blockHash ||
      (anchor.tipHeight === anchor.height && anchor.tipHash !== anchor.blockHash)) throw invalid();
  let digest = Buffer.from(txid, 'hex').reverse();
  let index = anchor.position;
  for (const sibling of anchor.merkle) {
    const bytes = Buffer.from(sibling, 'hex').reverse();
    digest = sha256d(index % 2 ? Buffer.concat([bytes, digest]) : Buffer.concat([digest, bytes]));
    index = Math.floor(index / 2);
  }
  if (index !== 0 || !digest.equals(header.subarray(36, 68))) throw invalid();
  const { size, ...proof } = anchor;
  return { ...proof, confirmations: proof.tipHeight - proof.height + 1, hex: raw.toString('hex') };
}

module.exports = { readConfirmedTransaction, validateTransactionChunk };
