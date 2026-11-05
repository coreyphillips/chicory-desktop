// Disposable regtest only. This peer verifies a real Utreexo transaction proof
// on the P2P wire. Wallet results come separately from the managed child pipe.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { assertDisposableProfile, REGTEST_GENESIS } from './guards.mjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block, Transaction, networks, opcodes, payments, script } = requireServer('bitcoinjs-lib');
const miner = payments.p2sh({ network: networks.regtest, redeem: { output: Buffer.from([opcodes.OP_TRUE]) } });
const magic = Buffer.from('fabfb5da', 'hex');
const MAX = (1n << 64n) - 1n;
const packetLimit = 65536;
const hash = (algorithm, ...parts) => parts.reduce((h, part) => h.update(part), createHash(algorithm)).digest();
const tag = hash('sha512', 'UtreexoV1');
const dsha = bytes => hash('sha256', hash('sha256', bytes));
const fromId = id => Buffer.from(id, 'hex').reverse();
const u32 = n => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(n); return bytes; };
const u64 = n => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(n)); return bytes; };

function packet(command, payload) {
  const header = Buffer.alloc(24);
  magic.copy(header);
  header.write(command, 4, 'ascii');
  header.writeUInt32LE(payload.length, 16);
  dsha(payload).copy(header, 20, 0, 4);
  return Buffer.concat([header, payload]);
}

function cursor(bytes) {
  let at = 0;
  const take = length => {
    assert(Number.isSafeInteger(length) && length >= 0 && length <= bytes.length - at, 'Truncated wire field');
    const field = bytes.subarray(at, at + length);
    at += length;
    return field;
  };
  function compact() {
    const n = take(1)[0];
    if (n < 253) return BigInt(n);
    const value = n === 253 ? BigInt(take(2).readUInt16LE()) : n === 254 ? BigInt(take(4).readUInt32LE()) : take(8).readBigUInt64LE();
    assert(value >= (n === 253 ? 253n : n === 254 ? 65536n : 0x100000000n), 'Noncanonical CompactSize');
    return value;
  }
  return { take, compact, end: () => assert.equal(at, bytes.length, 'Unexpected trailing bytes') };
}

function readProof(reader) {
  assert.equal(reader.compact(), 2n, 'The funded fixture spends two confirmed coins');
  const targets = [reader.compact(), reader.compact()];
  assert.notEqual(targets[0], targets[1]);
  const count = reader.compact();
  assert(count > 0n && count <= 32n, 'Unexpected proof size for a small regtest forest');
  const hashes = Array.from({ length: Number(count) }, () => reader.take(32));
  return { targets, hashes };
}

const parentOf = pos => (pos >> 1n) | (1n << 63n);
const order = (a, b) => a === b ? 0 : a < b ? -1 : 1;

// The wire uses a 63-row forest. A promoted leaf can have an internal-node
// position, so CompactSize positions stay BigInt even on this 104-block chain.
function proofLayout(targets, stump) {
  const width = BigInt(stump.numleaves);
  assert(width >= 104n && width < 512n);
  const roots = new Map();
  for (let row = 8n; row >= 0n; row--) {
    if (!(width & (1n << row))) continue;
    const first = width & ~((2n << row) - 1n);
    const root = ((first >> row) | (MAX << (64n - row))) & MAX;
    const bytes = stump.roots[roots.size];
    assert.match(bytes, /^[0-9a-f]{64}$/);
    roots.set(root, bytes);
  }
  assert.equal(roots.size, stump.roots.length);
  const chain = new Set();
  for (const target of targets) {
    let pos = target;
    for (let n = 0; !roots.has(pos); n++) {
      assert(n < 10 && pos !== MAX, 'Target is outside this regtest accumulator');
      chain.add(pos);
      pos = parentOf(pos);
    }
  }
  const siblings = [...chain].map(pos => pos ^ 1n).filter(pos => !chain.has(pos)).sort(order);
  return { roots, siblings, chain: [...chain].sort(order) };
}

