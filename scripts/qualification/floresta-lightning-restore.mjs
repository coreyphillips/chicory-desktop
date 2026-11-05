// Replay an independently exported Core/Electrs regtest and actual Beignet
// watch snapshots. Only public chain material enters the disposable proof peer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ManagedFloresta } from '../../desktop/floresta.cjs';
import { candidate } from '../../desktop/floresta-settings.cjs';
import { registrations } from '../../desktop/floresta-wallet-sync.cjs';
import { publicSnapshot } from '../../server/floresta-collection.js';
import { REGTEST_GENESIS } from './guards.mjs';
import { withProofPeer } from './floresta-pending-lab.mjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block } = requireServer('bitcoinjs-lib');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashScript = bytes => Buffer.from(digest(bytes), 'hex').reverse().toString('hex');
const inputPoint = input => Buffer.from(input.hash).reverse().toString('hex') + ':' + input.index;

async function readLocal(file, limit) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Unexpected regtest fixture file or size');
  return fs.readFile(file, 'utf8');
}

async function readFixture(directory) {
  const input = JSON.parse(await readLocal(path.join(directory, 'fixture.json'), 16 * 1024 * 1024));
  assert.equal(input.version, 1);
  assert.equal(input.network, 'regtest');
  assert(Number.isInteger(input.tipHeight) && input.tipHeight > 100 && input.tipHeight <= 5000);
  assert.match(input.tipHash, /^[a-f0-9]{64}$/);
  assert.equal(input.liveRole, 'channel-counterparty');
  if (input.restored) {
    assert.equal(input.restoredRole, 'recipient');
    assert.notEqual(input.restored.owner, input.live.owner);
    assert.equal(input.restore?.kind, 'full-backup');
    assert.equal(input.restore.heldOrClosed, true, 'Stale channel custody must stay held or be closed by its peer');
  }
  const byPoint = new Map();
  for (const key of ['priorFunding', 'currentFunding', 'payerCoin']) {
    const point = input[key];
    assert.match(point, /^[a-f0-9]{64}:(?:0|[1-9][0-9]{0,9})$/);
    const [txid, vout] = point.split(':');
    assert(Number(vout) <= 0xffffffff);
    byPoint.set(key, { point, txid, vout: Number(vout) });
  }
  assert.equal(new Set([...byPoint.values()].map(p => p.txid)).size, 3);
  const text = await readLocal(path.join(directory, 'blocks.ndjson'), 64 * 1024 * 1024);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, input.tipHeight + 1);
  let previous;
  const blocks = lines.map((line, height) => {
    const raw = JSON.parse(line);
    assert.equal(typeof raw, 'string');
    assert(raw.length <= 8000000 && /^(?:[0-9a-f]{2})+$/.test(raw));
    const block = Block.fromHex(raw);
    assert.equal(block.toHex(), raw, 'Noncanonical input block bytes at ' + height);
    assert(block.checkTxRoots() && block.checkProofOfWork(), 'Invalid input block at ' + height);
    if (height === 0) assert.equal(block.getId(), REGTEST_GENESIS);
    else assert.equal(Buffer.from(block.prevHash).reverse().toString('hex'), previous);
    previous = block.getId();
    for (const [position, tx] of block.transactions.entries()) {
      const txid = tx.getId();
      for (const item of byPoint.values()) {
        if (txid !== item.txid) continue;
        assert(!item.tx && tx.outs[item.vout]);
        Object.assign(item, { tx, blockHash: previous, header: block.toHex(true), height, position });
      }
    }
    return block;
  });
  assert.equal(previous, input.tipHash);
  for (const item of byPoint.values()) assert(item.tx && item.height > 0, 'Expected confirmed funding input or output is absent');
  const current = byPoint.get('currentFunding');
  const referenced = new Set(current.tx.ins.map(inputPoint));
  for (const key of ['priorFunding', 'payerCoin']) {
    assert(referenced.has(byPoint.get(key).point), 'The direct funding transaction did not spend ' + key);
  }
  const scripts = new Map();
  for (const id of ['priorFunding', 'currentFunding']) {
    const point = byPoint.get(id);
    const script = point.tx.outs[point.vout].script;
    scripts.set(script.toString('hex'), hashScript(script));
  }
  return { input, blocks, byPoint, scripts };
}

// Derive complete script history and the current UTXO set from the captured
// Bitcoin Core blocks, independently of registration and the Floresta indexes.
function scriptReference(blocks, scriptHex) {
  const history = [], coins = new Map();
  for (const [height, block] of blocks.entries()) {
    for (const [position, tx] of block.transactions.entries()) {
      const row = { txid: tx.getId(), height, position };
      let relevant = false;
      for (const prev of tx.ins.map(inputPoint)) if (coins.delete(prev)) relevant = true;
      for (const [vout, output] of tx.outs.entries()) {
        if (output.script.toString('hex') !== scriptHex) continue;
        relevant = true;
        coins.set(row.txid + ':' + vout, { ...row, vout, value: output.value });
      }
      if (relevant) history.push(row);
    }
  }
  return { history, coins: [...coins.values()] };
}

