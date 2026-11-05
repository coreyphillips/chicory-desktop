'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');

const runtime = path.resolve(__dirname, '../.runtime');
const engine = path.join(runtime, 'engine/node_modules/beignet');
const pinnedNode = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const available = fs.existsSync(path.join(engine, 'package.json'));
const pinned = createRequire(path.join(engine, 'package.json'));
const dist = file => pinned(path.join(engine, 'dist', file));
const hash = n => Buffer.alloc(32, n).toString('hex');
const script = n => Buffer.concat([Buffer.from([0, 20]), Buffer.alloc(20, n)]);
const temporary = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-engine-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function walletFixture(t, requireWatchAck) {
  const module = path.join(engine, 'dist/chicory-watch-control.cjs');
  delete require.cache[module];
  const control = require(module);
  const { Wallet, generateMnemonic } = pinned('beignet');
  const { BeignetNode } = dist('cli/beignet-node.js');
  const { LightningNode } = dist('lightning/node/lightning-node.js');
  const mnemonic = generateMnemonic();
  const daemon = new BeignetNode(mnemonic, 'regtest');
  daemon.wallet = new Wallet({ mnemonic, network: 'regtest', remainOffline: true });
  daemon.node = Object.create(LightningNode.prototype);
  control.enable({ requireWatchAck });
  control.attach(daemon);
  t.after(() => { delete require.cache[module]; });
  return { control, daemon, mnemonic };
}