function verifyStump(layout, targets, leaves, hashes) {
  assert.equal(layout.siblings.length, hashes.length);
  const known = new Map(targets.map((pos, i) => [pos, leaves[i]]));
  for (const [i, pos] of layout.siblings.entries()) known.set(pos, hashes[i]);
  for (const pos of layout.chain) {
    const left = pos & ~1n;
    const parent = parentOf(pos);
    if (!known.has(parent)) known.set(parent, hash('sha512-256', known.get(left), known.get(left + 1n)));
  }
  let checked = 0;
  for (const [pos, value] of layout.roots) {
    if (!known.has(pos)) continue;
    assert.equal(known.get(pos).toString('hex'), value, 'Proof failed at the active regtest root');
    checked++;
  }
  assert(checked);
}

function validateResponse(bytes, tx, inputs, expected, stump) {
  const reader = cursor(bytes);
  const { targets, hashes } = readProof(reader);
  assert.deepEqual(targets, expected.targets);
  assert.deepEqual(hashes, expected.hashes, 'P2P siblings differ from the indexed chain-tip proof');
  const marked = tx.clone();
  for (const input of marked.ins) input.index *= 2; // Wire flag 0 means a confirmed input.
  const raw = marked.toBuffer();
  assert.deepEqual(reader.take(raw.length), raw);
  const leaves = inputs.map(input => {
    const code = u32(input.height * 2 + 1);
    assert.deepEqual(reader.take(4), code);
    assert.deepEqual(reader.take(8), u64(input.value));
    assert.equal(reader.take(1)[0], 3, 'Expected compact P2SH leaf');
    return hash('sha512-256', tag, tag, fromId(input.blockHash), fromId(input.txid), u32(input.vout), code,
      u64(input.value), Buffer.from([miner.output.length]), miner.output);
  });
  reader.end();
  assert.deepEqual(leaves, expected.leaves);
  const layout = proofLayout(targets, stump);
  verifyStump(layout, targets, leaves, hashes);
  const damaged = hashes.map(bytes => Buffer.from(bytes));
  damaged[0][0] ^= 1;
  assert.throws(() => verifyStump(layout, targets, leaves, damaged), /Proof failed/);
  return { txid: tx.getId(), inputCount: inputs.length, targets: targets.map(String),
    requestedPositions: layout.siblings.map(String), hashCount: hashes.length, responseBytes: bytes.length };
}

async function listenForOffer({ peerPort, tipHeight, tx, inputs, expected, stump }) {
  assert(Number.isInteger(peerPort) && peerPort > 0 && peerPort <= 65535);
  const socket = net.createConnection({ port: peerPort, host: '127.0.0.1' });
  const handshake = Promise.withResolvers();
  const result = Promise.withResolvers();
  result.promise.catch(() => {});
  let receivedVersion = false, requested = false, completed = false, buffered = Buffer.alloc(0);
  const timeout = setTimeout(() => socket.destroy(new Error('Regtest proof peer timed out')), 30000);
  function close(error) {
    clearTimeout(timeout);
    if (!completed) { handshake.reject(error); result.reject(error); }
    socket.destroy();
  }
  socket.once('error', close);
  socket.once('close', () => close(new Error('Regtest proof peer closed')));
  function message(command, bytes) {
    if (command === 'version') {
      assert(!receivedVersion && bytes.length >= 80 && (bytes.readBigUInt64LE(4) & 0x1000n));
      receivedVersion = true;
      socket.write(packet('verack', Buffer.alloc(0)));
    } else if (command === 'verack') {
      assert(receivedVersion && bytes.length === 0);
      handshake.resolve();
    } else if (command === 'ping') {
      assert.equal(bytes.length, 8);
      socket.write(packet('pong', bytes));
    } else if (command === 'inv') {
      const reader = cursor(bytes), count = reader.compact();
      assert(count <= 512n);
      const inventory = Array.from({ length: Number(count) }, () => ({ type: reader.take(4).readUInt32LE(), id: reader.take(32) }));
      reader.end();
      const i = inventory.findIndex(item => item.type === 1 && item.id.equals(tx.getHash()));
      if (i < 0 || requested) return;
      const announced = [];
      for (const item of inventory.slice(i + 1)) {
        if (item.type !== 6) break;
        for (let j = 0; j < 32; j += 8) {
          const target = item.id.readBigUInt64LE(j);
          if (target !== MAX) announced.push(target);
        }
      }
      assert.deepEqual(announced, expected.targets);
      const { siblings } = proofLayout(announced, stump);
      const vectors = [Buffer.concat([u32(0x41000001), tx.getHash()])];
      for (let j = 0; j < siblings.length; j += 4) {
        const packed = Array.from({ length: 4 }, (_, k) => u64(siblings[j + k] ?? MAX));
        vectors.push(Buffer.concat([u32(6), ...packed]));
      }
      requested = true;
      socket.write(packet('getdata', Buffer.concat([Buffer.from([vectors.length]), ...vectors])));
    } else if (command === 'utreexotx') {
      assert(receivedVersion && requested && !completed);
      const proof = validateResponse(bytes, tx, inputs, expected, stump);
      completed = true;
      result.resolve(proof);
      close();
    } else if (command === 'notfound' && requested) throw new Error('The funded regtest proof was unavailable');
  }
  socket.on('data', chunk => {
    try {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 24) {
        assert(buffered.subarray(0, 4).equals(magic), 'Regtest magic mismatch');
        const length = buffered.readUInt32LE(16);
        assert(length <= packetLimit, 'Oversized regtest P2P message');
        if (buffered.length < 24 + length) break;
        const cmd = buffered.subarray(4, 16).toString('latin1');
        assert(/^[a-z0-9]+\x00*$/.test(cmd));
        const bytes = buffered.subarray(24, 24 + length);
        assert(buffered.subarray(20, 24).equals(dsha(bytes).subarray(0, 4)));
        buffered = buffered.subarray(24 + length);
        message(cmd.replace(/\x00+$/, ''), bytes);
      }
    } catch (error) { close(error); }
  });
  const name = Buffer.from('/ChicoryRegtestProof:1/');
  socket.once('connect', () => socket.write(packet('version', Buffer.concat([
    u32(70016), u64(0x1008n), u64(Math.floor(Date.now() / 1000)), Buffer.alloc(52), randomBytes(8),
    Buffer.from([name.length]), name, u32(tipHeight), Buffer.from([1])
  ]))));
  await handshake.promise;
  return { result: result.promise, close: () => close(new Error('Regtest proof listener stopped')) };
}

