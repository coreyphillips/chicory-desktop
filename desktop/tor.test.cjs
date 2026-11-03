'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { BundledTor, torConfiguration, loopbackEndpoint, isOnionHost, torEnvironment } = require('./tor.cjs');

const onion = 'a'.repeat(56) + '.onion';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fakeTor(t, { progress = 100, rejectAuthentication = false, socksProtocol = false, spawnError = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-tor-test-'));
  const bundle = path.join(root, 'bundle');
  const data = path.join(root, 'state');
  fs.mkdirSync(path.join(bundle, 'tor'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor'), 'fixture');
  const sockets = new Set();
  const children = [];
  const commands = [];
  const requests = [];
  let stopped = 0;
  let socksServer;
  let controlServer;
  function spawnProcess(_file, args, options) {
    assert.equal(options.env.DESKTOP_SESSION_TOKEN, undefined);
    assert.equal(options.windowsHide, true);
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.killed = false;
    children.push(child);
    if (spawnError) {
      queueMicrotask(() => child.emit('error', new Error('fixture spawn failure')));
      return child;
    }
    let exited = false;
    const stop = () => {
      if (exited) return;
      exited = true; stopped++;
      for (const socket of sockets) socket.destroy();
      socksServer?.close(); controlServer?.close();
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    };
    child.kill = () => { child.killed = true; stop(); return true; };
    const config = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
    assert.doesNotMatch(config, /HiddenServiceDir|HiddenServicePort/);
    const cookiePath = JSON.parse(/^CookieAuthFile (.+)$/m.exec(config)[1]);
    const endpointPath = JSON.parse(/^ControlPortWriteToFile (.+)$/m.exec(config)[1]);
    const cookie = Buffer.alloc(32, 7);
    fs.writeFileSync(cookiePath, cookie);
    socksServer = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      if (!socksProtocol) { socket.pipe(socket); return; }
      let buffer = Buffer.alloc(0); let step = 0;
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (step === 0 && buffer.length >= 3) {
          assert.deepEqual([...buffer.subarray(0, 3)], [5, 1, 0]);
          buffer = buffer.subarray(3); step = 1; socket.write(Buffer.from([5, 0]));
        }
        if (step === 1 && buffer.length >= 5 && buffer.length >= 7 + buffer[4]) {
          assert.deepEqual([...buffer.subarray(0, 4)], [5, 1, 0, 3]);
          const end = 5 + buffer[4];
          requests.push({ host: buffer.subarray(5, end).toString('ascii'), port: buffer.readUInt16BE(end) });
          buffer = buffer.subarray(end + 2); step = 2;
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        }
        if (step === 2 && buffer.length) { socket.write(buffer); buffer = Buffer.alloc(0); }
      });
    });
    socksServer.listen(0, '127.0.0.1', () => {
      controlServer = net.createServer(socket => {
        sockets.add(socket); socket.on('error', () => {});
        let buffer = ''; let owned = false;
        socket.on('close', () => { sockets.delete(socket); if (owned) stop(); });
        socket.on('data', chunk => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const command = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
            commands.push(command.startsWith('AUTHENTICATE') ? 'AUTHENTICATE' : command);
            if (command.startsWith('AUTHENTICATE')) socket.write(rejectAuthentication ? '515 Rejected\r\n' : '250 OK\r\n');
            else if (command === 'TAKEOWNERSHIP') { owned = true; socket.write('250 OK\r\n'); }
            else if (command.startsWith('RESETCONF')) socket.write('250 OK\r\n');
            else if (command === 'GETINFO net/listeners/socks') socket.write(`250-net/listeners/socks="127.0.0.1:${socksServer.address().port}"\r\n250 OK\r\n`);
            else if (command === 'GETINFO status/bootstrap-phase') socket.write(`250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=${progress} TAG=done\r\n250 OK\r\n`);
            else socket.write('510 Unknown\r\n');
          }
        });
      });
      controlServer.listen(0, '127.0.0.1', () => fs.writeFileSync(endpointPath, `PORT=127.0.0.1:${controlServer.address().port}\n`));
    });
    return child;
  }
  const tor = new BundledTor({ bundleDirectory: bundle, dataDirectory: data, spawnProcess, bootstrapTimeoutMs: 300 });
  t.after(async () => { await tor.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { tor, commands, children, requests, stopped: () => stopped };
}

test('Tor configuration is outbound only, private, authenticated and process owned', () => {
  const config = torConfiguration('/private/tor state', '/app/tor', 1234);
  assert.match(config, /^ClientOnly 1$/m);
  assert.match(config, /^ORPort 0$/m);
  assert.match(config, /^DirPort 0$/m);
  assert.match(config, /^SocksPort 127\.0\.0\.1:auto$/m);
  assert.match(config, /^ControlPort 127\.0\.0\.1:auto$/m);
  assert.match(config, /^CookieAuthentication 1$/m);
  assert.match(config, /^__OwningControllerProcess 1234$/m);
  assert.doesNotMatch(config, /HiddenService/);
  assert.deepEqual(loopbackEndpoint('127.0.0.1:12345'), { host: '127.0.0.1', port: 12345 });
  for (const value of ['0.0.0.0:9050', 'localhost:9050', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:5/path'])
    assert.throws(() => loopbackEndpoint(value), /private loopback/);
  assert.equal(isOnionHost(onion), true);
  assert.equal(isOnionHost('bad.onion'), false);
  const env = torEnvironment('/app/tor', { PATH: '/bin', DESKTOP_SESSION_TOKEN: 'secret', NODE_OPTIONS: '--inspect', LD_PRELOAD: 'evil' });
  assert.equal(env.DESKTOP_SESSION_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.LD_PRELOAD, undefined);
});

test('starting the loopback proxy does not start Tor and concurrent readiness calls share one daemon', async t => {
  const { tor, children, commands, stopped } = await fakeTor(t);
  const proxy = await tor.startProxy();
  assert.equal(proxy.host, '127.0.0.1'); assert.equal(children.length, 0);
  const [first, second] = await Promise.all([tor.ensureReady(), tor.ensureReady()]);
  assert.deepEqual(first, proxy); assert.deepEqual(second, proxy); assert.equal(children.length, 1);
  assert.deepEqual(commands.slice(0, 3), ['AUTHENTICATE', 'TAKEOWNERSHIP', 'RESETCONF __OwningControllerProcess']);
  assert.equal(tor.status().phase, 'ready'); assert.equal(tor.status().progress, 100);
  await tor.stop(); assert.equal(stopped(), 1); assert.equal(tor.status().phase, 'stopped');
  await assert.rejects(tor.ensureReady(), /stopped/);
});

test('first proxy use starts Tor and forwards only after bootstrap', async t => {
  const { tor, children } = await fakeTor(t);
  const endpoint = await tor.startProxy();
  const socket = net.createConnection(endpoint);
  t.after(() => socket.destroy());
  const echoed = new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject); });
  socket.write('test-data');
  assert.equal(children.length, 0);
  assert.equal(String(await echoed), 'test-data');
  assert.equal(children.length, 1); assert.equal(tor.status().phase, 'ready');
  socket.destroy();
});

