import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { grantWalletBridge } from '../../desktop/floresta-wallet-bridge.cjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Transaction } = requireServer('bitcoinjs-lib');
const executable = fileURLToPath(new URL('../../.runtime/node/' + (process.platform === 'win32' ? 'node.exe' : 'bin/node'), import.meta.url));
const fixture = fileURLToPath(new URL('./floresta-wallet-client.cjs', import.meta.url));

// Use the same private manager-fork protocol, pinned Node binary, installed
// Electrum client and PSK endpoint helper used by the desktop qualification.
export function walletBridgeFixture() {
  let lease;
  let client;
  let manager;
  let id = 0;
  const notifications = [];
  const env = { CHICORY_FLORESTA_WALLET_LAB: '1', BEIGNET_NETWORK: 'regtest', ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) };
  function spawn(args, extra = {}) {
    return fork(fixture, args, { execPath: executable, execArgv: [], env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  }
  async function close() {
    lease?.close();
    lease = null;
    for (const child of [client, manager]) {
      if (!child || child.exitCode !== null || child.signalCode) continue;
      const exited = once(child, 'exit');
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill(), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    client = manager = null;
  }
  async function request(message) {
    const requestId = ++id;
    const child = client;
    return new Promise((resolve, reject) => {
      const fail = () => finish(null, true);
      const timer = setTimeout(fail, 10000);
      function finish(value, error) {
        clearTimeout(timer);
        child.removeListener('message', receive);
        child.removeListener('exit', fail);
        if (error) reject(new Error('Authenticated fixture wallet declined the request.')); else resolve(value);
      }
      function receive(reply) { if (reply.id === requestId) finish(reply.value, reply.error); }
      child.on('message', receive);
      child.once('exit', fail);
      child.send({ ...message, id: requestId }, error => { if (error) fail(); });
    });
  }
  const read = (method, params = []) => request({ type: 'read', method, params });
  async function open(node, owner) {
    await close();
    manager = spawn(['manager']);
    lease = await grantWalletBridge({ qualification: true, manager, node, owner, signal: new AbortController().signal });
    client = spawn([], { CHICORY_ELECTRUM_POLICY: 'selected-only', BEIGNET_ELECTRUM_HOST: '127.0.0.1',
      BEIGNET_ELECTRUM_PORT: String(lease.endpoint.port), BEIGNET_ELECTRUM_TLS: 'true' });
    notifications.length = 0;
    client.on('message', message => { if (message.event === 'script-status') notifications.push(message.params); });
    assert.equal((await request({ type: 'open', psk: lease.endpoint.psk }))[1], '1.4');
    assert.equal((await read('server.features')).chicory.walletReady, false);
    assert.equal((await read('blockchain.block.header', [0])).length, 160);
  }
  return { close, async atPending({ node, owner, expected, scriptHash }) {
    if (!client || expected.stage === 'cold reconnect') await open(node, owner);
    const tx = Transaction.fromHex(expected.hex);
    const raw = await read('blockchain.transaction.get', [expected.txid, false]);
    assert.equal(raw, expected.hex);
    const decoded = await read('blockchain.transaction.get', [expected.txid, true]);
    assert.equal(decoded.txid, tx.getId());
    const witnessId = createHash('sha256').update(createHash('sha256').update(Buffer.from(raw, 'hex')).digest()).digest().reverse().toString('hex');
    assert.equal(decoded.hash, witnessId);
    assert.equal(decoded.confirmations, 0);
    assert.equal(Math.round(decoded.vout[expected.vout].value * 1e8), expected.value);
    assert.equal(decoded.hex, raw);
    const pendingRows = await read('blockchain.scripthash.get_mempool', [scriptHash]);
    assert.deepEqual(pendingRows, [{ tx_hash: expected.txid, height: 0, fee: expected.fee }]);
    assert.equal((await read('blockchain.scripthash.get_balance', [scriptHash])).unconfirmed, expected.value);
    const history = await read('blockchain.scripthash.get_history', [scriptHash]);
    const status = createHash('sha256').update(history.map(row => `${row.tx_hash}:${row.height}:`).join('')).digest('hex');
    if (expected.stage === 'replacement') {
      const until = Date.now() + 8000;
      while (!notifications.some(([hash, value]) => hash === scriptHash && value === status) && Date.now() < until) await delay(100);
      assert.ok(notifications.some(([hash, value]) => hash === scriptHash && value === status), 'Missing authenticated RBF subscription notification.');
    }
    assert.equal(await read('blockchain.scripthash.subscribe', [scriptHash]), status);
    if (expected.previousTxid && expected.previousTxid !== expected.txid) {
      await assert.rejects(read('blockchain.transaction.get', [expected.previousTxid, false]));
    }
    await assert.rejects(read('blockchain.transaction.get_merkle', [expected.txid, 0]));
    return { txid: expected.txid, wtxid: witnessId, bytes: raw.length / 2, observedCredit: expected.value,
      confirmations: 0, replacementNotified: expected.stage === 'replacement', oldTxidUnavailable: expected.previousTxid && expected.previousTxid !== expected.txid ? expected.previousTxid : null };
  }, async atConfirmed({ node, owner, txid, height }) {
    await open(node, owner);
    const decoded = await read('blockchain.transaction.get', [txid, true]);
    assert.equal(decoded.txid, txid);
    assert.equal(decoded.confirmations, 1);
    const merkle = await read('blockchain.transaction.get_merkle', [txid, height]);
    assert.equal(merkle.block_height, height);
    assert.equal(merkle.pos, 1);
    return { txid, height, confirmations: 1, position: merkle.pos };
  } };
}
