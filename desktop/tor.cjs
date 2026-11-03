'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const TOR_VERSION = '0.4.9.15';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => JSON.stringify(String(value));
const error = message => Object.assign(new Error(message), { code: 'TOR_UNAVAILABLE' });

function isOnionHost(host) {
  return typeof host === 'string' && /^[a-z2-7]{56}\.onion$/i.test(host.trim());
}

function loopbackEndpoint(value) {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(String(value));
  if (!match || Number(match[1]) > 65535) throw error('Tor did not provide a private loopback endpoint.');
  return { host: '127.0.0.1', port: Number(match[1]) };
}

function torEnvironment(directory, base = process.env) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'LANG'])
    if (base[name]) env[name] = base[name];
  // The official Linux bundle's loader needs its adjacent shared libraries.
  if (process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(directory, 'tor');
  return env;
}

function torConfiguration(directory, bundleDirectory, ownerPid) {
  return [
    'ClientOnly 1', 'ORPort 0', 'DirPort 0', 'SocksPort 127.0.0.1:auto',
    'SocksPolicy accept 127.0.0.1', 'SocksPolicy reject *',
    'ControlPort 127.0.0.1:auto', 'CookieAuthentication 1', 'CookieAuthFileGroupReadable 0',
    `DataDirectory ${quote(directory)}`,
    `ControlPortWriteToFile ${quote(path.join(directory, 'control-port'))}`,
    `CookieAuthFile ${quote(path.join(directory, 'control-cookie'))}`,
    `GeoIPFile ${quote(path.join(bundleDirectory, 'data/geoip'))}`,
    `GeoIPv6File ${quote(path.join(bundleDirectory, 'data/geoip6'))}`,
    `__OwningControllerProcess ${ownerPid}`,
    'SafeLogging 1', 'AvoidDiskWrites 1', 'Log err stderr',
  ].join('\n') + '\n';
}

class TorControlClient {
  constructor(socket, timeoutMs = 5000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = null;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => this._data(data));
    socket.on('error', () => this._fail(error('Tor control connection failed.')));
    socket.on('close', () => this._fail(error('Tor control connection closed.')));
  }
  static async connect(endpoint, timeoutMs = 5000) {
    const socket = net.createConnection(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(error('Tor control connection timed out.')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(error('Tor control connection failed.')); });
    });
    return new TorControlClient(socket, timeoutMs);
  }
  request(command) {
    if (this.pending || this.socket.destroyed) return Promise.reject(error('Tor control connection is unavailable.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(error('Tor control request timed out.')), this.timeoutMs);
      this.pending = { lines: [], resolve, reject, timer };
      this.socket.write(command + '\r\n');
    });
  }
  _data(data) {
    this.buffer += data;
    if (this.buffer.length > 65536) { this._fail(error('Tor control reply was too large.')); this.socket.destroy(); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (/^650[ -]/.test(line)) continue;
      if (!this.pending) continue;
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!match) { this._fail(error('Tor returned an invalid control reply.')); continue; }
      this.pending.lines.push(match[3]);
      if (match[2] !== ' ') continue;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      if (match[1] === '250') pending.resolve(pending.lines);
      else pending.reject(error('Tor rejected its private control request.'));
    }
  }
  _fail(cause) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(cause);
  }
  close() { this.socket.destroy(); }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ host: '127.0.0.1', port: server.address().port });
    });
  });
}

function readBytes(socket, count, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(error('Tor tunnel negotiation timed out.')), timeoutMs);
    function finish(cause, value) {
      clearTimeout(timer); socket.off('data', data); socket.off('error', failed); socket.off('close', closed);
      socket.pause();
      if (cause) reject(cause); else resolve(value);
    }
    function data(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= count) {
        finish(null, buffer.subarray(0, count));
        if (buffer.length > count) socket.unshift(buffer.subarray(count));
      }
    }
    const failed = () => finish(error('Tor tunnel connection failed.'));
    const closed = () => finish(error('Tor tunnel connection closed.'));
    socket.on('data', data); socket.once('error', failed); socket.once('close', closed); socket.resume();
  });
}

