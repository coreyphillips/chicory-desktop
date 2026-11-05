'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { WatchRequests, PROTOCOL, register, coverage } = require('./floresta-watches.cjs');

const { readConfirmedTransaction } = require('./floresta-transactions.cjs');
const { openConfirmedWallet } = require('./floresta-confirmed-reads.cjs');
const { openPendingWallet } = require('./floresta-pending-reads.cjs');

const NETWORKS = {
  mainnet: ['bitcoin', '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  testnet: ['testnet', '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'],
  regtest: ['regtest', '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'],
};
const cancelled = () => new Error('Local node startup was stopped.');
const sha = bytes => createHash('sha256').update(bytes).digest();
const reserveBytes = 128 * 1024 * 1024; // Stop before exhausting the volume. Not a sync-size estimate.

async function verifyBinary(binary, expected) {
  if (typeof binary !== 'string' || !path.isAbsolute(binary) || typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected)) throw new Error('A verified managed Floresta build is required.');
  const before = await fsp.lstat(binary);
  if (!before.isFile()) throw new Error('The managed Floresta binary is missing or invalid.');
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(binary)) digest.update(chunk);
  const after = await fsp.lstat(binary);
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs ||
      digest.digest('hex') !== expected) throw new Error('The managed Floresta binary failed its SHA-256 check.');
}

async function privateDirectory(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Local node storage must be a private directory owned by this user.');
  }
  return stat;
}

async function checkSpace(directory) {
  const { bavail, bsize } = await fsp.statfs(directory);
  if (bavail * bsize < reserveBytes) throw new Error('Local node storage has less than 128 MiB of free space.');
}

