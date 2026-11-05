// Read-only qualification of an explicit loopback regtest Electrum service.
// Expected transactions and block hashes must come from the fixture producer.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import readline from 'node:readline';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { REGTEST_GENESIS, headerHash } from './guards.mjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Transaction, address, networks } = requireServer('bitcoinjs-lib');
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const reverseHex = bytes => Buffer.from(bytes).reverse().toString('hex');
const hashPattern = /^[0-9a-f]{64}$/;
const unknownTx = '00'.repeat(32);
const startupScriptHash = '77ca78f9a84b48041ad71f7cc6ff6c33460c25f0cb99f558f9813ed9e63727dd';
const usage = 'node scripts/qualification/floresta-electrum.mjs --port <regtest TCP port> [--fixture <public JSON file>]';
const subscriptionStatus = rows => sha256(rows.map(h => h.tx_hash + ':' + h.height + ':').join('')).toString('hex');
const byTxid = (a, b) => a.tx_hash.localeCompare(b.tx_hash);

function expect(value, message) {
  if (!value) throw new Error(message);
}

function equal(actual, expected, message) {
  expect(isDeepStrictEqual(actual, expected), message);
}

function decode(hex) {
  expect(typeof hex === 'string' && /^(?:[0-9a-f]{2})+$/.test(hex), 'Expected public raw transaction hex');
  const tx = Transaction.fromHex(hex);
  return { tx, txid: tx.getId(), hex };
}

// The fixture has the complete history of one watched script, parents before children.
// Derive expectations from raw bytes, including output indices and spent coins.
export function readFixture(input) {
  expect(input?.network === 'regtest', 'Fixture must declare network regtest');
  expect(typeof input.scriptPubKey === 'string' && /^(?:[0-9a-f]{2}){1,10000}$/.test(input.scriptPubKey), 'Invalid fixture scriptPubKey');
  expect(Array.isArray(input.transactions) && input.transactions.length > 0, 'Expected funded transaction history');
  const scriptHash = reverseHex(sha256(Buffer.from(input.scriptPubKey, 'hex')));
  const records = input.transactions.map(({ hex, height, blockHash, position }) => ({ ...decode(hex), height, blockHash, position }));
  const unseen = new Set(records.map(r => r.txid));
  expect(unseen.size === records.length, 'Duplicate fixture transaction');
  const coins = new Map();
  const history = [];
  const spent = new Set();
  let confirmed = 0;
  let tipOrder = 0;
  for (const [i, record] of records.entries()) {
    const { tx, txid, height, blockHash, position } = record;
    unseen.delete(txid);
    expect(Number.isSafeInteger(height) && height >= -1, 'Invalid fixture height');
    if (height > 0) {
      expect(height >= tipOrder && typeof blockHash === 'string' && hashPattern.test(blockHash) && Number.isSafeInteger(position) && position >= 0, 'Invalid confirmed block or history order');
      if (height === tipOrder) {
        const previous = records[i - 1];
        expect(position > previous.position && blockHash === previous.blockHash, 'Invalid transaction order within fixture block');
      }
    }
    tipOrder = height > 0 ? height : Infinity;
    let relevant = false;
    let delta = 0;
    for (const prev of tx.ins) {
      const prevId = reverseHex(prev.hash);
      expect(!unseen.has(prevId), 'Fixture parents must precede their children');
      const key = prevId + ':' + prev.index;
      const coin = coins.get(key);
      if (!coin) continue;
      expect(!spent.has(key), 'Conflicting spends in fixture snapshot');
      spent.add(key);
      relevant = true;
      delta -= coin.value;
    }
    tx.outs.forEach((out, index) => {
      if (out.script.toString('hex') !== input.scriptPubKey) return;
      relevant = true;
      delta += out.value;
      coins.set(txid + ':' + index, { tx_hash: txid, tx_pos: index, height: Math.max(0, height), value: out.value });
    });
    expect(relevant, 'Fixture transaction does not pay or spend the watched script');
    if (height > 0) confirmed += delta;
    history.push({ tx_hash: txid, height });
  }
  const unspent = [...coins].filter(([key]) => !spent.has(key)).map(([, coin]) => coin);
  const balance = { confirmed, unconfirmed: unspent.reduce((total, coin) => total + coin.value, 0) - confirmed };
  const parents = (input.parents || []).map(decode);
  const prevTxids = new Set(records.filter(r => !r.tx.isCoinbase()).flatMap(r => r.tx.ins.map(prev => reverseHex(prev.hash))));
  expect(parents.every(p => prevTxids.has(p.txid)), 'Expected a parent of a history transaction');
  for (const r of [...records, ...parents]) prevTxids.delete(r.txid);
  const disconnected = input.disconnected;
  if (disconnected !== undefined) {
    expect(isDeepStrictEqual(Object.keys(disconnected || {}).sort(), ['blockHash', 'height', 'txid']) &&
      [disconnected.txid, disconnected.blockHash].every(h => typeof h === 'string' && hashPattern.test(h)) &&
      Number.isSafeInteger(disconnected.height) && disconnected.height > 0 &&
      !records.some(r => r.txid === disconnected.txid) &&
      records.some(r => r.height === disconnected.height && r.blockHash !== disconnected.blockHash),
    'Expected a distinct detached transaction and a replacement block at the same height');
  }
  return { scriptHash, history, unspent, balance, records, parents, missingParents: prevTxids.size, disconnected };
}