async function regtest(rpc) {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  assert.equal(await rpc('getblockhash', [0]), REGTEST_GENESIS);
}

export async function qualifyPendingRelay({ peerPort, proof, watchScript, atPending }) {
  await regtest(proof);
  const tipHeight = await proof('getblockcount'), tipHash = await proof('getbestblockhash');
  assert.equal(tipHeight, 104, 'Requires the frozen regtest fixture at height 104');
  assert.deepEqual(await proof('getrawmempool'), []);
  assert.match(watchScript, /^(0014[0-9a-f]{40}|0020[0-9a-f]{64})$/);
  const destination = Buffer.from(watchScript, 'hex');
  const inputs = [];
  for (const height of [3, 4]) {
    const blockHash = await proof('getblockhash', [height]);
    const raw = await proof('getblock', [blockHash, 0]);
    assert(typeof raw === 'string' && raw.length <= packetLimit * 2);
    const block = Block.fromHex(raw);
    const coin = block.transactions[0];
    assert.equal(block.getId(), blockHash);
    assert(coin.isCoinbase() && coin.outs[0].script.equals(miner.output));
    inputs.push({ height, blockHash, txid: coin.getId(), vout: 0, value: coin.outs[0].value });
  }
  const stump = await proof('getutreexoroots', [tipHash]);
  const rawProof = await proof('proveutxochaintipinclusion', [inputs.map(i => i.txid), inputs.map(i => i.vout), 0]);
  assert.match(rawProof, /^(?:[0-9a-f]{2}){1,4096}$/);
  const reader = cursor(Buffer.from(rawProof, 'hex'));
  assert.deepEqual(reader.take(32), fromId(tipHash));
  const expected = readProof(reader);
  assert.equal(reader.take(4).readUInt32LE(), 2);
  expected.leaves = [reader.take(32), reader.take(32)];
  reader.end();

  function spend(amount, fee) {
    const tx = new Transaction();
    for (const input of inputs) tx.addInput(fromId(input.txid), input.vout, 0xfffffffd, script.compile([miner.redeem.output]));
    tx.addOutput(miner.output, inputs.reduce((total, input) => total + input.value, 0) - amount - fee);
    tx.addOutput(destination, amount);
    return tx;
  }
  const original = spend(29000, 1800), replacement = spend(25000, 6500);
  const stages = [];
  async function check(stage, tx, priorTxid, wire) {
    const fee = inputs.reduce((total, i) => total + i.value, 0) - tx.outs.reduce((total, o) => total + o.value, 0);
    const expected = { stage, tipHeight, tipHash, txid: tx.getId(), previousTxid: priorTxid ?? null,
      fee, hex: tx.toHex(), inputs, inputScript: miner.output.toString('hex'), change: tx.outs[0].value,
      scriptHex: watchScript, vout: 1, value: tx.outs[1].value };
    assert.deepEqual(await proof('getrawmempool'), [tx.getId()]);
    assert.equal(await proof('getbestblockhash'), tipHash);
    stages.push({ stage, txid: tx.getId(), fee, wire, candidate: atPending ? await atPending(expected) : null });
  }
  for (const [stage, tx, priorTxid] of [['original', original], ['replacement', replacement, original.getId()]]) {
    const peer = await listenForOffer({ peerPort, tipHeight, tx, inputs, expected, stump });
    try {
      await regtest(proof);
      assert.equal(await proof('sendrawtransaction', [tx.toHex()]), tx.getId());
      await check(stage, tx, priorTxid, await peer.result);
    } finally { peer.close(); }
  }
  await regtest(proof);
  await assert.rejects(proof('sendrawtransaction', [original.toHex()]), /fee|replacement|conflict|double.spend/i);
  await check('rejected lower-fee conflict', replacement, original.getId(), null);
  return { scope: 'disposable regtest', tipHeight, tipHash, leafCount: stump.numleaves, stages };
}