// One owner per network on a selected volume. Publish a complete owner/format marker
// before the daemon can create files. The daemon separately holds an OS lock until exit.
async function prepareStorage(profileDirectory, storageDirectory, network, initialized) {
  const profile = await fsp.realpath(profileDirectory);
  const parent = storageDirectory ? await fsp.realpath(storageDirectory) : profile;
  if (storageDirectory && parent !== storageDirectory) throw new Error('Reselect the original local node volume.');
  if (parent !== profile && (parent.startsWith(profile + path.sep) || parent.split(path.sep).includes('chicory-floresta'))) {
    throw new Error('Select the profile root or a separate storage folder outside wallet and node data.');
  }
  const stat = await fsp.stat(parent);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o022)))) {
    throw new Error('Choose a storage folder owned by this user without shared write permissions.');
  }
  if (process.platform === 'win32' && parent !== profile) {
    throw new Error('Use the private profile directory on Windows until custom-folder access controls are qualified.');
  }
  await checkSpace(parent);
  const base = path.join(parent, 'chicory-floresta');
  if (!initialized) await fsp.mkdir(base, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  try {
    await privateDirectory(base);
  } catch (error) {
    if (initialized && error.code === 'ENOENT') throw new Error('Reconnect the original local node storage before restarting.');
    throw error;
  }
  const dir = path.join(base, network);
  const owner = JSON.stringify({ format: 'chicory-floresta/1', network, profile: sha(profile).toString('hex') });
  const marker = 'chicory-owner.json';
  try {
    await fsp.lstat(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (initialized) throw new Error('Reconnect the original local node storage before restarting.');
    const staging = await fsp.mkdtemp(path.join(base, '.init-'));
    try {
      await fsp.writeFile(path.join(staging, marker), owner, { mode: 0o600, flag: 'wx' });
      await fsp.rename(staging, dir);
    } catch (publishError) {
      await fsp.unlink(path.join(staging, marker)).catch(() => {});
      await fsp.rmdir(staging).catch(() => {});
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(publishError.code)) throw publishError;
    }
  }
  const identity = await privateDirectory(dir);
  const file = path.join(dir, marker);
  const markerStat = await fsp.lstat(file);
  if (!markerStat.isFile() || markerStat.size > 1024 || (await fsp.readFile(file, 'utf8')) !== owner) {
    throw new Error('This local node directory has another profile owner or an incompatible storage format.');
  }
  // App-owned profile and external volume markers must never alias other files.
  if (markerStat.nlink !== 1) throw new Error('Invalid local node storage owner marker.');
  if (network !== 'mainnet') {
    // Upstream appends a second network-specific directory. A selected volume
    // must never redirect the actual chain store to another profile via a link.
    const store = path.join(dir, network === 'testnet' ? 'testnet3' : network);
    if (!initialized) await fsp.mkdir(store, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await privateDirectory(store);
  }
  return { dir, identity };
}

async function removeOwnedData({ profileDirectory, storageDirectory, network, binary, sha256 }) {
  if (process.platform !== 'darwin') throw new Error('Automatic node data removal is qualified only on macOS.');
  if (!Object.hasOwn(NETWORKS, network)) throw new Error('Unsupported local node network.');
  const profile = await fsp.realpath(profileDirectory);
  const parent = storageDirectory ? await fsp.realpath(storageDirectory) : profile;
  if (storageDirectory && parent !== storageDirectory || parent !== profile && parent.startsWith(profile + path.sep) ||
      parent.split(path.sep).includes('chicory-floresta')) throw new Error('The selected storage location changed.');
  const dir = path.join(parent, 'chicory-floresta', network);
  const owner = sha(profile).toString('hex');
  await verifyBinary(binary, sha256);
  // The verified helper validates the private owner marker and each allowed
  // database entry while holding the running daemon's kernel lock. It never
  // starts network services. A timeout leaves a durable retry marker.
  const args = ['--managed-cleanup-for', owner, '--data-dir', dir, '--network', NETWORKS[network][0]];
  const { stdout } = await promisify(execFile)(binary, args, { cwd: dir, env: { HOME: dir, TMPDIR: dir },
    timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 }).catch(() => {
    throw new Error('Node storage is unavailable, in use, or contains unexpected files. Reconnect the original volume and retry.');
  });
  if (stdout.trim() !== 'chicory.storage-removed/1') throw new Error('The verified node did not confirm data removal.');
}

function validateStatus(state, network) {
  const [name, genesis] = NETWORKS[network];
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(state.endpoint);
  if (state.protocol !== 'chicory.floresta/1' || state.network !== name || state.genesis !== genesis ||
      !match || Number(match[1]) > 65535 || !Number.isSafeInteger(state.height) || state.height < 0 ||
      !Number.isSafeInteger(state.validated) || state.validated < 0 || state.validated > state.height ||
      typeof state.tip !== 'string' || !/^[a-f0-9]{64}$/.test(state.tip) || typeof state.ibd !== 'boolean' ||
      (state.height === 0 && state.tip !== genesis)) throw new Error('The local node returned an invalid identity or chain state.');
  const historical = state.historical;
  const height = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  if (historical !== undefined && (!['pending', 'verifying', 'verified', 'error'].includes(historical?.state) ||
      !height(historical.height) || !height(historical.target) || historical.height > historical.target ||
      (historical.state === 'verified' && (historical.height !== historical.target || historical.target > state.height ||
        state.ibd || state.validated !== state.height)))) {
    throw new Error('The local node returned an invalid historical validation status.');
  }
  return { historicalVerification: historical?.state ?? 'unknown', historicalHeight: historical?.height ?? null,
    historicalTarget: historical?.target ?? null, port: Number(match[1]), height: state.height, validatedHeight: state.validated, tipHash: state.tip,
    tipSynced: !state.ibd && state.height === state.validated };
}

const headerHash = hex => sha(sha(Buffer.from(hex, 'hex'))).reverse().toString('hex');

async function chainHeaders(port, heights, signal) {
  const socket = net.createConnection({ host: '127.0.0.1', port, signal });
  const timer = setTimeout(() => socket.destroy(new Error('The local chain header request timed out.')), 5000);
  try {
    const source = socket[Symbol.asyncIterator]();
    const headers = [];
    for (const height of heights) {
      const id = headers.length + 1;
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'blockchain.block.header', params: [height] }) + '\n');
      let line = '';
      while (!line.includes('\n')) {
        const { value, done } = await source.next();
        if (done || line.length + value.length > 2048) throw new Error('Invalid managed chain header reply.');
        line += value.toString();
      }
      const reply = JSON.parse(line);
      if (reply.id !== id || typeof reply.result !== 'string' || !/^[a-fA-F0-9]{160}$/.test(reply.result)) {
        throw new Error('Invalid managed chain header.');
      }
      headers.push(reply.result.toLowerCase());
    }
    return headers;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

async function verifyElectrum(port, network, signal) {
  const [genesis] = await chainHeaders(port, [0], signal);
  if (headerHash(genesis) !== NETWORKS[network][1]) throw new Error('The owned Electrum listener did not prove the selected network.');
}