// One connection for the entire run. Use actual JSON arrays for methods Beignet batches.
// A numeric IP and an explicit port keep every request on this one local socket.
function connect(port) {
  expect(Number.isInteger(port) && port > 0 && port <= 65535, 'Specify a valid loopback regtest TCP port');
  const socket = net.connect({ host: '127.0.0.1', port, signal: AbortSignal.timeout(60_000) });
  socket.setTimeout(5_000, () => socket.destroy(new Error('Electrum timed out')));
  socket.on('data', () => {
    if (socket.bytesRead > 8 * 1024 * 1024) socket.destroy(new Error('Electrum reply limit exceeded'));
  });
  const lines = readline.createInterface({ input: socket });
  const iter = lines[Symbol.asyncIterator]();
  let id = 0;
  async function send(method, paramsList, batch) {
    const requests = paramsList.map(params => ({ jsonrpc: '2.0', id: ++id, method, params }));
    socket.write(JSON.stringify(batch ? requests : requests[0]) + '\n');
    while (true) {
      const { done, value } = await iter.next();
      if (done) throw new Error('Electrum connection closed');
      const message = JSON.parse(value);
      if (message?.method && message.id == null) continue; // Subscription notifications are a separate gate.
      const replies = batch ? message : [message];
      expect(Array.isArray(replies) && replies.length === requests.length, 'Incomplete Electrum response to ' + method);
      return requests.map(request => {
        const reply = replies.find(entry => entry?.id === request.id);
        expect(reply && (Object.hasOwn(reply, 'result') || reply.error), 'Missing Electrum reply ID for ' + method);
        return reply;
      });
    }
  }
  return {
    request: async (method, params = []) => (await send(method, [params], false))[0],
    batch: (method, paramsList) => send(method, paramsList, true),
    close: () => { lines.close(); socket.destroy(); }
  };
}

function result(reply) {
  if (reply.error) throw new Error('Electrum RPC error ' + String(reply.error.code ?? 'unknown'));
  return reply.result;
}

function checkProof(record, proof, header) {
  expect(headerHash(header) === record.blockHash, 'Header differs from the fixture block');
  expect(proof?.pos === record.position && proof.block_height === record.height && Array.isArray(proof.merkle), 'Incorrect proof height or transaction position');
  let hash = Buffer.from(record.txid, 'hex').reverse();
  let index = record.position;
  for (const sibling of proof.merkle) {
    expect(typeof sibling === 'string' && hashPattern.test(sibling), 'Invalid Merkle branch');
    const next = Buffer.from(sibling, 'hex').reverse();
    hash = sha256(sha256(Buffer.concat(index % 2 ? [next, hash] : [hash, next])));
    index = Math.floor(index / 2);
  }
  expect(index === 0 && hash.toString('hex') === header.slice(72, 136), 'Merkle branch does not match the fixture block');
}

function checkVerbose(record, value, tipHeight) {
  const { tx, txid, hex } = record;
  expect(value?.hex === hex && value.txid === txid, 'Verbose result needs matching txid and raw hex');
  expect(value.vsize === tx.virtualSize(), 'Incorrect verbose virtual size');
  if (record.height > 0) {
    expect(tipHeight >= record.height && value.confirmations === tipHeight - record.height + 1 &&
      value.blockhash === record.blockHash, 'Incorrect verbose confirmations or confirming block');
  } else if (record.height !== undefined) expect((value.confirmations ?? 0) === 0, 'Pending transaction reports confirmations');
  const outputs = value.vout?.map(out => [out.n, typeof out.value === 'number' && Math.round(out.value * 1e8), out.scriptPubKey?.hex]);
  equal(outputs, tx.outs.map((out, n) => [n, out.value, out.script.toString('hex')]), 'Incorrect verbose outputs');
  tx.outs.forEach((out, n) => {
    let expected;
    try { expected = address.fromOutputScript(out.script, networks.regtest); } catch { return; } // e.g. OP_RETURN
    const script = value.vout[n].scriptPubKey;
    equal(script.addresses ?? [script.address], [expected], 'Incorrect verbose output address');
  });
  const inputs = value.vin?.map(prev => [prev.coinbase ?? [prev.txid, prev.vout], prev.sequence]);
  const expected = tx.ins.map(prev => [tx.isCoinbase() ? prev.script.toString('hex') : [reverseHex(prev.hash), prev.index], prev.sequence]);
  equal(inputs, expected, 'Incorrect verbose inputs');
}