test('private snapshot reflects persisted wallet ranges and respects recovery ownership', { skip: !available || process.versions.modules !== '137' }, async t => {
  const { control, daemon, mnemonic } = walletFixture(t, false);
  const { Wallet } = pinned('beignet');
  const { SqliteStorage } = dist('lightning/storage/sqlite-storage.js');
  const { createWalletStorage } = dist('cli/wallet-storage.js');
  const database = path.join(temporary(t), 'regtest.db');
  const old = process.env.CHICORY_DATABASE_KEY;
  const key = randomBytes(32).toString('hex');
  process.env.CHICORY_DATABASE_KEY = key;
  t.after(() => {
    if (old === undefined) delete process.env.CHICORY_DATABASE_KEY;
    else process.env.CHICORY_DATABASE_KEY = old;
  });
  const store = new SqliteStorage(database);
  store.open();
  t.after(() => store.close());
  const load = async () => {
    const result = await Wallet.create({ mnemonic, network: 'regtest', storage: createWalletStorage(store),
      remainOffline: true, disableRefreshOnCreate: true });
    assert.equal(result.isOk(), true);
    return result.value;
  };
  const first = await load();
  const indices = { ...first.data.addressIndex, p2wpkh: { ...first.data.addressIndex.p2wpkh, index: 105 } };
  assert.equal((await first.updateData({ addressIndex: indices })).isOk(), true);
  await first.stop();
  daemon.wallet = await load();
  t.after(() => daemon.wallet.stop());
  const result = control.snapshot();
  assert.equal(result.status, 'observed');
  assert.equal(result.network, 'regtest');
  assert.equal(result.fromHeight, 0);
  assert.equal(result.coverageComplete, false);
  assert.ok(result.descriptors.some(({ descriptor, range }) => descriptor.startsWith('wpkh(') &&
    descriptor.includes('/0/*') && range[0] === 0 && range[1] >= 105 + daemon.wallet.gapLimitOptions.lookAhead));
  for (const secret of [mnemonic, key]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(fs.readFileSync(database).includes(Buffer.from('SQLite format 3')), false);
  assert.equal(control.acknowledge(result.generation).accepted, true);
  daemon.node._barrierFenced = true;
  assert.deepEqual(control.snapshot(), { status: 'recovery-pending', coverageComplete: false });
  assert.equal(control.acknowledge(result.generation).accepted, false);
});

test('pinned Lightning watcher exports funding candidates, pre-splice legs, claim outputs and unresolved parents', { skip: !available }, async t => {
  const { control } = walletFixture(t, false);
  const { ChainWatcher } = dist('lightning/chain/chain-watcher.js');
  const { Transaction } = pinned('bitcoinjs-lib');
  const tx = new Transaction();
  tx.addInput(Buffer.alloc(32, 7), 0);
  tx.addOutput(script(3), 1200);
  const watch = new ChainWatcher({ channelManager: new EventEmitter(), backend: {
    subscribeToScriptHash: async () => { throw new Error('disconnected'); },
    getScriptHashHistory: async () => [], getTransaction: async () => tx.toBuffer(),
  }, destinationScript: script(8) });
  const id = Buffer.alloc(32, 4);
  await watch.watchFundingOutput(id, hash(1), 2, 3, script(1), undefined, [{ txid: hash(2), outputIndex: 1 }], [[hash(11) + ':0']]);
  await watch.watchFundingSpendDuringSplice(id, hash(3), 3, script(2), hash(4));
  watch.watchSpliceInput(id, hash(3), { txid: hash(6), vout: 1, inputIndex: 0 });
  await watch.watchOutputByTxid(tx.getId(), 0);
  await assert.rejects(watch.watchOutputByTxid(hash(9), 0), /identity mismatch/);
  const result = control.snapshot();
  assert.equal(result.status, 'observed');
  for (const expected of [1, 2, 3, 8]) assert.ok(result.scripts.includes(script(expected).toString('hex')));
  for (const [txid, vout] of [[hash(1), 2], [hash(2), 1], [hash(3), 3], [tx.getId(), 0]]) {
    assert.ok(result.outpoints.some(point => point.outpoint === txid + ':' + vout && point.scriptHash));
  }
  for (const [txid, vout] of [[hash(6), 1], [hash(9), 0], [hash(11), 0]]) {
    assert.ok(result.outpoints.some(point => point.outpoint === txid + ':' + vout && point.scriptHash === null));
  }
  assert.equal(control.acknowledge(result.generation).accepted, false);
});

test('acknowledgement gates exact Lightning reads, gossip and receive issuance', { skip: !available }, async t => {
  const { control, daemon } = walletFixture(t, true);
  const { computeScriptHash, classifyAnnouncedChannelFunding } = dist('lightning/chain/chain-watcher.js');
  const { ElectrumBackend } = dist('lightning/chain/electrum-backend.js');
  let rows = [{ result: [] }];
  let reads = 0;
  const backend = new ElectrumBackend({ connectedToElectrum: true,
    getAddressScriptHashesHistory: async () => { reads++; return { isErr: () => false, value: { data: rows } }; },
    listUnspentAddressScriptHashes: async () => ({ isErr: () => false, value: { utxos: [] } }),
  });
  const before = control.snapshot();
  const scriptHash = computeScriptHash(script(5));
  await assert.rejects(backend.getScriptHashHistory(scriptHash), /coverage is pending/);
  assert.equal(reads, 0);
  assert.equal(control.acknowledge(before.generation).accepted, false);
  assert.equal(control.acknowledge(control.snapshot().generation).accepted, true);
  assert.deepEqual(await backend.getScriptHashHistory(scriptHash), []);
  rows = [{ error: { code: -1 } }];
  await assert.rejects(backend.getScriptHashHistory(scriptHash), /Incomplete Electrum history/);
  const { createECDH } = require('node:crypto');
  const key = byte => { const k = createECDH('secp256k1'); k.setPrivateKey(Buffer.alloc(32, byte)); return k.getPublicKey(null, 'compressed'); };
  const announcement = { bitcoinKey1: key(1), bitcoinKey2: key(2), shortChannelId: Buffer.from('0000010000010000', 'hex') };
  assert.equal(await classifyAnnouncedChannelFunding(backend, announcement, 1000), 'unavailable');
  const newView = control.snapshot();
  assert.equal(control.acknowledge(newView.generation).accepted, true);
  assert.equal(await classifyAnnouncedChannelFunding(backend, announcement, 1000), 'refuted');
  const wallet = daemon.wallet;
  const type = wallet.addressType;
  const address = await wallet.getAddress({ index: '1', addressType: type });
  const next = { ...wallet.data.addressIndex[type], index: 1, address };
  await assert.rejects(wallet.issueReceiveAddress(type, next), /coverage is pending/);
  assert.equal(wallet.data.addressIndex[type].index, -1);
  assert.equal(control.acknowledge(control.snapshot().generation).accepted, true);
  assert.equal((await wallet.issueReceiveAddress(type, next)).isOk(), true);
  control.invalidate();
  assert.equal(control.acknowledge(newView.generation).accepted, false);
  await assert.rejects(backend.getScriptHashHistory(scriptHash), /coverage is pending/);
});

test('private startup fence wins atomically before storage initialization', { skip: !available, timeout: 10000 }, async t => {
  const child = fork(path.join(__dirname, 'engine-bootstrap.js'), [path.join(engine, 'dist/cli/cli.js'), 'init', '--network', 'regtest'],
    { execPath: pinnedNode, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { HOME: temporary(t), PATH: process.env.PATH } });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.connected) child.disconnect(); await exit; });
  async function request(id, action) {
    const message = once(child, 'message');
    child.send({ type: 'chicory-chain-control/v1', id, action });
    const [reply] = await message;
    assert.equal(reply.type, 'chicory-chain-reply/v1');
    assert.equal(reply.id, id);
    return reply.result;
  }
  assert.deepEqual(await request(1, 'fence-before-init'), { status: 'fenced-before-init', fenced: true });
  child.send({ type: 'initialize-storage', filesKey: 'invalid', chainWatch: true });
  assert.deepEqual(await request(2, 'fence-before-init'), { status: 'fenced-before-init', fenced: true });
  assert.deepEqual(await request(3, 'watch-snapshot'), { status: 'disabled', coverageComplete: false });
});

