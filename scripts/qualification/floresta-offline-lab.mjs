// Replay one week's expected Bitcoin block count while the disposable managed
// node is stopped. Both mining and all private wallet observations use regtest.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ManagedFloresta } from '../../desktop/floresta.cjs';
import { candidate } from '../../desktop/floresta-settings.cjs';
import { REGTEST_GENESIS } from './guards.mjs';
import { checkpointSize } from './floresta-parent-lab.mjs';
import { withProofPeer } from './floresta-pending-lab.mjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block, Transaction, networks, opcodes, payments, script } = requireServer('bitcoinjs-lib');
const network = networks.regtest;
const host = '127.0.0.1';
const digest = bytes => createHash('sha256').update(bytes).digest();
const elapsed = start => Math.round(performance.now() - start);

// Count the exact P2P byte stream, including the encrypted handshake and any
// reconnects. The independent reference RPC and the wallet control pipe bypass it.
async function countTraffic(peerPort) {
  const totals = { connections: 0, sentBytes: 0, receivedBytes: 0 };
  const sockets = new Set();
  const server = net.createServer(client => {
    const upstream = net.createConnection({ host, port: peerPort });
    totals.connections++;
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.on('data', b => { totals.sentBytes += b.length; });
    upstream.on('data', b => { totals.receivedBytes += b.length; });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, host);
  await once(server, 'listening');
  return { endpoint: host + ':' + server.address().port, totals, idle: () => !sockets.size,
    close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}

async function waitFor(label, read, accept, node) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let last;
  while (Date.now() < deadline) {
    const status = await node?.status();
    if (status?.phase === 'failed') throw new Error(status.error);
    last = await read();
    if (accept(last)) return last;
    await delay(250);
  }
  throw new Error(label + ' timed out: ' + JSON.stringify(last));
}

async function run(binary, sha256, desktop) {
  const build = candidate(fileURLToPath(new URL('../../', import.meta.url)), sha256);
  return withProofPeer(path.resolve(binary), async ({ root, proof, peerPort }) => {
    const profile = await fs.mkdtemp(path.join(root, 'managed-'));
    assert.deepEqual(await fs.readdir(profile), []);
    const { bsize, bavail } = await fs.statfs(root);
    assert(bsize * bavail > 3 * 1024 ** 3, 'Insufficient temporary disk space for the regtest store');
    const wire = await countTraffic(peerPort);
    const node = desktop
      ? (await import('./floresta-offline-app.mjs')).offlineDesktop(profile, sha256, Number(wire.endpoint.split(':')[1]))
      : new ManagedFloresta({ ...build, network: 'regtest', profileDirectory: profile,
      spawnProcess: (file, args, options) => spawn(file, [...args, '--connect', wire.endpoint], options) });

    const miner = payments.p2sh({ network, redeem: { output: Buffer.from([opcodes.OP_TRUE]) } });
    const watched = payments.p2sh({ network, redeem: { output: script.compile([randomBytes(16), opcodes.OP_DROP, opcodes.OP_TRUE]) } });
    const owner = digest(randomBytes(32)).toString('hex');
    const scriptHash = digest(watched.output).reverse().toString('hex');
    async function guard() {
      assert.equal((await proof('getblockchaininfo')).chain, 'regtest');
      assert.equal(await proof('getblockhash', [0]), REGTEST_GENESIS);
    }
    async function mine(count) {
      await guard();
      let tip;
      for (let remaining = count; remaining > 0;) {
        const batch = Math.min(50, remaining);
        const hashes = await proof('generate', [batch]);
        assert.equal(hashes.length, batch);
        tip = hashes.at(-1);
        remaining -= batch;
      }
      return tip;
    }
    async function blockAt(height) {
      const blockHash = await proof('getblockhash', [height]);
      const block = Block.fromHex(await proof('getblock', [blockHash, 0]));
      assert.equal(block.getId(), blockHash);
      assert(block.checkTxRoots());
      return block;
    }
    async function pay(parent, vout, source, amount) {
      assert(parent.outs[vout].script.equals(source.output));
      const tx = new Transaction();
      tx.addInput(parent.getHash(), vout, 0xfffffffd, script.compile([source.redeem.output]));
      tx.addOutput(miner.output, parent.outs[vout].value - amount - 2500);
      tx.addOutput(watched.output, amount);
      await guard();
      assert.equal(await proof('sendrawtransaction', [tx.toHex()]), tx.getId());
      const blockHash = await mine(1);
      const height = await proof('getblockcount');
      const block = await blockAt(height);
      assert.equal(block.getId(), blockHash);
      assert.equal(block.transactions[1].toHex(), tx.toHex());
      return { tx, txid: tx.getId(), blockHash, height, position: 1, value: amount, vout: 1 };
    }
    async function waitTip(height, hash) {
      return waitFor('Validated tip', () => node.status(), s => s.tipSynced && s.validatedHeight === height &&
        s.height === height && s.tipHash === hash && s.historicalVerification === 'verified', node);
    }
    async function waitCoverage(height, hash) {
      return waitFor('Durable watch scan', () => node.watchCoverage(owner),
        c => c.phase === 'caught-up' && c.height === height && c.hash === hash, node);
    }
    async function verify(session, entries, coins, height, hash) {
      const anchor = { scope: 'confirmed-only', tipHeight: height, tipHash: hash };
      const row = ({ txid, height, position }) => ({ txid, height, position });
      assert.deepEqual(await session.history(scriptHash), { ...anchor, rows: entries.map(row) });
      assert.deepEqual(await session.unspent(scriptHash), { ...anchor, rows: coins.map(c => ({ ...row(c), value: c.value, vout: c.vout })) });
      const balance = coins.reduce((sum, c) => sum + c.value, 0);
      assert.deepEqual(await session.balance(scriptHash), { ...anchor, confirmed: balance });
      const history = [];
      for (const entry of entries) {
        const result = await session.transaction(entry.txid);
        assert.equal(result?.hex, entry.tx.toHex());
        assert.equal(result.blockHash, entry.blockHash);
        assert.equal(result.height, entry.height);
        assert.equal(result.position, entry.position);
        assert.equal(result.confirmations, height - entry.height + 1);
        assert.equal(result.tipHash, hash);
        assert.equal(result.tipHeight, height);
        history.push({ ...row(entry), blockHash: entry.blockHash, confirmations: result.confirmations });
      }
      return { history, balance, unspent: coins.map(c => ({ txid: c.txid, vout: c.vout, value: c.value })) };
    }
    try {
      console.error('Preparing confirmed funding on regtest');
      await mine(101);
      const first = (await blockAt(1)).transactions[0];
      const second = (await blockAt(2)).transactions[0];
      const old = await pay(first, first.outs.findIndex(out => out.script.equals(miner.output)), miner, 100000);
      assert.equal(old.height, 102);
      await node.start();
      await waitTip(old.height, old.blockHash);
      // Register only once. After the stop all wallet data must come from the
      // same private persisted registration and a newly authorized read session.
      await node.registerWatches({ owner, scripts: [watched.output.toString('hex')], outpoints: [] });
      await waitCoverage(old.height, old.blockHash);
      const oldSession = await node.openConfirmedWallet(owner, new AbortController().signal);
      const before = await verify(oldSession, [old], [old], old.height, old.blockHash);
      await node.stop();
      assert.equal((await node.status()).phase, 'stopped');
      await assert.rejects(oldSession.history(scriptHash), /closed/i);
      await waitFor('Proof peer disconnect', wire.idle, Boolean);
      const nodeDir = path.join(profile, 'chicory-floresta');
      const diskBefore = await checkpointSize(nodeDir);
      const trafficBefore = { ...wire.totals };

      console.error('Mining 1008 blocks with the wallet monitor stopped');
      await mine(503);
      const spend = await pay(old.tx, old.vout, watched, 31000);
      await mine(502);
      const credit = await pay(second, second.outs.findIndex(out => out.script.equals(miner.output)), miner, 47000);
      const tipHash = await mine(1);
      const tipHeight = await proof('getblockcount');
      assert.equal(tipHeight - old.height, 1008);
      assert.deepEqual(wire.totals, trafficBefore);
      assert.deepEqual(await proof('getrawmempool'), []);
      console.error('Resuming the same managed store at height ' + tipHeight);
      const start = performance.now();
      await node.start();
      const status = await waitTip(tipHeight, tipHash);
      const tipMs = elapsed(start);
      assert.equal(status.historicalHeight, old.height);
      assert.equal(status.historicalTarget, old.height);
      const coverage = await waitCoverage(tipHeight, tipHash);
      const scannedMs = elapsed(start);
      assert.equal(coverage.matchedTransactions, 3);
      const session = await node.openConfirmedWallet(owner, new AbortController().signal);
      const after = await verify(session, [old, spend, credit], [spend, credit], tipHeight, tipHash);
      await assert.rejects(oldSession.history(scriptHash), /closed/i);
      await session.close();
      const verifiedMs = elapsed(start);
      const traffic = Object.fromEntries(Object.entries(wire.totals).map(([k, n]) => [k, n - trafficBefore[k]]));
      assert(traffic.connections > 0 && traffic.sentBytes > 0 && traffic.receivedBytes > 0);
      await node.stop();
      const diskAfter = await checkpointSize(nodeDir);
      return { network: 'regtest', lifecycle: desktop ? 'source Electron quit and automatic resume' : 'managed supervisor restart', platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model,
        binarySha256: sha256, proofPeerSha256: digest(await fs.readFile(binary)).toString('hex'),
        oldHeight: old.height, tipHeight, tipHash, missedBlocks: tipHeight - old.height, before, after, coverage,
        timings: { validatedTipMs: tipMs, scannedMs, verifiedMs }, traffic, diskBefore, diskAfter, appExits: node.exits };
    } finally {
      try { await node.stop(); } finally { await wire.close(); }
    }
  });
}

const { values } = parseArgs({ options: { utreexod: { type: 'string' }, digest: { type: 'string' }, desktop: { type: 'boolean', default: false } } });
if (!values.utreexod || !values.digest) throw new Error('Supply --utreexod BINARY --digest SHA256');
console.log(JSON.stringify(await run(values.utreexod, values.digest, values.desktop), null, 2));
