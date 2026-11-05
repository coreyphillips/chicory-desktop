import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block } = requireServer('bitcoinjs-lib');
const scriptHash = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest().reverse().toString('hex');

// Independently derive all confirmed rows from this short, disposable chain.
// Cache by block hash so a detached fixture block cannot survive a reorg.
export function confirmedFixture({ node, proof, waitFor, owners, script }) {
  const cache = new Map();
  async function at(height) {
    const hash = await proof('getblockhash', [height]);
    if (!cache.has(hash)) {
      const block = Block.fromHex(await proof('getblock', [hash, 0]));
      assert.equal(block.getId(), hash);
      cache.set(hash, block);
    }
    return cache.get(hash);
  }
  return async function verify(tipHeight, tipHash) {
    const blocks = [];
    for (let first = 0; first <= tipHeight; first += 8) {
      const count = Math.min(8, tipHeight - first + 1);
      blocks.push(...await Promise.all(Array.from({ length: count }, (_, i) => at(first + i))));
    }
    assert.equal(blocks.at(-1).getId(), tipHash);
    const minerScript = blocks[1].transactions[0].outs.find(o => o.value > 0).script.toString('hex');
    await node.registerWatches({ owner: owners.miner, scripts: [minerScript], outpoints: [] });
    await waitFor('Full coinbase history', () => node.watchCoverage(owners.miner), state =>
      state.phase === 'caught-up' && state.height === tipHeight && state.hash === tipHash);
    async function compare(owner, watched, foreign) {
      const history = [];
      const coins = new Map();
      for (const [height, block] of blocks.entries()) {
        for (const [position, tx] of block.transactions.entries()) {
          const txid = tx.getId();
          let matches = false;
          for (const input of tx.ins) {
            const prev = Buffer.from(input.hash).reverse().toString('hex') + ':' + input.index;
            if (coins.delete(prev)) matches = true;
          }
          for (const [vout, out] of tx.outs.entries()) {
            if (out.script.toString('hex') !== watched) continue;
            matches = true;
            if (height > 0) coins.set(txid + ':' + vout, { height, position, txid, vout, value: out.value });
          }
          if (matches) history.push({ height, position, txid });
        }
      }
      const signal = new AbortController();
      const session = node.openConfirmedWallet(owner, signal.signal);
      const hash = scriptHash(watched);
      const [actual, unspent, balance, unauthorized] = await Promise.all([
        session.history(hash), session.unspent(hash), session.balance(hash), session.history(scriptHash(foreign))]);
      assert.equal(unauthorized, null);
      const anchor = { scope: 'confirmed-only', tipHash, tipHeight };
      assert.deepEqual(actual, { ...anchor, rows: history });
      const rows = [...coins.values()];
      assert.deepEqual(unspent, { ...anchor, rows });
      const confirmed = rows.reduce((sum, coin) => sum + coin.value, 0);
      assert.deepEqual(balance, { ...anchor, confirmed });
      const { height, position, txid } = history.at(-1);
      const [tx, merkle] = await Promise.all([session.transaction(txid), session.merkle(txid, height)]);
      assert.equal(tx.hex, blocks[height].transactions[position].toHex());
      assert.deepEqual(merkle, { ...anchor, height, position, blockHash: blocks[height].getId(), merkle: tx.merkle });
      assert.equal(await session.merkle(txid, height + 1), null);
      signal.abort();
      await assert.rejects(session.balance(hash), /closed/);
      return { history: history.length, unspent: rows.length, confirmed, lastTxid: txid };
    }
    return { tipHeight, tipHash, wallet: await compare(owners.wallet, script, minerScript),
      miner: await compare(owners.miner, minerScript, script) };
  };
}