class ManagedFloresta {
  // binary and sha256 come from trusted application resources. No renderer-supplied
  // executable, arguments, network addresses, environment or config files are accepted.
  constructor({ profileDirectory, storageDirectory, binary, sha256, network, initialized = false, onStatus = () => {}, spawnProcess = spawn }) {
    if (!Object.hasOwn(NETWORKS, network)) throw new Error('Unsupported local node network.');
    this.options = { profileDirectory, storageDirectory, binary, sha256, network };
    this.initialized = initialized;
    this.onStatus = onStatus;
    this.spawnProcess = spawnProcess;
    this._state('stopped');
  }
  status() { return { ...this.state }; }
  async registerWatches(input) {
    const command = register(input);
    if (!this.watch) throw new Error('Start the local node before registering watches.');
    return this.watch.request(command);
  }
  async watchCoverage(owner) {
    const command = coverage(owner);
    if (!this.watch) throw new Error('Start the local node before checking watch coverage.');
    return this.watch.request(command);
  }
  async confirmedTransaction(owner, txid) {
    const watch = this.watch;
    if (!watch?.active || !watch.transactionsActive) throw new Error('The running local node does not support confirmed transaction proofs.');
    const lifetime = watch.lifetime.signal;
    return readConfirmedTransaction(async command => {
      lifetime.throwIfAborted();
      const result = await watch.request(command);
      lifetime.throwIfAborted();
      return result;
    }, owner, txid);
  }
  openConfirmedWallet(owner, signal) {
    return openConfirmedWallet(this.watch, owner, signal, () => this.status());
  }
  async readHeader(height, tip) {
    const watch = this.watch;
    if (!watch?.active || !Number.isSafeInteger(height) || height < 0 || height > tip?.tipHeight ||
        this.state.tipHash !== tip?.tipHash || this.state.height !== tip?.tipHeight || !this.state.tipSynced ||
        this.state.historicalVerification !== 'verified') return null;
    const lifetime = watch.lifetime.signal;
    const [before, header, after] = await watch.headers([tip.tipHeight, height, tip.tipHeight]);
    if (lifetime.aborted || !watch.active || this.watch !== watch || this.state.tipHash !== tip.tipHash || headerHash(before) !== tip.tipHash || before !== after ||
        (height === 0 && headerHash(header) !== NETWORKS[this.options.network][1]) ||
        (height === tip.tipHeight && header !== before)) return null;
    return header;
  }
  supportsPending() {
    return Boolean(this.watch?.active && this.watch.pendingActive);
  }
  openPendingWallet(owner, signal) {
    return openPendingWallet(this.watch, owner, signal, () => this.status());
  }
  _state(phase, fields = {}) {
    this.state = { network: this.options.network, phase, error: null, height: null, validatedHeight: null, tipHash: null,
      tipSynced: null, walletScan: 'unqualified', historicalVerification: 'unknown', historicalHeight: null, historicalTarget: null, walletReady: false, ...fields };
    this.onStatus(this.status());
  }
  start() {
    if (this.task) return this.controller.signal.aborted ? this.task.then(() => this.start()) : this.ready.then(() => this.status());
    const controller = new AbortController();
    this.controller = controller;
    this.stopError = null;
    let ready;
    this.ready = new Promise((resolve, reject) => { ready = { resolve, reject }; });
    this.task = this._run(controller.signal, ready).catch(error => {
      if (!controller.signal.aborted) this._state('failed', { error: error.message });
      ready.reject(controller.signal.aborted ? cancelled() : error);
    }).finally(() => {
      if (controller.signal.aborted) this._state('stopped');
      this.task = null;
      this.controller = null;
    });
    return this.ready;
  }
  async stop() {
    this.controller?.abort();
    if (!this.task) { this._state('stopped'); return; }
    let timer;
    try {
      await Promise.race([this.task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local node shutdown has not finished. Its storage remains locked.')), 65000);
      })]);
      if (this.stopError) throw this.stopError;
    } finally { clearTimeout(timer); }
  }
  async _run(signal, ready) {
    const { binary, sha256, profileDirectory, storageDirectory, network } = this.options;
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted();
      this._state(retry ? 'restarting' : 'starting');
      await verifyBinary(binary, sha256);
      const storage = await prepareStorage(profileDirectory, storageDirectory, network, this.initialized);
      this.initialized = true;
      signal.throwIfAborted();
      const hadHealth = await this._child(storage, signal, ready);
      if (signal.aborted) throw cancelled();
      if (!hadHealth || retry >= 2) throw new Error('The local node exited. Check the storage directory and retry.');
      this._state('restarting');
      await delay(500 * (2 ** retry), undefined, { signal });
    }
  }
  async _child({ dir, identity }, signal, ready) {
    const { binary, network } = this.options;
    const env = { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, TEMP: dir, TMP: dir, TMPDIR: dir };
    if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
    const args = ['--managed-stdio', '--data-dir', dir, '--network', NETWORKS[network][0], '--assume-valid', '0'];
    if (network === 'regtest') args.push('--disable-dns-seeds');
    const child = this.spawnProcess(binary, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const connection = new AbortController();
    let first = true;
    let endpoint;
    let failure;
    let watchdog;
    let killTimer;
    let stopping = false;
    let pending = '';
    let checking = false;
    let sequence = 0;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(watchdog);
      watch.close(failure || cancelled());
      connection.abort();
      child.stdin.destroy(); // Close the OS pipe, including Windows. EOF releases the child.
      // Upstream flush hashes the complete preallocated header and index maps.
      // On a slow disk this can exceed the normal heartbeat deadline.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 60000);
    };
    const fail = error => {
      if (stopping) return;
      failure = error;
      stop();
    };
    const watch = new WatchRequests(line => child.stdin.write(line, error => {
      if (error && !stopping) fail(new Error('The private local node control pipe closed.'));
    }), fail);
    watch.headers = heights => chainHeaders(endpoint, heights, connection.signal);
    this.watch = watch;
    const heartbeat = () => {
      clearTimeout(watchdog);
      const timedOut = () => fail(new Error('The local node stopped reporting its chain state.'));
      if (first) { watchdog = setTimeout(timedOut, 60000); return; }
      watchdog = setTimeout(() => {
        // A chain store flush can block reads during a reorg. Withdraw every
        // wallet lease immediately and give the same child a bounded recovery
        // interval. A later heartbeat must establish the endpoint and store anew.
        const recoveryMs = 90000;
        watch.suspend(new Error('The local node is waiting for fresh chain data.'), recoveryMs);
        this._state('waiting-for-tip');
        watchdog = setTimeout(timedOut, recoveryMs);
      }, 15000);
    };
    // The bounded status channel carries only observations. It never authorizes
    // an Electrum endpoint switch, work submission or a wallet refresh.
    const observe = async (message) => {
      const state = validateStatus(message, network);
      if (endpoint && endpoint !== state.port) throw new Error('The owned Electrum listener changed unexpectedly.');
      endpoint = state.port;
      if (checking) return;
      checking = true;
      const recovering = watch.lifetime.signal.aborted;
      try {
        if (first || recovering) await verifyElectrum(endpoint, network, connection.signal);
        if (first || recovering || ++sequence % 5 === 0) {
          const current = await privateDirectory(dir);
          if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('The local node storage volume changed.');
          await checkSpace(dir);
        }
        if (stopping || signal.aborted || (!recovering && watch.lifetime.signal.aborted)) return;
        if (recovering) watch.lifetime = new AbortController();
        first = false;
        watch.active = message.watchProtocol === PROTOCOL;
        watch.transactionsActive = message.transactionProtocol === 'chicory.tx/1';
        watch.confirmedReadsActive = message.confirmedReadsProtocol === 'chicory.confirmed/1';
        watch.pendingActive = message.pendingProtocol === 'chicory.pending/1';
        watch.pendingTransactionActive = message.pendingTransactionProtocol === 'chicory.pending-tx/1';
        watch.walletOffersActive = message.walletOfferProtocol === 'chicory.offer/1';
        this._state('running', { height: state.height, validatedHeight: state.validatedHeight, tipHash: state.tipHash, tipSynced: state.tipSynced,
          historicalVerification: state.historicalVerification, historicalHeight: state.historicalHeight, historicalTarget: state.historicalTarget });
        heartbeat();
        ready.resolve(this.status());
      } finally { checking = false; }
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      if (stopping) return;
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const bytes = Buffer.byteLength(line) + 1;
          if (bytes > watch.partialLimit()) throw new Error();
          const message = JSON.parse(line);
          if (bytes > watch.replyLimit(message)) throw new Error();
          if (message.protocol === PROTOCOL) watch.receive(message);
          else observe(message).catch(() => fail(new Error('Could not verify local node health, network or storage.')));
        } catch { fail(new Error('The local node returned an invalid control message.')); return; }
      }
      if (Buffer.byteLength(pending) >= watch.partialLimit()) fail(new Error('The local node exceeded its status limit.'));
    });
    heartbeat();
    try {
      const exitCode = await new Promise((resolve, reject) => {
        child.on('error', () => {
          if (!child.pid) reject(new Error('Failed to start the verified local node.'));
          else fail(new Error('The local node process could not be controlled.'));
        });
        child.once('close', resolve);
      });
      if (signal.aborted && exitCode !== 0) this.stopError = new Error('The local node did not exit cleanly. Retry before changing its storage.');
      if (failure) throw failure;
      if (exitCode === 73) throw new Error('The local node data directory is in use by another process.');
      return !first;
    } finally {
      stopping = true;
      watch.close(new Error('The local node exited before confirming the watches.'));
      this.watch = null;
      connection.abort();
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
    }
  }
}

module.exports = { ManagedFloresta, removeOwnedData };