test('a running encrypted CLI exports sanitized watches through the manager without a wallet restart', { skip: !available, timeout: 25000 }, async t => {
  const net = require('node:net');
  const { createInterface } = require('node:readline');
  const { setTimeout: delay } = require('node:timers/promises');
  const { FlorestaCollection } = require('./floresta-collection');
  const { generateMnemonic } = pinned('beignet');
  const root = temporary(t);
  const sockets = new Set();
  const gen = '01000000' + '00'.repeat(32) + '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' +
    'dae5494dffff7f2002000000';
  const electrum = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    createInterface({ input: socket }).on('line', line => {
      const replies = { 'server.version': ['watch-fixture', '1.4'], 'server.ping': null,
        'blockchain.headers.subscribe': { height: 0, hex: gen }, 'blockchain.block.header': gen,
        'blockchain.scripthash.get_balance': { confirmed: 0, unconfirmed: 0 }, 'blockchain.scripthash.subscribe': null,
        'blockchain.scripthash.get_history': [], 'blockchain.scripthash.listunspent': [] };
      const respond = ({ id, method }) => Object.hasOwn(replies, method) ? { id, result: replies[method] } :
        { id, error: { code: -32601, message: 'Unknown method' } };
      const request = JSON.parse(line);
      socket.write(JSON.stringify(Array.isArray(request) ? request.map(respond) : respond(request)) + '\n');
    });
  });
  const listen = server => new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  await listen(electrum);
  const reserved = net.createServer();
  await listen(reserved);
  const apiPort = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const child = fork(path.join(__dirname, 'engine-bootstrap.js'), [path.join(engine, 'dist/cli/cli.js'), 'start', '--no-auto-reconnect'],
    { execPath: pinnedNode, execArgv: [], cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: root, USERPROFILE: root, NODE_ENV: 'test', BEIGNET_NETWORK: 'regtest', BEIGNET_ELECTRUM_HOST: '127.0.0.1',
        BEIGNET_ELECTRUM_PORT: String(electrum.address().port), BEIGNET_ELECTRUM_TLS: 'false', BEIGNET_FEE_SOURCE: 'electrum',
        CHICORY_ELECTRUM_POLICY: 'selected-only', BEIGNET_DAEMON_PORT: String(apiPort), BEIGNET_DAEMON_HOST: '127.0.0.1',
        BEIGNET_DATA_DIR: path.join(root, 'data'), BEIGNET_RECOVERY_MODE: 'off', BEIGNET_AUTO_BOOTSTRAP: 'false',
        BEIGNET_IROH: 'false', BEIGNET_AUTO_RECONNECT: 'false', BEIGNET_LISTEN_PORT: '0' } });
  const exit = once(child, 'exit');
  t.after(async () => {
    if (child.connected) child.disconnect();
    for (const socket of sockets) socket.destroy();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exit;
    clearTimeout(timer);
    await new Promise(resolve => electrum.close(resolve));
  });
  const secrets = { mnemonic: generateMnemonic(), apiToken: randomBytes(32).toString('hex'),
    filesKey: randomBytes(32).toString('hex'), databaseKey: randomBytes(32).toString('hex') };
  child.send({ type: 'initialize-storage', filesRoot: root, ...secrets });
  const rec = { network: 'regtest', id: 'private-fixture' };
  const bridge = new FlorestaCollection({ registry: { list: () => [rec], get: () => rec }, runtime: new Map([[rec.id, { proc: child }]]) });
  // Its normal engine startup is already admitted; a cutover must defer.
  const reply = once(child, 'message');
  child.send({ type: 'chicory-chain-control/v1', id: 100, action: 'fence-before-init' });
  assert.deepEqual((await reply)[0].result, { fenced: false, status: 'deferred-engine-started' });
  assert.deepEqual(await bridge.snapshots('regtest'), []);
  let serving = false;
  for (let i = 0; i < 200 && !serving; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + apiPort + '/health', {
        headers: { authorization: 'Bearer ' + secrets.apiToken }, signal: AbortSignal.timeout(500),
      });
      serving = res.ok;
      await res.body?.cancel();
    } catch {}
    if (!serving) await delay(50);
  }
  assert.equal(serving, true, 'The pinned daemon must be serving before observation is enabled.');
  bridge.setEnabled('regtest', true);
  let rows;
  for (let i = 0; i < 100; i++) {
    rows = await bridge.snapshots('regtest');
    if (rows[0]?.snapshot?.status === 'observed') break;
    if (child.exitCode !== null) assert.fail('Pinned wallet process exited.');
    await delay(50);
  }
  const view = rows[0]?.snapshot;
  assert.equal(view?.status, 'observed');
  assert.equal(view.descriptors.length, 8);
  assert.equal(view.coverageComplete, false);
  for (const secret of [...Object.values(secrets), rec.id]) assert.equal(JSON.stringify(rows).includes(secret), false);
  bridge.setEnabled('regtest', false);
  assert.deepEqual(await bridge.snapshots('regtest'), []);
});