async function until(label, read, matches, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await delay(250);
  }
  throw new Error('Timed out waiting for ' + label);
}

const scriptHash = hex => hash('sha256', Buffer.from(hex, 'hex')).reverse().toString('hex');
async function qualifyNonzeroParent({ node, proof, owner, watchScript }) {
  await regtest(proof);
  const tipHash = await proof('getbestblockhash');
  assert.equal(await proof('getblockcount'), 105);
  assert.deepEqual(await proof('getrawmempool'), []);
  const inputs = [];
  for (const [height, position, vout] of [[102, 1, 1], [5, 0, 0]]) {
    const blockHash = await proof('getblockhash', [height]);
    const block = Block.fromHex(await proof('getblock', [blockHash, 0]));
    assert.equal(block.getId(), blockHash);
    const parent = block.transactions[position];
    assert.equal(parent.isCoinbase(), position === 0);
    assert(parent.outs[vout].script.equals(miner.output));
    const result = await node.confirmedTransaction(owner, parent.getId());
    assert.equal(result?.hex, parent.toHex());
    assert.equal(result.blockHash, blockHash);
    inputs.push({ txid: parent.getId(), vout, value: parent.outs[vout].value });
  }

  const tx = new Transaction();
  for (const input of inputs) tx.addInput(fromId(input.txid), input.vout, 0xfffffffd, script.compile([miner.redeem.output]));
  const amount = 51000, fee = 2500;
  const change = inputs.reduce((sum, input) => sum + input.value, 0) - amount - fee;
  tx.addOutput(miner.output, change);
  tx.addOutput(Buffer.from(watchScript, 'hex'), amount);
  const txid = tx.getId();
  const controller = new AbortController();
  let session = node.openPendingWallet(owner, controller.signal);
  const queries = [scriptHash(watchScript), scriptHash(miner.output.toString('hex'))];
  async function observe(stage) {
    const [incoming, outgoing] = await until(stage, () => Promise.all(queries.map(query => session.observations(query))),
      pair => pair.every(view => view?.tipHash === tipHash && view.rows.some(row => row.txid === txid)) &&
        pair[0].revision === pair[1].revision);
    const base = { txid, fee, height: 0 };
    assert.deepEqual(incoming.rows, [{ ...base, spent: [], created: [{ vout: 1, value: amount }] }]);
    assert.deepEqual(outgoing.rows, [{ ...base, spent: inputs, created: [{ vout: 0, value: change }] }]);
    assert.equal(incoming.coverageComplete, false);
    assert.equal(outgoing.coverageComplete, false);
    assert.equal(await proof('getrawtransaction', [txid, 0]), tx.toHex());
    return { revision: incoming.revision, incoming: incoming.rows[0], outgoing: outgoing.rows[0] };
  }
  try {
    await regtest(proof);
    assert.equal(await proof('sendrawtransaction', [tx.toHex()]), txid);
    const announced = await observe('nonzero input funding announcement');
    await node.stop();
    await assert.rejects(session.observations(queries[0]), /closed/i);
    assert.deepEqual(await proof('getrawmempool'), [txid]);
    await node.start();
    await until('reopened historical validation', () => node.status(),
      info => info.historicalVerification === 'verified' && info.tipHash === tipHash && info.tipSynced);
    await until('reopened owner coverage', () => node.watchCoverage(owner),
      info => info.phase === 'caught-up' && info.hash === tipHash);
    session = node.openPendingWallet(owner, controller.signal);
    const reopened = await observe('nonzero input funding after reconnect');
    await regtest(proof);
    const [confirmedHash] = await proof('generate', [1]);
    await until('nonzero input confirmation', () => node.watchCoverage(owner),
      info => info.phase === 'caught-up' && info.height === 106 && info.hash === confirmedHash);
    const confirmed = await node.confirmedTransaction(owner, txid);
    assert.equal(confirmed?.hex, tx.toHex());
    assert.equal(confirmed.blockHash, confirmedHash);
    assert.deepEqual(await proof('getrawmempool'), []);
    await until('confirmed nonzero funding leaves the pending view', () => session.observations(queries[0]),
      view => view?.tipHash === confirmedHash && view.rows.length === 0);
    return { txid, inputs, announced, reopened, confirmed: { height: 106, blockHash: confirmedHash } };
  } finally { controller.abort(); session.close(); }
}