export async function probe(port, fixture) {
  const rpc = connect(port);
  const rows = [];
  const blocked = (check, detail) => rows.push({ check, status: 'blocked', detail });
  async function check(name, verify, status = 'passed') {
    try {
      const detail = await verify();
      rows.push({ check: name, status, detail });
      return true;
    } catch (err) {
      rows.push({ check: name, status: 'failed', detail: err.message });
      return false;
    }
  }
  const call = async (method, params) => result(await rpc.request(method, params));
  const batch = async (method, params) => (await rpc.batch(method, params)).map(result);
  try {
    // No fixture data crosses the connection until its actual genesis is checked.
    const safe = await check('Regtest genesis and protocol', async () => {
      const version = await call('server.version', ['beignet', '1.4']);
      expect(Array.isArray(version) && typeof version[0] === 'string' && version[1] === '1.4', 'Beignet protocol 1.4 negotiation failed');
      expect(headerHash(await call('blockchain.block.header', [0])) === REGTEST_GENESIS, 'Electrum genesis differs from regtest');
      return version[0];
    });
    if (safe) {
      await check('Startup ping and batch balance query', async () => {
        equal(await call('server.ping'), null, 'Expected server.ping acknowledgement');
        const [balance] = await batch('blockchain.scripthash.get_balance', [[startupScriptHash]]);
        // rn-electrum-client tests whether the server answers this batch. The
        // wallet consumes actual balance values separately for its watched scripts.
        return { numericBalance: Number.isSafeInteger(balance?.confirmed) && Number.isSafeInteger(balance?.unconfirmed) };
      });
      let tipHeight;
      await check('Initial header subscription', async () => {
        const tip = await call('blockchain.headers.subscribe');
        expect(Number.isSafeInteger(tip?.height) && tip.height >= 0, 'Invalid subscription height');
        expect(headerHash(tip.hex) === headerHash(await call('blockchain.block.header', [tip.height])), 'Subscribed header differs from queried block');
        tipHeight = tip.height;
        return { height: tipHeight };
      });
      await check('Beignet recognizes a missing transaction', async () => {
        const [reply] = await rpc.batch('blockchain.transaction.get', [[unknownTx, true]]);
        expect(/No such mempool or blockchain transaction|Invalid tx hash/.test(reply?.error?.message), 'Unknown txid did not return a missing-transaction error recognized by Beignet');
      });
      await check('Malformed broadcast response', async () => {
        const reply = await rpc.request('blockchain.transaction.broadcast', ['00']);
        expect(Number.isInteger(reply.error?.code) && reply.error.code !== -32601, 'Expected a transaction rejection');
        return { rpcErrorCode: reply.error.code };
      }, 'observed');
      const targets = [2, 6, 24, 144];
      await check('Fee responses for Beignet targets', async () => {
        const values = [];
        for (const target of targets) {
          const value = await call('blockchain.estimatefee', [target]);
          expect(Number.isFinite(value) && (value === -1 || value > 0), 'Invalid Electrum fee value or unavailable sentinel');
          values.push(value);
        }
        return { targets, btcPerKvB: values };
      }, 'observed');
      if (fixture) await probeFixture(fixture, tipHeight, call, batch, check, blocked, rpc.request);
      else blocked('Funded history, UTXOs, transactions, subscriptions and proofs', 'Supply an independently captured public regtest fixture');
    }
    blocked('Dynamic fee estimates', 'Requires independent estimates under controlled changes in fee pressure');
    blocked('Broadcast relay, replacements, conflicts, notifications and reorgs', 'Requires a changing funded chain, a peer and reconnection evidence');
    blocked('Watch scan completion, fresh-data wallet and Lightning recovery, safe handoff', 'Requires registered watches, historical data and the running wallet engine');
    return { qualified: false, rows };
  } finally {
    rpc.close();
  }
}

