'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const { readConfirmedTransaction, validateTransactionChunk } = require('./floresta-transactions.cjs');
const { Transaction } = createRequire(path.resolve(__dirname, '../server/package.json'))('bitcoinjs-lib');

const sha256d = bytes => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest();
const owner = '12'.repeat(32);
function fixture(edit = () => {}) {
  const tx = new Transaction();
  tx.addInput(Buffer.alloc(32, 5), 1);
  tx.addOutput(Buffer.alloc(1500, 0x51), 9000);
  tx.setWitness(0, [Buffer.alloc(120, 0xbb)]);
  const raw = tx.toBuffer();
  const sibling = Buffer.alloc(32, 42);
  const header = Buffer.alloc(80);
  sha256d(Buffer.concat([sibling, tx.getHash()])).copy(header, 36);
  const blockHash = sha256d(header).reverse().toString('hex');
  const sent = [];
  return { tx, sent, run: () => readConfirmedTransaction(async command => {
    assert.equal(command.owner, owner);
    const { txid, offset } = command;
    sent.push(offset);
    const reply = { phase: 'confirmed', txid, wtxid: sha256d(raw).reverse().toString('hex'), offset,
      size: raw.length, chunk: raw.subarray(offset, offset + 512).toString('hex'),
      height: 2, tipHeight: 6, tipHash: 'ab'.repeat(32), blockHash, header: header.toString('hex'), position: 1,
      merkle: [Buffer.from(sibling).reverse().toString('hex')] };
    edit(reply);
    return validateTransactionChunk(command, reply);
  }, owner, tx.getId()) };
}
test('retrieves multi-chunk witness bytes and checks transaction ID, header and Merkle branch', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.hex, f.tx.toHex());
  assert.equal(result.confirmations, 5);
  assert.deepEqual(f.sent, [0, 512, 1024, 1536]);
});
test('a branch or tip change between transaction chunks leaves the lookup unavailable', async () => {
  const f = fixture(reply => { if (reply.offset !== 0) reply.tipHash = 'cd'.repeat(32); });
  assert.equal(await f.run(), null);
  assert.equal(await readConfirmedTransaction(async command => validateTransactionChunk(command, { phase: 'unavailable' }), owner, owner), null);
});
test('invalid proof, peer metadata, size, txid or chunk boundaries reject the lookup', async () => {
  for (const edit of [
    reply => { reply.header = '00'.repeat(80); }, reply => { reply.merkle = ['00'.repeat(32)]; },
    reply => { reply.position = 2; }, reply => { reply.size = 4_000_001; },
    reply => { reply.chunk = ''; }, reply => { reply.txid = 'cd'.repeat(32); },
    reply => { reply.offset += 1; }, reply => { reply.height = reply.tipHeight + 1; },
    reply => { if (!reply.offset) reply.chunk = '02000000' + reply.chunk.slice(8); },
    reply => { if (reply.offset === 1536) reply.chunk = reply.chunk.replace('bbbb', 'aaaa'); },
  ]) await assert.rejects(fixture(edit).run());
  await assert.rejects(readConfirmedTransaction(() => assert.fail('invalid owner reached pipe'), '', owner));
});