async function waitFor(label, node, read, accept) {
  const end = Date.now() + 20 * 60 * 1000;
  let value;
  while (Date.now() < end) {
    if (node.status().phase === 'failed') throw new Error(node.status().error);
    value = await read();
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error(label + ' timed out: ' + JSON.stringify(value));
}

async function checkWallet(node, source, fixture) {
  const { input, byPoint, scripts, blocks } = fixture;
  const { owner, snapshot } = source;
  assert.match(owner, /^[0-9a-f]{64}$/);
  const view = publicSnapshot(snapshot, 'regtest', { remaining: 8 * 1024 * 1024 });
  assert.equal(view.status, 'observed', 'A wallet supplied no observed public watch snapshot');
  assert.deepEqual(view, snapshot, 'Unexpected fields in the public watch snapshot');
  for (const batch of registrations(owner, view)) await node.registerWatches(batch);
  const coverage = await waitFor('Owner scan', node, () => node.watchCoverage(owner),
    state => state.phase === 'caught-up' && state.height === input.tipHeight && state.hash === input.tipHash);
  const session = node.openConfirmedWallet(owner, new AbortController().signal);
  const proofs = {}, histories = [];
  try {
    for (const [key, ref] of byPoint) {
      const tx = await session.transaction(ref.txid);
      assert(tx, 'Owner lacks the ' + key + ' confirmed proof');
      assert.equal(tx.hex, ref.tx.toHex());
      assert.equal(tx.header, ref.header);
      assert.equal(tx.blockHash, ref.blockHash);
      assert.equal(tx.position, ref.position);
      assert.equal(tx.height, ref.height);
      assert.equal(tx.confirmations, input.tipHeight - ref.height + 1);
      assert.equal(tx.tipHash, input.tipHash);
      assert.equal(tx.tipHeight, input.tipHeight);
      proofs[key] = { outpoint: ref.point, height: tx.height, blockHash: tx.blockHash,
        position: tx.position, confirmations: tx.confirmations, value: ref.tx.outs[ref.vout].value,
        explicitlyWatched: view.outpoints.some(p => p.outpoint === ref.point) };
    }
    for (const [hex, scriptHash] of scripts) {
      const expected = scriptReference(blocks, hex);
      const [history, unspent, balance] = await Promise.all([
        session.history(scriptHash), session.unspent(scriptHash), session.balance(scriptHash)
      ]);
      const anchor = { scope: 'confirmed-only', tipHeight: input.tipHeight, tipHash: input.tipHash };
      assert.deepEqual(history, { ...anchor, rows: expected.history });
      assert.deepEqual(unspent, { ...anchor, rows: expected.coins });
      assert.deepEqual(balance, { ...anchor, confirmed: expected.coins.reduce((sum, coin) => sum + coin.value, 0) });
      histories.push({ scriptHash, history: history.rows, unspent: unspent.rows, confirmed: balance.confirmed });
    }
    const remaining = new Set(histories.flatMap(h => h.unspent.map(row => row.txid + ':' + row.vout)));
    assert(remaining.has(byPoint.get('currentFunding').point), 'The new funding output must be unspent');
    assert(!remaining.has(byPoint.get('priorFunding').point), 'The superseded funding output must be spent');
    return { status: view.status, counts: { descriptors: view.descriptors.length, scripts: view.scripts.length,
      outpoints: view.outpoints.length, unresolvedHashes: view.unresolvedHashes.length }, coverage, proofs, histories };
  } finally { session.close(); }
}

async function qualify({ fixture: directory, utreexod, digest: sha256 }) {
  const fixture = await readFixture(directory);
  const { input, blocks } = fixture;
  const build = candidate(fileURLToPath(new URL('../../', import.meta.url)), sha256);
  return withProofPeer(path.resolve(utreexod), async ({ root, proof, peerEndpoint }) => {
    console.error('Indexing ' + input.tipHeight + ' captured regtest blocks on the disposable proof peer');
    for (let height = 1; height < blocks.length; height++) {
      const accepted = await proof('submitblock', [blocks[height].toHex()]);
      assert.equal(accepted, null, 'Proof peer rejected captured block ' + height + ': ' + accepted);
    }
    assert.equal(await proof('getblockcount'), input.tipHeight);
    assert.equal(await proof('getbestblockhash'), input.tipHash);
    const profile = await fs.mkdtemp(path.join(root, 'managed-'));
    assert.deepEqual(await fs.readdir(profile), []);
    const node = new ManagedFloresta({ ...build, profileDirectory: profile, network: 'regtest',
      spawnProcess: (file, args, options) => spawn(file, [...args, '--connect', peerEndpoint], options) });
    try {
      console.error('Validating the captured chain from empty managed storage');
      await node.start();
      const sync = await waitFor('Full chain validation', node, () => node.status(),
        s => s.tipSynced && s.historicalVerification === 'verified' && s.height === input.tipHeight &&
          s.validatedHeight === input.tipHeight && s.tipHash === input.tipHash);
      console.error('Scanning the counterparty watch snapshot');
      const live = await checkWallet(node, input.live, fixture);
      let restored;
      if (input.restored?.snapshot.status === 'recovery-pending') {
        assert.deepEqual(input.restored.snapshot, { status: 'recovery-pending', coverageComplete: false });
        restored = { status: 'recovery-pending', registered: false };
      } else if (input.restored) {
        console.error('Scanning the restored recipient watch snapshot');
        restored = await checkWallet(node, input.restored, fixture);
      }
      return { network: 'regtest', tipHeight: input.tipHeight, tipHash: input.tipHash, binarySha256: sha256,
        proofPeerSha256: digest(await fs.readFile(utreexod)), emptyStorage: true,
        historical: { state: sync.historicalVerification, height: sync.historicalHeight, target: sync.historicalTarget },
        liveRole: input.liveRole, live, restoredRole: input.restoredRole, restored,
        restore: input.restored && { kind: input.restore.kind, heldOrClosed: input.restore.heldOrClosed } };
    } finally { await node.stop(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { fixture: { type: 'string' }, utreexod: { type: 'string' }, digest: { type: 'string' } } });
  if (!values.fixture || !values.utreexod || !values.digest) throw new Error('Supply --fixture DIRECTORY --utreexod BINARY --digest SHA256');
  console.log(JSON.stringify(await qualify(values), null, 2));
}