export async function qualifyManagedPending({ node, proof, peerPort, watchScript, atPending, atConfirmed, extendedInputs = false }) {
  await regtest(proof);
  const tipHash = await proof('getbestblockhash');
  const owner = hash('sha256', 'pending two-input regtest fixture').toString('hex');
  const inputScript = miner.output.toString('hex');
  assert(node.supportsPending(), 'The candidate must negotiate its pending protocol');
  await node.registerWatches({ owner, scripts: [watchScript, inputScript], outpoints: [] });
  await until('disposable pending owner confirmed coverage', () => node.watchCoverage(owner),
    value => value.phase === 'caught-up' && value.height === 104 && value.hash === tipHash);
  const controller = new AbortController();
  let session = node.openPendingWallet(owner, controller.signal);
  let cold;
  try {
    const report = await qualifyPendingRelay({ peerPort, proof, watchScript, atPending: async expected => {
      const [incoming, outgoing] = await until('the watched two-input funding observation', () => Promise.all([
        session.observations(scriptHash(watchScript)), session.observations(scriptHash(inputScript))
      ]), pair => pair.every(view => view?.rows.some(row => row.txid === expected.txid)) &&
        pair[0].revision === pair[1].revision);
      const fields = { txid: expected.txid, fee: expected.fee, height: 0 };
      const expectedIn = { ...fields, spent: [], created: [{ vout: expected.vout, value: expected.value }] };
      const expectedOut = { ...fields, spent: expected.inputs.map(({ txid, vout, value }) => ({ txid, vout, value })),
        created: [{ vout: 0, value: expected.change }] };
      for (const [view, row] of [[incoming, expectedIn], [outgoing, expectedOut]]) {
        assert.equal(view.scope, 'observed-pending');
        assert.equal(view.coverageComplete, false);
        assert.equal(view.tipHash, expected.tipHash);
        assert.equal(view.tipHeight, expected.tipHeight);
        // The private qualifier checks an exact locally observed set. It makes
        // no claim that every unconfirmed transaction on the network is known.
        assert.deepEqual(view.rows, [row]);
      }
      const hook = await atPending?.({ node, owner, expected, scriptHash: scriptHash(watchScript) });
      if (expected.stage === 'original') {
        // A fresh process has no memory of the announcement. The independent
        // peer keeps this exact transaction pending on the frozen tip.
        await node.stop();
        await assert.rejects(session.observations(scriptHash(watchScript)), /closed/i);
        assert.deepEqual(await proof('getrawmempool'), [expected.txid]);
        assert.equal(await proof('getbestblockhash'), expected.tipHash);
        await node.start();
        await until('historical verification after cold reconnect', () => node.status(),
          v => v.historicalVerification === 'verified' && v.tipSynced && v.tipHash === expected.tipHash);
        const coverage = await node.watchCoverage(owner);
        assert.equal(coverage.phase, 'caught-up');
        assert.equal(coverage.hash, expected.tipHash);
        session = node.openPendingWallet(owner, controller.signal);
        const [replayedIn, replayedOut] = await until('a positive pending observation on the new peer connection',
          () => Promise.all([session.observations(scriptHash(watchScript)), session.observations(scriptHash(inputScript))]),
          pair => pair.every(v => v?.tipHash === expected.tipHash && v.rows.some(row => row.txid === expected.txid)) &&
            pair[0].revision === pair[1].revision);
        assert.deepEqual(replayedIn.rows, [expectedIn]);
        assert.deepEqual(replayedOut.rows, [expectedOut]);
        assert.equal(replayedIn.coverageComplete, false);
        assert.equal(replayedOut.coverageComplete, false);
        const coldHook = await atPending?.({ node, owner, expected: { ...expected, stage: 'cold reconnect' }, scriptHash: scriptHash(watchScript) });
        cold = { ...(coldHook === undefined ? {} : { bridge: coldHook }), tipHeight: replayedIn.tipHeight, tipHash: replayedIn.tipHash, txid: expected.txid,
          revision: replayedIn.revision, incomingOutputs: replayedIn.rows[0].created.length,
          outgoingInputs: replayedOut.rows[0].spent.length, coverageComplete: false, oldSessionRevoked: true };
      }
      return { ...(hook === undefined ? {} : { bridge: hook }), incoming: incoming.rows[0], outgoing: outgoing.rows[0], revision: incoming.revision, coverageComplete: false };
    } });
    assert.equal(await session.observations(scriptHash('0014' + 'ba'.repeat(20))), null,
      'The pending owner must not see queries for an unregistered script');
    await regtest(proof);
    const [confirmedHash] = await proof('generate', [1]);
    const txid = report.stages.at(-1).txid;
    const raw = await proof('getblock', [confirmedHash, 0]);
    assert(typeof raw === 'string' && raw.length <= packetLimit * 2);
    const block = Block.fromHex(raw);
    assert.equal(block.getId(), confirmedHash);
    assert(block.transactions.some(tx => tx.getId() === txid));
    assert.deepEqual(await proof('getrawmempool'), []);
    await until('managed coverage at the confirming block', () => node.watchCoverage(owner),
      v => v.height === 105 && v.hash === confirmedHash && v.phase === 'caught-up');
    const after = await until('retirement of the confirmed observation', () => session.observations(scriptHash(watchScript)),
      v => v?.tipHeight === 105 && v.tipHash === confirmedHash && v.coverageComplete === false && v.rows.length === 0);
    const confirmedHook = await atConfirmed?.({ node, owner, txid, height: after.tipHeight, tipHash: after.tipHash });
    controller.abort();
    await assert.rejects(session.observations(scriptHash(watchScript)), /closed/i);
    const nonzeroParent = extendedInputs ? await qualifyNonzeroParent({ node, proof, owner, watchScript }) : undefined;
    return { ...report, cold, nonzeroParent, confirmed: { ...(confirmedHook === undefined ? {} : { bridge: confirmedHook }), height: after.tipHeight, tipHash: after.tipHash, txid, localPendingRows: after.rows.length },
      scopeChecks: { unregisteredScriptUnavailable: true, sessionRevoked: true } };
  } finally { controller.abort(); session.close(); }
}

