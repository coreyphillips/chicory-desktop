'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { Transaction } = createRequire(path.resolve(__dirname, '../server/package.json'))('bitcoinjs-lib');
const { readPendingTransaction, validatePendingChunk } = require('./floresta-pending-transaction.cjs');

test('pending raw bytes require the same pool generation and valid transaction and witness IDs', async () => {
  const tx = new Transaction();
  tx.addInput(Buffer.alloc(32, 4), 1);
  tx.addOutput(Buffer.from([0x51]), 1000);
  tx.setWitness(0, [Buffer.alloc(1200, 1)]);
  const txid = tx.getId();
  const raw = tx.toBuffer();
  const metadata = { phase: 'observed-transaction', coverageComplete: false, txid,
    wtxid: tx.getHash(true).reverse().toString('hex'), height: 0, fee: 100, revision: 3,
    tipHeight: 104, tipHash: '05'.repeat(32), size: raw.length };
  const lookup = change => readPendingTransaction(async command => {
    const { offset } = command;
    const page = { ...metadata, offset, chunk: raw.subarray(offset, offset + 512).toString('hex') };
    return validatePendingChunk(command, change(page));
  }, '12'.repeat(32), txid);
  const result = await lookup(page => page);
  assert.equal(result.txid, txid);
  assert.equal(result.hex, tx.toHex());
  assert.equal(result.coverageComplete, false);
  assert.equal(result.confirmations, 0);
  assert.equal(await lookup(page => page.offset ? { ...page, revision: 4 } : page), null);
  assert.equal(await lookup(page => page.offset ? { phase: 'unavailable' } : page), null);
  await assert.rejects(lookup(page => ({ ...page, wtxid: 'f0'.repeat(32) })), /Invalid pending/);
  await assert.rejects(lookup(page => ({ ...page, coverageComplete: true })), /Invalid pending/);
});