test('control authentication failure fails closed and reaps the child', async t => {
  const { tor, stopped } = await fakeTor(t, { rejectAuthentication: true });
  await assert.rejects(tor.ensureReady(), /rejected its private control/);
  assert.equal(tor.status().phase, 'failed'); assert.equal(stopped(), 1);
});

test('bootstrap is bounded and never forwards a connection before Tor is ready', async t => {
  const { tor, stopped } = await fakeTor(t, { progress: 10 });
  await assert.rejects(tor.ensureReady(), /could not connect/);
  assert.equal(stopped(), 1); assert.equal(tor.status().phase, 'failed');
});

test('closing during bootstrap cancels startup and leaves no child or listener', async t => {
  const { tor, stopped } = await fakeTor(t, { progress: 10 });
  const pending = tor.ensureReady();
  const rejected = assert.rejects(pending, /cancelled|could not connect|closed/);
  await pause(150); await tor.stop(); await rejected;
  assert.equal(stopped(), 1); assert.equal(tor.status().phase, 'stopped');
});

test('onion bridges reject ordinary hosts instead of providing arbitrary local TCP forwarding', async t => {
  const { tor, children } = await fakeTor(t);
  await assert.rejects(tor.createBridge('127.0.0.1', 80), /valid onion/);
  await assert.rejects(tor.createBridge(onion, 65536), /valid onion/);
  assert.equal(children.length, 0);
});

test('an onion bridge sends its hostname through SOCKS and closes active tunnels', { timeout: 3000 }, async t => {
  const { tor, requests } = await fakeTor(t, { socksProtocol: true });
  const bridge = await tor.createBridge(onion, 50001);
  const socket = net.createConnection({ host: bridge.host, port: bridge.port });
  t.after(() => socket.destroy());
  const echoed = new Promise((resolve, reject) => { socket.once('data', resolve); socket.once('error', reject); });
  socket.write('electrum-fixture');
  assert.equal(String(await echoed), 'electrum-fixture');
  assert.deepEqual(requests, [{ host: onion, port: 50001 }]);
  const closed = new Promise(resolve => socket.once('close', resolve));
  await bridge.close(); await closed;
  assert.equal(tor.bridges.size, 0);
});

test('a spawn failure rejects without waiting for a nonexistent process to exit', async t => {
  const { tor } = await fakeTor(t, { spawnError: true });
  await assert.rejects(tor.ensureReady(), /could not start/);
  assert.equal(tor.status().phase, 'failed');
});

test('closing while the private listener binds prevents a late daemon or listener', async t => {
  const { tor, children } = await fakeTor(t);
  const rejected = assert.rejects(tor.ensureReady(), /cancelled|stopped/);
  await tor.stop(); await rejected;
  assert.equal(children.length, 0);
  assert.equal(tor.proxy.listening, false);
});

test('a dead daemon invalidates readiness and can be restarted on demand', async t => {
  const { tor, children } = await fakeTor(t);
  await tor.ensureReady();
  children[0].kill(); await pause(0);
  assert.equal(tor.status().phase, 'failed');
  await tor.ensureReady();
  assert.equal(children.length, 2); assert.equal(tor.status().phase, 'ready');
});