async function reservePorts() {
  const sockets = [];
  try {
    for (let i = 0; i < 2; i++) {
      const socket = net.createServer();
      sockets.push(socket);
      socket.listen(0, '127.0.0.1');
      await once(socket, 'listening');
    }
    return sockets.map(socket => socket.address().port);
  } finally { await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve)))); }
}

// Callers receive only the owned loopback peer and authenticated RPC. Each
// method runs in a fresh profile whose genesis and starting height were checked.
export async function withProofPeer(utreexod, run) {
  assert(path.isAbsolute(utreexod), 'Supply --utreexod with an absolute local executable path');
  const root = assertDisposableProfile(await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-qualify-proof-')));
  const [peerPort, rpcPort] = await reservePorts();
  const password = randomBytes(32).toString('hex');
  const env = { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TMPDIR: root, TMP: root, TEMP: root };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const config = path.join(root, 'peer.conf');
  let peer, stopped;
  const proof = async (method, params = []) => {
    const reply = await fetch('http://127.0.0.1:' + rpcPort + '/', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Basic ' + Buffer.from('fixture:' + password).toString('base64'), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000), body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
    let size = 0;
    const chunks = [];
    for await (const chunk of reply.body) {
      size += chunk.byteLength;
      assert(size <= 256 * 1024, 'Oversized regtest RPC reply');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks));
    if (!reply.ok || value.error) throw new Error(method + ': ' + (value.error?.message ?? reply.status));
    return value.result;
  };
  try {
    assert.equal(execFileSync(utreexod, ['--version'], { env, cwd: root, encoding: 'utf8', timeout: 5000 }).trim(), 'utreexod version 0.6.0');
    await fs.writeFile(config, 'rpcuser=fixture\nrpcpass=' + password + '\n', { mode: 0o600, flag: 'wx' });
    const peerEndpoint = '127.0.0.1:' + peerPort;
    peer = spawn(utreexod, ['--regtest', '--nodnsseed', '--noonion', '--nobdkwallet', '--notls', '--cfilters',
      '--v2transport', '--trickleinterval=100ms', '--utreexoproofindex', '--prune=0', '--miningaddr=' + miner.address,
      '--listen=' + peerEndpoint, '--connect=' + peerEndpoint, '--rpclisten=127.0.0.1:' + rpcPort,
      '--configfile=' + config, '--datadir=' + path.join(root, 'peer'), '--logdir=' + root], { env, cwd: root, stdio: 'ignore' });
    stopped = new Promise(resolve => { peer.on('error', resolve); peer.once('close', resolve); });
    await until('the disposable regtest peer', () => proof('getblockcount').catch(() => null), v => v === 0, 20000);
    await regtest(proof);
    return await run({ root, proof, peerPort, peerEndpoint });
  } finally {
    if (peer) {
      peer.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
      const timer = setTimeout(() => peer.kill('SIGKILL'), 5000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function standalone({ utreexod, digest, walletSend, lightningChannel }) {
  return withProofPeer(utreexod, async ({ root, proof, peerPort, peerEndpoint }) => {
    // The pinned full peer activates SegWit after three 144-block windows.
    const fundedWallets = walletSend || lightningChannel;
    const initialHeight = fundedWallets ? 432 : 104;
    assert.equal((await proof('generate', [initialHeight])).length, initialHeight);
    if (fundedWallets) assert.equal((await proof('getblockchaininfo')).bip9_softforks.segwit.status, 'active');
    const watchScript = '0014' + '33'.repeat(20);
    if (digest) {
      const { default: { candidate } } = await import('../../desktop/floresta-settings.cjs');
      const { default: { ManagedFloresta } } = await import('../../desktop/floresta.cjs');
      const build = candidate(fileURLToPath(new URL('../../', import.meta.url)), digest);
      const node = new ManagedFloresta({ ...build, network: 'regtest', profileDirectory: root,
        spawnProcess: (file, args, opts) => spawn(file, [...args, '--connect', peerEndpoint], opts) });
      try {
        await node.start();
        const tip = await proof('getbestblockhash');
        await until('the candidate to validate the frozen tip', () => node.status(), state => state.tipHash === tip && state.tipSynced,
          fundedWallets ? 240000 : 90000);
        if (lightningChannel) {
          const { qualifyManagedChannel } = await import('./floresta-channel-lab.mjs');
          return await qualifyManagedChannel({ node, proof });
        }
        if (walletSend) {
          const { qualifyWalletSend } = await import('./floresta-wallet-send-lab.mjs');
          const wallet = await qualifyWalletSend({ node, proof });
          const lightningBackend = await qualifyWalletSend({ node, proof, sender: 'lightning' });
          return { ...wallet, lightningBackend };
        }
        return await qualifyManagedPending({ node, proof, peerPort, watchScript });
      } finally { await node.stop(); }
    }
    return await qualifyPendingRelay({ proof, peerPort, watchScript });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { utreexod: { type: 'string' }, digest: { type: 'string' }, 'wallet-send': { type: 'boolean' }, 'lightning-channel': { type: 'boolean' } } });
  if (values['wallet-send'] && values['lightning-channel']) throw new Error('Select one fresh funded wallet fixture per run.');
  if ((values['wallet-send'] || values['lightning-channel']) && !values.digest) throw new Error('A wallet send requires the managed regtest candidate.');
  console.log(JSON.stringify(await standalone({ ...values, walletSend: values['wallet-send'], lightningChannel: values['lightning-channel'] }), null, 2));
}