async function probeFixture(f, tipHeight, call, batch, check, blocked, request) {
  if (f.disconnected) {
    await check('Detached funding proof withdrawn', async () => {
      const { txid, height, blockHash } = f.disconnected;
      const active = f.records.find(r => r.height === height);
      const current = headerHash(await call('blockchain.block.header', [height]));
      expect(current === active.blockHash && current !== blockHash, 'Electrum still follows the detached block');
      const reply = await request('blockchain.transaction.get_merkle', [txid, height]);
      expect(reply.error && !Object.hasOwn(reply, 'result'), 'Returned a proof for funding replaced on the active branch');
    });
  }
  const params = [[f.scriptHash]];
  let expectedStatus;
  const pending = f.history.filter(h => h.height <= 0).sort(byTxid);
  await check('Watched history', async () => {
    const [list] = await batch('blockchain.scripthash.get_history', params);
    const history = list.map(({ tx_hash, height }) => ({ tx_hash, height }));
    const confirmed = f.history.length - pending.length;
    equal(history.slice(0, confirmed), f.history.slice(0, confirmed),
      `Confirmed history differs from fixture (expected ${confirmed} entries, received ${history.filter(h => h.height > 0).length})`);
    equal(history.slice(confirmed).sort(byTxid), pending,
      `Pending history differs from fixture (expected ${pending.length} entries, received ${history.filter(h => h.height <= 0).length})`);
    expectedStatus = subscriptionStatus(history); // Electrum permits any order within the pending set.
  });
  if (!expectedStatus) blocked('Initial script subscription', 'Requires matching watched history');
  else await check('Initial script subscription', async () => {
    equal(await call('blockchain.scripthash.subscribe', params[0]), expectedStatus, 'Initial subscription status differs from fixture history');
  });
  await check('Watched UTXOs', async () => {
    const [list] = await batch('blockchain.scripthash.listunspent', params);
    const sort = coins => coins.map(c => [c.tx_hash, c.tx_pos, c.value, c.height])
      .sort(([a, n], [b, m]) => a.localeCompare(b) || n - m);
    const actual = sort(list);
    const expected = sort(f.unspent);
    if (!isDeepStrictEqual(actual, expected)) {
      const missing = expected.find(row => !actual.some(other => isDeepStrictEqual(other, row)));
      if (missing) {
        // Report only numeric indices for this fixture txid, never another wallet's data.
        const [txid, vout] = missing;
        const indices = list.filter(coin => coin.tx_hash === txid && Number.isSafeInteger(coin.tx_pos)).map(coin => coin.tx_pos);
        throw new Error(`Expected ${txid} vout ${vout} with ${missing[2]} sats at height ${missing[3]}. Received vouts [${indices.slice(0, 8).join(', ')}] for that txid.`);
      }
      throw new Error(`Expected ${expected.length} UTXOs, received ${actual.length}`);
    }
  });
  await check('Watched balance', async () => {
    equal(await call('blockchain.scripthash.get_balance', params[0]), f.balance, 'Balance differs from confirmed and pending fixture changes');
  });
  if (pending.length) {
    await check('Pending script transactions', async () => {
      const list = await call('blockchain.scripthash.get_mempool', params[0]);
      equal(list.map(({ tx_hash, height }) => ({ tx_hash, height })).sort(byTxid), pending, 'Mempool differs from pending fixture transactions');
    });
  } else blocked('Pending script transactions', 'Fixture has only confirmed transactions');
  if (f.missingParents) blocked('Complete historical parent coverage', f.missingParents + ' input transaction(s) missing from fixture');
  for (const [label, records] of [['watched', f.records], ['parent', f.parents]]) {
    if (!records.length) {
      blocked('Parent transactions', 'Supply independent public parent hex in the fixture');
      continue;
    }
    await check('Raw ' + label + ' transactions', async () => {
      for (const r of records) equal(await call('blockchain.transaction.get', [r.txid, false]), r.hex, 'Returned bytes differ from fixture');
    });
    await check('Verbose ' + label + ' transaction batch', async () => {
      const values = await batch('blockchain.transaction.get', records.map(r => [r.txid, true]));
      records.forEach((r, index) => checkVerbose(r, values[index], tipHeight));
    });
  }
  const confirmed = f.records.filter(record => record.height > 0);
  if (!confirmed.length) blocked('Merkle branches and block positions', 'Fixture has only pending transactions');
  else await check('Merkle branches and block positions', async () => {
    for (const r of confirmed) {
      const header = await call('blockchain.block.header', [r.height]);
      checkProof(r, await call('blockchain.transaction.get_merkle', [r.txid, r.height]), header);
    }
  });
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { port: { type: 'string' }, fixture: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log(usage);
    else {
      expect(/^\d+$/.test(values.port), usage);
      const fixture = values.fixture && readFixture(JSON.parse(fs.readFileSync(values.fixture, 'utf8')));
      const report = await probe(Number(values.port), fixture);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.rows.some(row => row.status === 'failed') ? 1 : 2;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
