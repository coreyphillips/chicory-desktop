'use strict';

const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const { mkdtemp, mkdir, readFile, rm, writeFile } = fs.promises;
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const { ManagedFloresta } = require('./floresta.cjs');
const { WatchRequests, PROTOCOL } = require('./floresta-watches.cjs');

const regtestHeader = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000';
const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function waitFor(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await delay(30); }
  throw new Error('Timed out waiting for the managed node test condition.');
}

async function fixture(t, { invalidMessage, wrongHeader, silent, watches } = {}) {
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-supervisor-'));
  const binary = path.join(profileDirectory, 'fixture.bin');
  await writeFile(binary, 'public fixture', { mode: 0o700 });
  const children = [];
  const options = {
    profileDirectory, network: 'regtest', binary, sha256: digest('public fixture'),
    spawnProcess(file, args, config) {
      assert.equal(file, binary);
      assert.deepEqual(Object.keys(config.env).sort(), ['APPDATA', 'HOME', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE',
        ...(process.platform === 'win32' ? ['SystemRoot'] : [])].sort());
      assert(config.env.HOME.startsWith(fs.realpathSync(profileDirectory) + path.sep));
      assert.deepEqual(args, ['--managed-stdio', '--data-dir', config.cwd, '--network', 'regtest', '--assume-valid', '0', '--disable-dns-seeds']);
      const js = `
        const net = require('node:net');
        const server = net.createServer(socket => socket.on('data', () => socket.end(JSON.stringify({id:1,result:${JSON.stringify(wrongHeader ? '00'.repeat(80) : regtestHeader)}})+'\\n')));
        server.listen(0, '127.0.0.1', () => {
          if (${Boolean(silent)}) return;
          console.log(JSON.stringify({ protocol:'chicory.floresta/1', network:'regtest', genesis:${JSON.stringify(invalidMessage ? '00'.repeat(32) : genesis)},
            height:0, validated:0, tip:${JSON.stringify(genesis)}, ibd:true, endpoint:'127.0.0.1:'+server.address().port,
            watchProtocol:${JSON.stringify(watches ? PROTOCOL : null)} }));
        });
        const owners = new Map();
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const req = JSON.parse(line);
          if (req.action === 'register') owners.set(req.owner, {phase:'registered',height:null,hash:null,
            requiredScripts:req.scripts.length,requiredOutpoints:req.outpoints.length,matchedTransactions:0});
          const answer = owners.has(req.owner) ? {result:owners.get(req.owner)} : {error:'unknown owner'};
          console.log(JSON.stringify({protocol:'chicory.watch/1',id:req.id,...answer}));
        });
        process.stdin.resume();
        process.stdin.on('end', () => server.close());
      `;
      const child = spawn(process.execPath, ['-e', js], config);
      children.push(child);
      return child;
    }
  };
  const node = new ManagedFloresta(options);
  t.after(async () => { await node.stop(); await rm(profileDirectory, { recursive: true, force: true }); });
  return { options, node, children };
}

test('the pinned digest is checked before opening storage or spawning any process', async t => {
  const { options, children } = await fixture(t);
  const node = new ManagedFloresta({ ...options, sha256: '0'.repeat(64) });
  await assert.rejects(node.start(), /SHA-256/);
  assert.equal(node.status().phase, 'failed');
  assert.equal(children.length, 0);
  assert.equal(fs.existsSync(path.join(options.profileDirectory, 'chicory-floresta')), false);
});

test('concurrent starts use one verified child, isolated environment and durable profile data', async t => {
  const { options, node, children } = await fixture(t);
  const [a, b] = await Promise.all([node.start(), node.start()]);
  assert.deepEqual(a, b);
  assert.equal(a.phase, 'running'); assert.equal(a.walletReady, false); assert.equal(a.tipHash, genesis);
  assert.equal(a.walletScan, 'unqualified'); assert.equal(a.historicalVerification, 'unknown');
  assert.equal(a.endpoint, undefined); assert.equal(children.length, 1);
  const file = path.join(options.profileDirectory, 'chicory-floresta', 'regtest', 'chicory-owner.json');
  const owner = await readFile(file, 'utf8');
  await node.stop();
  assert.equal(children[0].exitCode, 0); assert.equal(node.status().phase, 'stopped');
  assert.equal(await readFile(file, 'utf8'), owner);
  const second = await node.start();
  assert.equal(second.phase, 'running'); assert.equal(children.length, 2);
});

test('a second profile cannot reuse another profile’s selected network store', { skip: process.platform === 'win32' }, async t => {
  const { node, options, children } = await fixture(t);
  await node.start();
  const other = path.join(options.profileDirectory, 'other-profile');
  await mkdir(other, { mode: 0o700 });
  const different = new ManagedFloresta({ ...options, profileDirectory: other, storageDirectory: options.profileDirectory });
  await assert.rejects(different.start(), /another profile owner/);
  assert.equal(children.length, 1);
});

test('stop during startup releases the private pipe and cannot leave a late running child', async t => {
  const { node, children } = await fixture(t, { silent: true });
  const rejected = assert.rejects(node.start(), /stopped/);
  await waitFor(() => children.length === 1);
  await node.stop(); await rejected;
  assert.equal(node.status().phase, 'stopped'); assert.equal(children[0].exitCode, 0);
});

test('wrong chain on either the private pipe or the actual Electrum socket fails closed', async t => {
  for (const errors of [{ invalidMessage: true }, { wrongHeader: true }]) {
    const { node, children } = await fixture(t, errors);
    await assert.rejects(node.start(), /verify|network|identity/);
    assert.equal(node.status().phase, 'failed'); assert.equal(node.status().walletReady, false);
    assert.equal(children[0].exitCode, 0);
  }
});

