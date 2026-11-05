import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block } = requireServer('bitcoinjs-lib');

export async function verifyManagedParents({ node, owner, otherOwner, proof, matchedHeight, matchedTxid, parentHeight, detachedTxid }) {
  async function blockAt(height) {
    const hash = await proof('getblockhash', [height]);
    const block = Block.fromHex(await proof('getblock', [hash, 0]));
    assert.equal(block.getId(), hash);
    return block;
  }
  const tipHash = await proof('getbestblockhash');
  const tipHeight = await proof('getblockcount');
  const [matchedBlock, parentBlock] = await Promise.all([blockAt(matchedHeight), blockAt(parentHeight)]);
  const matched = matchedTxid ? matchedBlock.transactions.find(tx => tx.getId() === matchedTxid) :
    matchedBlock.transactions.find(tx => !tx.isCoinbase());
  assert.ok(matched);
  const parent = parentBlock.transactions.find(tx => matched.ins.some(input => input.hash.equals(tx.getHash())));
  assert.ok(parent, 'The reference block must include the direct parent of the matched transaction.');
  async function verified(tx, block, height) {
    const start = performance.now();
    const result = await node.confirmedTransaction(owner, tx.getId());
    const lookupMs = Math.round(performance.now() - start);
    assert.ok(result);
    assert.equal(result.hex, tx.toHex());
    assert.equal(result.txid, tx.getId());
    assert.equal(result.height, height);
    assert.equal(result.header, block.toHex(true));
    assert.equal(result.blockHash, block.getId());
    assert.equal(result.tipHash, tipHash);
    assert.equal(result.tipHeight, tipHeight);
    assert.equal(result.confirmations, tipHeight - height + 1);
    assert.equal(result.position, block.transactions.findIndex(entry => entry.getId() === tx.getId()));
    if (otherOwner) assert.equal(await node.confirmedTransaction(otherOwner, tx.getId()), null);
    return { txid: result.txid, bytes: result.hex.length / 2, height, blockHash: result.blockHash,
      merkleSiblings: result.merkle.length, position: result.position, confirmations: result.confirmations,
      lookupMs };
  }
  const result = { matched: await verified(matched, matchedBlock, matchedHeight), parent: await verified(parent, parentBlock, parentHeight) };
  if (detachedTxid) {
    assert.equal(await node.confirmedTransaction(owner, detachedTxid), null);
    result.detachedWithdrawn = detachedTxid;
  }
  // This unrelated old coinbase is outside this owner's matches and direct
  // parents. The peer has it, but the managed lookup must decline it.
  const unrelated = (await blockAt(7)).transactions[0].getId();
  assert.equal(await node.confirmedTransaction(owner, unrelated), null);
  result.unrelatedUnavailable = true;
  return result;
}

// Take the checkpoint with the managed child stopped, when database files are stable.
export async function checkpointSize(directory) {
  let files = 0;
  let fileBytes = 0;
  let allocatedBytes = 0;
  const pending = [directory];
  while (pending.length) {
    const base = pending.pop();
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const file = path.join(base, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) {
        const info = await stat(file);
        files++;
        fileBytes += info.size;
        allocatedBytes += info.blocks * 512;
      }
    }
  }
  return { files, fileBytes, allocatedBytes };
}