class BundledTor {
  constructor({ bundleDirectory, dataDirectory, onStatus = () => {}, bootstrapTimeoutMs = 120000, spawnProcess = spawn }) {
    this.bundleDirectory = path.resolve(bundleDirectory);
    this.dataDirectory = path.resolve(dataDirectory);
    this.onStatus = onStatus;
    this.bootstrapTimeoutMs = bootstrapTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.phase = 'stopped'; this.progress = 0; this.failure = null;
    this.closed = false; this.child = null; this.control = null; this.ready = null;
    this.proxy = null; this.proxyReady = null; this.endpoint = null; this.nativeEndpoint = null;
    this.sockets = new Set(); this.bridges = new Set(); this.finishedChildren = new WeakSet();
  }
  status() { return { phase: this.phase, progress: this.progress, error: this.failure }; }
  _state(phase, progress = this.progress, failure = null) {
    if (this.phase === phase && this.progress === progress && this.failure === failure) return;
    this.phase = phase; this.progress = progress; this.failure = failure;
    this.onStatus(this.status());
  }
  startProxy() {
    if (this.closed) return Promise.reject(error('Tor has stopped. Reopen Chicory to reconnect.'));
    if (this.proxyReady) return this.proxyReady;
    this.proxy = net.createServer(socket => this._forward(socket));
    this.proxyReady = listen(this.proxy).then(endpoint => {
      if (this.closed) throw error('Tor startup was cancelled.');
      this.endpoint = endpoint; return endpoint;
    });
    return this.proxyReady;
  }
  async _forward(socket) {
    if (this.closed || this.sockets.size >= 128) { socket.destroy(); return; }
    this._track(socket); socket.pause();
    try {
      await this.ensureReady();
      if (socket.destroyed || this.closed) return;
      const upstream = net.createConnection(this.nativeEndpoint);
      this._track(upstream);
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
      upstream.once('close', () => socket.destroy());
      upstream.once('connect', () => { socket.pipe(upstream); upstream.pipe(socket); socket.resume(); });
    } catch { socket.destroy(); }
  }
  _track(socket) {
    this.sockets.add(socket);
    socket.once('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
  }
  async ensureReady() {
    if (this.closed) throw error('Tor has stopped. Reopen Chicory to reconnect.');
    await this.startProxy();
    if (this.closed) throw error('Tor startup was cancelled.');
    if (!this.ready) {
      this.ready = this._start().catch(async cause => {
        await this._stopProcess();
        this.ready = null;
        if (!this.closed) this._state('failed', this.progress, cause.message);
        throw cause;
      });
    }
    await this.ready;
    return this.endpoint;
  }
  async _start() {
    this._state('starting', 0);
    const binary = path.join(this.bundleDirectory, 'tor', process.platform === 'win32' ? 'tor.exe' : 'tor');
    if (!fs.existsSync(binary)) throw error('This build is missing its bundled Tor runtime.');
    fs.mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    const controlFile = path.join(this.dataDirectory, 'control-port');
    const cookieFile = path.join(this.dataDirectory, 'control-cookie');
    for (const file of [controlFile, cookieFile]) {
      try { fs.unlinkSync(file); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    }
    const config = path.join(this.dataDirectory, 'chicory-torrc');
    const defaults = path.join(this.dataDirectory, 'empty-torrc');
    fs.writeFileSync(config, torConfiguration(this.dataDirectory, this.bundleDirectory, process.pid), { mode: 0o600 });
    fs.writeFileSync(defaults, '', { mode: 0o600 });
    let processFailure;
    const child = this.spawnProcess(binary, ['--defaults-torrc', defaults, '-f', config], {
      cwd: this.bundleDirectory, env: torEnvironment(this.bundleDirectory), windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.child = child;
    child.once('error', () => {
      this.finishedChildren.add(child);
      processFailure = error('Bundled Tor could not start.');
    });
    child.once('exit', () => {
      this.finishedChildren.add(child);
      processFailure = error('Bundled Tor stopped before its connection was ready.');
      if (!this.closed && this.phase === 'ready') {
        this.ready = null; this.nativeEndpoint = null;
        this._state('failed', 0, 'Bundled Tor stopped. Retry the wallet connection.');
        for (const socket of this.sockets) socket.destroy();
      }
    });
    const deadline = Date.now() + this.bootstrapTimeoutMs;
    let controlEndpoint;
    while (!controlEndpoint) {
      if (this.closed) throw error('Tor startup was cancelled.');
      if (processFailure) throw processFailure;
      if (Date.now() >= deadline) throw error('Tor did not finish starting. Check the connection and retry.');
      try {
        const text = fs.readFileSync(controlFile, 'utf8').trim();
        if (fs.existsSync(cookieFile)) controlEndpoint = loopbackEndpoint(text.replace(/^PORT=/, ''));
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!controlEndpoint) await wait(100);
    }
    this.control = await TorControlClient.connect(controlEndpoint);
    const cookie = fs.readFileSync(cookieFile);
    if (cookie.length !== 32) throw error('Tor did not provide valid private control authentication.');
    try { await this.control.request(`AUTHENTICATE ${cookie.toString('hex')}`); }
    finally { cookie.fill(0); }
    await this.control.request('TAKEOWNERSHIP');
    await this.control.request('RESETCONF __OwningControllerProcess');
    const listeners = await this.control.request('GETINFO net/listeners/socks');
    const socks = listeners.find(line => line.startsWith('net/listeners/socks='));
    const match = /^net\/listeners\/socks="(127\.0\.0\.1:\d+)"$/.exec(socks || '');
    if (!match) throw error('Tor did not open a private SOCKS endpoint.');
    this.nativeEndpoint = loopbackEndpoint(match[1]);
    while (Date.now() < deadline) {
      if (this.closed) throw error('Tor startup was cancelled.');
      if (processFailure) throw processFailure;
      const lines = await this.control.request('GETINFO status/bootstrap-phase');
      const result = /\bPROGRESS=(\d+)\b/.exec(lines.join(' '));
      if (!result || Number(result[1]) > 100) throw error('Tor returned an invalid bootstrap status.');
      const progress = Number(result[1]);
      this._state(progress === 100 ? 'ready' : 'starting', progress);
      if (progress === 100) return;
      await wait(500);
    }
    throw error('Tor could not connect within two minutes. Check the network and retry.');
  }
  async createBridge(host, port) {
    host = typeof host === 'string' ? host.trim().toLowerCase() : host;
    if (!isOnionHost(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw error('Choose a valid onion server and port.');
    await this.ensureReady();
    if (this.closed) throw error('Tor startup was cancelled.');
    const connections = new Set();
    const track = socket => {
      this._track(socket); connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    };
    const server = net.createServer(async socket => {
      if (this.closed || this.sockets.size >= 128) { socket.destroy(); return; }
      track(socket); socket.pause();
      let upstream;
      try {
        await this.ensureReady();
        if (this.closed || socket.destroyed) return;
        upstream = net.createConnection(this.nativeEndpoint);
        track(upstream);
        await new Promise((resolve, reject) => { upstream.once('connect', resolve); upstream.once('error', reject); });
        upstream.write(Buffer.from([5, 1, 0]));
        const accepted = await readBytes(upstream, 2);
        if (accepted[0] !== 5 || accepted[1] !== 0) throw error('Tor refused the tunnel handshake.');
        const address = Buffer.from(host.toLowerCase(), 'ascii');
        upstream.write(Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address, Buffer.from([port >> 8, port & 255])]));
        const reply = await readBytes(upstream, 4);
        if (reply[0] !== 5 || reply[1] !== 0) throw error('Tor could not reach this onion server.');
        if (reply[3] === 1) await readBytes(upstream, 6);
        else if (reply[3] === 4) await readBytes(upstream, 18);
        else if (reply[3] === 3) { const length = await readBytes(upstream, 1); await readBytes(upstream, length[0] + 2); }
        else throw error('Tor returned an invalid tunnel reply.');
        socket.once('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy());
        upstream.once('close', () => socket.destroy()); upstream.once('error', () => socket.destroy());
        socket.pipe(upstream); upstream.pipe(socket); socket.resume(); upstream.resume();
      } catch { socket.destroy(); upstream?.destroy(); }
    });
    const endpoint = await listen(server);
    if (this.closed) {
      await new Promise(resolve => server.close(resolve));
      throw error('Tor startup was cancelled.');
    }
    this.bridges.add(server);
    return { ...endpoint, close: () => new Promise(resolve => {
      this.bridges.delete(server);
      for (const socket of connections) socket.destroy();
      server.close(resolve);
    }) };
  }
  async _stopProcess() {
    const child = this.child;
    this.child = null;
    if (this.control) { this.control.close(); this.control = null; }
    this.nativeEndpoint = null;
    if (!child || this.finishedChildren.has(child) || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      // TAKEOWNERSHIP closes authenticated sessions normally, including Windows.
      // A process that failed before authentication still needs termination.
      if (this.phase !== 'ready' && !child.killed) child.kill('SIGTERM');
    });
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    // Let an in-flight bind settle before closing its server.
    if (this.proxyReady) await this.proxyReady.catch(() => {});
    for (const socket of this.sockets) socket.destroy();
    const servers = [this.proxy, ...this.bridges].filter(Boolean);
    this.bridges.clear();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await this._stopProcess();
    if (this.ready) await this.ready.catch(() => {});
    this._state('stopped', 0);
  }
}

module.exports = { BundledTor, TorControlClient, TOR_VERSION, torConfiguration, torEnvironment, loopbackEndpoint, isOnionHost };