test('a running child crash retries twice and then requires explicit action', async t => {
  const { node, children } = await fixture(t);
  await node.start();
  for (let i = 0; i < 3; i++) {
    await waitFor(() => children.length === i + 1 && node.status().phase === 'running');
    children[i].kill('SIGKILL');
  }
  await waitFor(() => node.status().phase === 'failed');
  assert.equal(children.length, 3); assert.equal(node.status().height, null);
});

test('registration and coverage require the negotiated owner pipe and validate public input', async t => {
  const owner = 'a1'.repeat(32);
  const input = { owner, scripts: ['51'], outpoints: [owner + ':2'] };
  const { node } = await fixture(t, { watches: true });
  await assert.rejects(node.registerWatches(input), /Start/);
  await node.start();
  await assert.rejects(node.watchCoverage(owner), /refused/);
  await assert.rejects(node.registerWatches({ ...input, unrelatedSecret: 'fixture' }), /Invalid/);
  await assert.rejects(node.registerWatches({ ...input, outpoints: [owner + ':4294967296'] }), /Invalid/);
  await assert.rejects(node.registerWatches({ ...input, scripts: Array(5).fill('ab'.repeat(9999)) }), /smaller requests/);
  const receipt = await node.registerWatches(input);
  assert.deepEqual(receipt, { phase: 'registered', height: null, hash: null, requiredScripts: 1, requiredOutpoints: 1, matchedTransactions: 0 });
  assert.deepEqual(await node.watchCoverage(owner), receipt);
  assert.equal(node.status().walletReady, false);
  await node.stop();
  await assert.rejects(node.watchCoverage(owner), /Start/);
  const old = await fixture(t);
  await old.node.start();
  await assert.rejects(old.node.registerWatches(input), /cannot accept/);
});

test('a timed-out lease rejects all outstanding requests and cannot accept late or duplicate replies', async () => {
  const lines = [];
  const watch = new WatchRequests(line => lines.push(JSON.parse(line)), reason => watch.close(reason), 20);
  watch.active = true;
  const req = { owner: '11'.repeat(32), action: 'coverage' };
  const a = watch.request(req);
  const b = watch.request(req);
  await Promise.all([assert.rejects(a, /timed out/), assert.rejects(b, /timed out/)]);
  assert.deepEqual(lines.map(r => r.id), [1, 2]);
  assert.throws(() => watch.receive({ protocol: PROTOCOL, id: 1, error: 'late' }), /Unrecognized/);
  await assert.rejects(watch.request(req), /cannot accept/);
});

const nativeBinary = process.env.CHICORY_TEST_MANAGED_FLORESTA_BINARY;
test('native managed build enforces a chain-only listener, exclusive store and owner death', { skip: !nativeBinary, timeout: 60000 }, async t => {
  const profileDirectory = await mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-native-'));
  const options = { profileDirectory, binary: nativeBinary, sha256: digest(await readFile(nativeBinary)), network: 'regtest' };
  let child, endpoint;
  const node = new ManagedFloresta({ ...options, spawnProcess(file, args, settings) {
    child = spawn(file, args, settings);
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { endpoint = JSON.parse(buf.slice(0, nl)).endpoint; buf = buf.slice(nl + 1); }
    });
    return child;
  } });
  t.after(async () => { await node.stop(); await rm(profileDirectory, { recursive: true, force: true }); });
  const started = await node.start();
  assert.equal(started.tipHash, genesis); assert.equal(started.walletReady, false);
  const competing = new ManagedFloresta(options);
  await assert.rejects(competing.start(), /directory is in use/);
  assert.equal(node.status().phase, 'running');

  const port = Number(endpoint.split(':')[1]);
  const socket = net.connect({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blockchain.scriptpubkey.subscribe', params: ['51'] }) + '\n');
  let reply = '';
  for await (const chunk of socket) {
    reply += chunk;
    if (reply.includes('\n')) break;
  }
  assert.ok(JSON.parse(reply.trim()).error);
  // On the qualification Mac, independently enumerate all listeners owned by this PID.
  if (process.platform === 'darwin') {
    const listeners = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    assert.deepEqual(listeners.split('\n').filter(line => line.startsWith('n')), ['n' + endpoint]);
  }
  await node.stop();
  assert.equal(child.exitCode, 0, 'Native shutdown must complete without SIGKILL');
  const data = path.join(profileDirectory, 'chicory-floresta', 'regtest');
  const owner = await readFile(path.join(data, 'chicory-owner.json'), 'utf8');
  // The managed mode must ignore existing config files on this volume.
  await writeFile(path.join(data, 'regtest', 'config.toml'), '[wallet]\ndescriptors = ["invalid-descriptor"]\n', { mode: 0o600 });
  const detachedOwner = spawn(nativeBinary, ['--managed-stdio', '--network', 'regtest', '--data-dir', data, '--disable-dns-seeds'], {
    env: { HOME: data, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ['pipe', 'pipe', 'ignore']
  });
  t.after(() => { if (detachedOwner.exitCode === null && detachedOwner.signalCode === null) detachedOwner.kill('SIGKILL'); });
  await once(detachedOwner.stdout, 'data');
  const closed = once(detachedOwner, 'close');
  detachedOwner.stdin.destroy(); // Simulate the owner disappearing without any shutdown RPC.
  assert.equal((await closed)[0], 0);
  assert.equal((await node.start()).tipHash, genesis);
  assert.equal(await readFile(path.join(data, 'chicory-owner.json'), 'utf8'), owner);
});
