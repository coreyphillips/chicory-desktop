// Drives the packaged desktop app and its bundled engine through funded
// regtest flows. Every profile is a fresh temporary directory, and nothing is
// funded or mined until RegtestGate has verified the chain and every manager.
// See docs/desktop-qualification.md.
import assert from 'node:assert/strict';
import { execFileSync, fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { createHostWalletClient } from '../../web/platform/walletClient.ts';
import { PROFILE_PREFIX, RegtestGate, assertDisposableProfile, assertLoopback, assertRegtestWallets } from './guards.mjs';
import { Recorder, dependencyVersions, hostEvidence, packageEvidence, resourcesDirectory } from './evidence.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.CHICORY_ELECTRON_EXECUTABLE;
// Extra Chromium switches for the app, such as --password-store=gnome-libsecret
// on a CI keyring or --use-mock-keychain on a developer Mac.
const electronArgs = (process.env.CHICORY_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean);
const runtime = process.env.CHICORY_RUNTIME_DIR || (executable ? path.join(resourcesDirectory(executable), 'runtime') : path.join(root, '.runtime'));
const bitcoin = process.env.REGTEST_BITCOIN_CONTAINER ?? 'chicory-browser-regtest-bitcoin-1';
const electrum = { host: '127.0.0.1', port: Number(process.env.REGTEST_ELECTRUM_PORT ?? '62401'), tls: false };
const peerPort = Number(process.env.REGTEST_PEER_PORT ?? '3920');
const output = path.resolve(process.env.CHICORY_QUALIFY_OUTPUT || path.join(root, 'artifacts/qualification'));
// backup runs last: restoring a stale copy of the node may lead its peer to
// close the channel, which no later stage could use.
const ALL = ['preflight', 'payments', 'restart', 'crash', 'persistence', 'offline', 'max', 'drain', 'primaries', 'porch', 'recovery', 'transport', 'backup'];
const BACKUP_PASSPHRASE = 'regtest qualification full backup passphrase';
const stages = new Set((process.env.CHICORY_QUALIFY_STAGES || ALL.join(',')).split(',').map(item => item.trim()).filter(Boolean));
for (const stage of stages) assert.ok(ALL.includes(stage), `Unknown stage ${stage}`);
const record = new Recorder();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const profiles = [];
let peer;
let porch;

async function until(label, read, okay = Boolean, timeout = 180000) {
  const start = Date.now(); let last; let seen;
  while (Date.now() - start < timeout) {
    try { const value = await read(); if (okay(value)) return value; seen = value; last = undefined; } catch (error) { last = error; }
    await wait(1000);
  }
  // The last value read says why it never became ready, so it goes in the failure.
  const detail = last ? `: ${last.message}` : seen === undefined ? '' : `; last seen ${JSON.stringify(seen)?.slice(0, 2000)}`;
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

/** A Lightning send that the engine already reports as failed stops the run with its reason. */
function checkSent(label, result) {
  if (result?.status === 'failed') throw new Error(`${label} failed: ${JSON.stringify(result).slice(0, 1000)}`);
  return result;
}

function rpc(method, ...params) {
  const text = execFileSync('docker', ['exec', bitcoin, 'bitcoin-cli', '-datadir=/data', '-regtest', '-rpcwallet=chicory-test', method,
    ...params.map(value => typeof value === 'string' ? value : JSON.stringify(value))], { encoding: 'utf8' }).trim();
  try { return JSON.parse(text); } catch { return text; }
}
const gate = new RegtestGate({ rpc });

function electrumCall(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(electrum);
    let text = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Electrum timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    socket.on('data', bytes => {
      text += bytes.toString();
      if (!text.includes('\n')) return;
      socket.end();
      const reply = JSON.parse(text.split('\n')[0]);
      if (reply.error) reject(new Error(reply.error.message)); else resolve(reply.result);
    });
  });
}

async function profile(label) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${PROFILE_PREFIX}${label}-`));
  assertDisposableProfile(directory);
  profiles.push(directory);
  return directory;
}

function processTree() {
  if (process.platform === 'win32') {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8' }))
      .map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId }));
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/).map(Number)).map(([pid, parent]) => ({ pid, parent }));
}
function descendants(pid) {
  const rows = processTree(); const found = [pid];
  for (let index = 0; index < found.length; index++) found.push(...rows.filter(row => row.parent === found[index]).map(row => row.pid));
  return found;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The packaged app. Its renderer's fetch is the only route to its manager. */
class DesktopApp {
  constructor(directory) { this.profile = directory; }

  async open() {
    this.electron = await _electron.launch({
      executablePath: executable || electronPath, args: [...(executable ? [] : [path.join(root, 'desktop/main.cjs')]), ...electronArgs],
      // Only regtest wallets the suite makes itself: the app makes no mainnet wallet unasked.
      cwd: root, env: { ...process.env, CHICORY_PROFILE_DIR: this.profile, CHICORY_MANUAL_SETUP: '1' }, timeout: 30000,
    });
    this.page = await this.electron.firstWindow({ timeout: 30000 });
    this.page.setDefaultTimeout(20000);
    await this.page.waitForURL('chicory-app://wallet/?setup', { timeout: 30000 });
    await expect.poll(() => this.page.evaluate(async () => (await fetch('/api/config')).status), { timeout: 30000 }).toBe(200);
    return this;
  }

  fetch = async (input, init = {}) => {
    const reply = await this.page.evaluate(async ({ url, method, headers, body }) => {
      const response = await fetch(url, { method, headers, body });
      return { status: response.status, headers: [...response.headers], body: await response.text() };
    }, { url: String(input), method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers)), body: init.body ?? undefined });
    return new Response(reply.status === 204 ? null : reply.body, { status: reply.status, headers: reply.headers });
  };

  /** A binary response, base64 in transit, since the page reads text otherwise. */
  async bytes(input, body) {
    const reply = await this.page.evaluate(async ({ url, body }) => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = '';
      for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { status: response.status, base64: btoa(text) };
    }, { url: String(input), body: JSON.stringify(body) });
    if (reply.status !== 200) throw new Error(`HTTP ${reply.status}: ${Buffer.from(reply.base64, 'base64').toString('utf8').slice(0, 300)}`);
    return Buffer.from(reply.base64, 'base64');
  }

  async api(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await this.fetch(`/api${route}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const packet = await response.json();
    if (!response.ok || packet.ok === false) throw Object.assign(new Error(packet.error?.message ?? `HTTP ${response.status}`), { code: packet.error?.code });
    return packet.result;
  }

  // Quotes and reviews live in the client that made them, so each app session
  // keeps one client per wallet. A reopened app is a new DesktopApp.
  clients = new Map();
  client(walletId) {
    if (!this.clients.has(walletId)) this.clients.set(walletId, createHostWalletClient({ ...(walletId ? { walletId } : {}), fetch: this.fetch }));
    return this.clients.get(walletId);
  }

  /** The renderer selects a wallet only when it connects, so a wallet created outside it needs a reload. */
  async activate(walletId) {
    await this.page.reload();
    await expect(this.page.locator(`.browser-wallet-identity[data-wallet="${walletId}"]`)).toBeAttached({ timeout: 60000 });
    await expect(this.page.locator('[data-scene="send"]')).toBeEnabled({ timeout: 60000 });
  }

  /** A complete application quit, waiting until every child process has exited. */
  async quit() {
    // Taken now, so engines started since open are included.
    const pids = descendants(this.electron.process().pid);
    const closed = this.electron.waitForEvent('close', { timeout: 60000 });
    await this.electron.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    await closed;
    for (const pid of pids) await until(`process ${pid} exit`, async () => !alive(pid), Boolean, 30000);
  }

  /** An abrupt loss of the whole process tree, as in a crash or power loss. */
  async kill() {
    const pids = descendants(this.electron.process().pid);
    for (const pid of pids.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    for (const pid of pids) await until(`process ${pid} killed`, async () => !alive(pid), Boolean, 30000);
  }

  async holdToSend(request) {
    const page = this.page;
    await this.electron.evaluate(({ Menu, BrowserWindow }) => {
      const find = menu => { for (const item of menu?.items || []) { if (item.label === 'Send') return item; const nested = find(item.submenu); if (nested) return nested; } return null; };
      find(Menu.getApplicationMenu()).click(undefined, BrowserWindow.getAllWindows()[0], {});
    });
    await page.getByRole('textbox', { name: 'Payment request or address', exact: true }).fill(request);
    await page.getByRole('button', { name: 'Review payment', exact: true }).click();
    const hold = page.locator('[data-hold-confirmation]');
    await expect(hold).toBeVisible();
    const focused = () => page.evaluate(() => {
      const element = document.activeElement;
      return element ? `${element.tagName} ${element.getAttribute('aria-label') ?? ''}`.trim() : 'none';
    });
    // Press only once the hold itself has focus, and say where focus went if it moved.
    const press = async ms => {
      await hold.focus();
      await expect(hold, `hold focus (focus is on ${await focused()})`).toBeFocused();
      await page.keyboard.down('Enter'); await wait(ms); await page.keyboard.up('Enter');
    };
    // A Lightning review fills in its route fee after it appears. Let it settle.
    await wait(1500);
    // A short press must not submit. The deliberate hold below submits once.
    await press(150);
    await wait(1200);
    await expect(hold).toBeVisible();
    const before = await focused();
    await press(1600);
    await page.screenshot({ path: path.join(output, 'ui-hold-sent.png') });
    await expect(hold, `the deliberate hold commits (focus was on ${before} before it)`).toBeHidden({ timeout: 15000 });
    return { focusAfterShortPress: before };
  }
}

async function startPeer() {
  const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const data = await profile('peer');
  // The bundled engine opens only encrypted storage, so the peer starts the way
  // the desktop app starts its manager: through the bootstrap, keyed over IPC.
  const child = fork(path.join(root, 'server/desktop-bootstrap.js'), [], { execPath: node, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: {
    PATH: process.env.PATH, HOME: process.env.HOME, DATA_DIR: data, PORT: String(peerPort), DEFAULT_NETWORK: 'regtest',
    DEFAULT_ELECTRUM_HOST: electrum.host, DEFAULT_ELECTRUM_PORT: String(electrum.port), DEFAULT_ELECTRUM_TLS: 'false',
    CHILD_PORT_BASE: String(peerPort + 1), CHILD_PORT_MAX: String(peerPort + 50), CHICORY_ENCRYPTED_STORAGE: '1',
    BEIGNET_BIN: path.join(runtime, 'engine/node_modules/beignet/dist/cli/cli.js'),
  } });
  // Readiness comes only from this child, so another manager already on the
  // port can never stand in for the disposable peer.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The peer manager did not start')), 60000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`The peer manager exited with code ${code}`)); });
    child.on('message', message => {
      if (message?.type === 'startup-error') { clearTimeout(timer); reject(new Error(String(message.message))); }
      if (message?.type === 'ready') { clearTimeout(timer); resolve(message.port); }
    });
    child.send({ type: 'initialize-storage', key: randomBytes(32).toString('hex') });
  });
  const url = `http://127.0.0.1:${port}`;
  const fetchPeer = (input, init) => fetch(new URL(String(input), url), init);
  const call = async (route, body, method = 'POST') => {
    const response = await fetchPeer(route, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const packet = await response.json();
    if (!response.ok || packet.ok === false) throw new Error(packet.error?.message ?? `HTTP ${response.status}`);
    return packet.result;
  };
  const api = (route, body, method) => call(`/api${route}`, body, method);
  // The wallet client receives only into Lightning-first wallets, so a plain
  // wallet takes its deposit address from its own daemon.
  const address = async walletId => (await call(`/wallets/${encodeURIComponent(walletId)}/api/address/new`, {})).address;
  return { child, api, call, address, client: walletId => createHostWalletClient({ walletId, fetch: fetchPeer }) };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

/**
 * A Porch relay and a node that waits at it, both run from the bundled engine
 * with the bundled Node: `beignet porch-relay` on loopback, and a daemon that
 * has no Lightning listener, so its Porch link is the only way to reach it.
 * The app hosts no Porch link itself, so the node is a bare daemon outside
 * any manager, on its own encrypted database.
 */
async function startPorchHost() {
  const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const cli = path.join(runtime, 'engine/node_modules/beignet/dist/cli/cli.js');
  const base = { PATH: process.env.PATH };
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) base[key] = process.env[key];
  const children = [];
  const logs = [];
  const run = (label, args, env, cwd) => {
    const child = spawn(node, [cli, ...args], { env: { ...base, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = chunk => { logs.push(`[${label}] ${String(chunk).trim()}`.slice(0, 500)); if (logs.length > 60) logs.shift(); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    children.push(child);
    return child;
  };
  const stop = () => { for (const child of children) child.kill('SIGTERM'); };
  try {
    const relayPort = await freePort();
    const relayUrl = `ws://127.0.0.1:${relayPort}`;
    const home = await profile('porch-host');
    const relay = run('relay', ['porch-relay', '--url', relayUrl, '--port', String(relayPort), '--host', '127.0.0.1'], { HOME: home }, home);
    await until('Porch relay listening', () => new Promise((resolve, reject) => {
      if (relay.exitCode !== null) return reject(new Error(`the relay exited with code ${relay.exitCode}: ${logs.join(' | ')}`));
      const socket = net.connect({ host: '127.0.0.1', port: relayPort }, () => { socket.destroy(); resolve(true); });
      socket.on('error', reject);
    }), Boolean, 30000);
    const apiPort = await freePort();
    const token = randomBytes(32).toString('hex');
    const bip39 = createRequire(import.meta.url)(path.join(root, 'server/node_modules/bip39'));
    const daemon = run('host', ['start'], {
      HOME: home, BEIGNET_DATA_DIR: path.join(home, 'data'), BEIGNET_MNEMONIC: bip39.generateMnemonic(), BEIGNET_API_TOKEN: token,
      BEIGNET_NETWORK: 'regtest', BEIGNET_ALIAS: 'qualify porch host', BEIGNET_DAEMON_HOST: '127.0.0.1', BEIGNET_DAEMON_PORT: String(apiPort),
      BEIGNET_ELECTRUM_HOST: electrum.host, BEIGNET_ELECTRUM_PORT: String(electrum.port), BEIGNET_ELECTRUM_TLS: 'false',
      BEIGNET_LOG_LEVEL: 'warn', BEIGNET_AUTO_BOOTSTRAP: 'false',
      // The bundled engine opens only encrypted storage; the manager hands
      // its daemons their key the same way.
      CHICORY_DATABASE_KEY: randomBytes(32).toString('hex'),
      BEIGNET_PORCH_RELAYS: relayUrl,
    }, home);
    const call = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
      if (daemon.exitCode !== null) throw new Error(`the hosted node exited with code ${daemon.exitCode}: ${logs.join(' | ')}`);
      const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, { method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const packet = await response.json();
      if (!response.ok || packet.ok === false) throw Object.assign(new Error(packet.error?.message ?? `HTTP ${response.status}`), { code: packet.error?.code });
      return packet.result;
    };
    const info = await until('hosted node ready', () => call('/info'), value => !!value?.nodeId, 90000);
    assert.equal(info.listenPort, undefined, 'the hosted node has no Lightning listener');
    return { call, stop, relayUrl, relayPort, nodeId: info.nodeId, logs };
  } catch (error) {
    stop();
    throw error;
  }
}

const healthy = (api, id, lightning = true) => until(`wallet ${id} ready`, () => api(`/wallets/${id}`),
  value => value.healthy === true && (!lightning || value.lfbw?.setup === 'ready'));

async function fundWallet(client, sats, confirm = true) {
  const request = await client.receive(await client.quoteReceive({ amountSats: sats }));
  const txid = gate.fund(request.address, sats);
  if (confirm) gate.mine(1);
  return { address: request.address, txid };
}

// Channelizing starts once a deposit confirms, but its funding locks only at
// the engine's depth (three blocks by default), so blocks must keep coming.
const mining = read => () => { gate.mine(1); return read(); };

function mempoolPayment(address, sats) {
  for (const txid of rpc('getrawmempool')) {
    const tx = rpc('getrawtransaction', txid, true);
    if (tx.vout.some(out => out.scriptPubKey.address === address && (sats === undefined || Math.round(out.value * 1e8) === sats))) {
      const entry = rpc('getmempoolentry', txid);
      return { txid, feeSats: Math.round(entry.fees.base * 1e8), vsize: entry.vsize };
    }
  }
  return null;
}

const onePer = (activity, key, value) => activity.filter(item => item[key] === value);

let subject; let wallet; let state = {}; let original;
try {
  await fs.mkdir(output, { recursive: true });
  record.pass('host and package identified', { host: hostEvidence(), versions: dependencyVersions(root), package: packageEvidence(executable) });

  // Preflight: no wallet, address or block exists before every guard passes.
  assertLoopback(electrum.host, 'Electrum');
  subject = await new DesktopApp(await profile('subject')).open();
  original = subject.profile;
  const config = await subject.api('/config');
  const subjectWallets = await subject.api('/wallets');
  assert.deepEqual(subjectWallets, [], 'A fresh profile starts with zero wallets');
  peer = await startPeer();
  const peerWallets = await peer.api('/wallets');
  gate.verify({ chain: rpc('getblockchaininfo').chain, genesis: rpc('getblockhash', 0),
    electrumHeader: await until('Electrum ready', () => electrumCall('blockchain.block.header', [0])), electrum,
    managers: [subjectWallets, peerWallets] });
  record.pass('regtest-only guards passed before funding or mining', { engineVersion: config.engineVersion,
    capabilities: { offlineReceive: config.offlineReceiveAvailable, iroh: config.irohAvailable, recovery: config.recoveryAvailable, tor: config.torAvailable, primaries: config.primariesAvailable, channelSend: config.channelSendAvailable } });
  if ([...stages].every(stage => stage === 'preflight')) throw Object.assign(new Error('preflight only'), { done: true });

  // Peer: a funded primary and an independent payer, outside the desktop app.
  const run = Date.now().toString(36);
  const primary = (await peer.api('/wallets', { name: `qualify primary ${run}`, network: 'regtest', networkMode: 'clearnet', publicHost: '127.0.0.1', announce: true })).record;
  await healthy(peer.api, primary.id, false);
  gate.fund(await peer.address(primary.id), 5_000_000);
  gate.mine(1);
  const primaryRecord = await until('primary funded', () => peer.api(`/wallets/${primary.id}`), value => value.healthy && value.nodeId && value.listenPort);
  const primaryUri = `${primaryRecord.nodeId}@127.0.0.1:${primaryRecord.listenPort}`;
  const payerId = (await peer.api('/wallets', { name: `qualify payer ${run}`, network: 'regtest', lfbw: { enabled: true, primaryWalletId: primary.id, initialChannelSats: 300000 } })).record.id;
  await healthy(peer.api, payerId);
  const payer = peer.client(payerId);
  gate.mine(1);
  // The primary opens the payer's channel with nothing on the payer's side.
  await fundWallet(payer, 200000);
  await until('payer spendable', mining(() => payer.snapshot()), snap => snap.balance.availableSats >= 150000);

  // Subject: created through the app's own wallet client, as onboarding does.
  const created = await subject.client().createWallet({ name: `Qualify ${run}`, network: 'regtest', primaryUri, electrum });
  assertRegtestWallets(await subject.api('/wallets'));
  await healthy(subject.api.bind(subject), created.id);
  await subject.activate(created.id);
  wallet = () => subject.client(created.id);
  state = { walletId: created.id, primaryUri, payerId };

  if (stages.has('payments')) {
    const deposit = await fundWallet(wallet(), 400000, false);
    await until('pending on-chain receive', () => wallet().snapshot(), snap => snap.activity.some(item => item.txid === deposit.txid && item.status === 'pending'));
    gate.mine(1);
    const funded = await until('deposit channelized', mining(() => wallet().snapshot()), snap => snap.balance.availableSats >= 350000);
    record.pass('on-chain receive channelized into the home channel', { txid: deposit.txid, availableSats: funded.balance.availableSats });
    record.skip('direct funding', 'No payer here holds a confirmed coin outside its channel, so no send uses the request\'s funding envelope.');

    const incoming = await wallet().receive(await wallet().quoteReceive({ amountSats: 15000, description: 'qualify incoming' }));
    const paying = checkSent('payer Lightning send', await payer.send(await payer.prepareSend({ request: incoming.bolt11 })));
    // With no inbound capacity the primary opens a just-in-time channel on this
    // payment, which settles only once its funding confirms, so blocks keep coming.
    await until('Lightning receive settled', mining(async () => ({ status: await wallet().getReceiveStatus(incoming), paying,
      payer: onePer((await payer.snapshot()).activity, 'paymentHash', incoming.paymentHash) })), value => value.status.phase === 'completed');
    record.pass('Lightning receive settled', { paymentHash: incoming.paymentHash });

    const outgoing = await payer.receive(await payer.quoteReceive({ amountSats: 5000, description: 'qualify outgoing' }));
    const ui = await subject.holdToSend(outgoing.bolt11);
    await until('payee credited', () => payer.getReceiveStatus(outgoing), status => status.phase === 'completed');
    const sent = await until('sent row settled', () => wallet().snapshot(), snap => onePer(snap.activity, 'paymentHash', outgoing.paymentHash).some(item => item.status === 'completed'));
    assert.equal(onePer(sent.activity, 'paymentHash', outgoing.paymentHash).length, 1, 'One Activity row per payment');
    record.pass('Lightning send through the UI review and hold, one Activity row', { paymentHash: outgoing.paymentHash, ...ui });

    const destination = rpc('getnewaddress');
    const review = await wallet().prepareSend({ request: destination, amountSats: 20000, feeRate: 1 });
    const rates = review.feeRates;
    const faster = await wallet().prepareSend({ request: destination, amountSats: 20000, feeRate: Math.max(3, rates?.fast ?? 3) });
    assert.ok(faster.feeSats > review.feeSats, 'A higher fee rate reviews a higher fee');
    await wallet().send(faster);
    const broadcast = await until('reviewed on-chain output in mempool', async () => mempoolPayment(destination, 20000));
    assert.ok(broadcast.feeSats <= faster.feeSats, 'Broadcast fee stays within the review');
    gate.mine(1);
    await until('on-chain send confirmed', () => wallet().snapshot(), snap => snap.activity.some(item => item.txid === broadcast.txid && item.status === 'completed'));
    record.pass('on-chain send with adjustable fee rate confirmed', { ...broadcast, reviewedFeeSats: faster.feeSats, slowFeeSats: review.feeSats, feeRates: rates });
    state.history = (await wallet().snapshot()).activity.map(item => ({ id: item.id, amountSats: item.amountSats, status: item.status }));
  }

  if (stages.has('restart')) {
    const before = await wallet().snapshot();
    await subject.quit();
    subject = await new DesktopApp(subject.profile).open();
    await healthy(subject.api.bind(subject), state.walletId);
    const after = await until('history restored', () => wallet().snapshot(), snap => snap.activity.length >= before.activity.length);
    for (const row of before.activity.filter(item => item.status === 'completed')) {
      const match = after.activity.find(item => item.id === row.id);
      assert.ok(match && match.amountSats === row.amountSats && match.status === 'completed', `Row ${row.id} survives restart`);
    }
    record.pass('complete app restart preserves wallet identity and history', { rows: after.activity.length });
  }

  if (stages.has('crash') && process.platform === 'win32') {
    record.skip('crash during submission', 'Windows has no SIGSTOP, so the peer cannot be frozen to hold a payment in flight.');
  } else if (stages.has('crash')) {
    const held = await wallet().receive(await wallet().quoteReceive({ amountSats: 2100, description: 'qualify held request' }));
    const invoice = await payer.receive(await payer.quoteReceive({ amountSats: 3000, description: 'qualify crash send' }));
    const review = await wallet().prepareSend({ request: invoice.bolt11 });
    const hash = invoice.paymentHash.toLowerCase();
    // A frozen peer cannot settle, so the kill always lands between submission
    // and settlement. SIGSTOP does not exist on Windows.
    const frozen = descendants(peer.child.pid);
    for (const pid of frozen) process.kill(pid, 'SIGSTOP');
    try {
      let returned;
      void wallet().send(review).then(result => { returned = result; }, error => { returned = error; });
      await until('payment in flight', async () => {
        if (returned) throw new Error(`Send returned before the crash: ${returned.message}`);
        const packet = await (await subject.fetch(`/wallets/${encodeURIComponent(state.walletId)}/api/payments`)).json();
        return packet.result.some(item => item.direction === 'OUTGOING' && item.paymentHash?.toLowerCase() === hash && item.status === 'PENDING');
      }, Boolean, 30000);
      await subject.kill();
    } finally {
      for (const pid of frozen) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    }
    subject = await new DesktopApp(subject.profile).open();
    const wallets = await subject.api('/wallets');
    assert.deepEqual(wallets.map(item => item.id), [state.walletId], 'No silent replacement wallet');
    await healthy(subject.api.bind(subject), state.walletId);
    const rows = await until('outcome reconciled', async () => onePer((await wallet().snapshot()).activity, 'paymentHash', invoice.paymentHash),
      found => found.length > 0 && found.every(item => item.status !== 'pending'), 120000);
    assert.equal(rows.length, 1, 'One outgoing record for the submitted payment');
    const credited = rows[0].status === 'completed';
    const payee = await until('payee agrees with the recorded outcome', () => payer.getReceiveStatus(invoice), status => (status.phase === 'completed') === credited, 30000);
    // The reopened app starts with a fresh client, so the old review would be
    // refused locally. Submit the same invoice again through the manager: it
    // must be refused or come to nothing, and the payee is paid exactly once.
    let resend;
    try { resend = await wallet().send(await wallet().prepareSend({ request: invoice.bolt11 })); resend = { submitted: resend?.status ?? true }; }
    catch (error) { resend = { refused: error.code ?? error.message }; }
    const once = await until('the payee holds exactly one credit', async () => {
      const outgoing = onePer((await wallet().snapshot()).activity, 'paymentHash', invoice.paymentHash);
      const incoming = onePer((await payer.snapshot()).activity, 'paymentHash', invoice.paymentHash);
      return outgoing.some(item => item.status === 'pending') ? null : { outgoing, incoming };
    }, Boolean, 120000);
    assert.equal(once.incoming.filter(item => item.status === 'completed').length, 1, 'The payee is credited once');
    assert.equal(once.outgoing.filter(item => item.status === 'completed').length, 1, 'One completed outgoing payment');
    if (credited) assert.ok(resend.refused || once.outgoing.length === 1, 'A paid invoice is not paid again after a crash');
    // getReceiveStatus reports waiting even for a request the wallet no longer has.
    const saved = await (await subject.fetch(`/wallets/${encodeURIComponent(state.walletId)}/api/receive/requests`)).json();
    assert.ok(saved.result.requests.some(item => item.id === held.id && item.bolt11 === held.bolt11), 'Held request is still saved after the crash');
    await payer.send(await payer.prepareSend({ request: held.bolt11 }));
    await until('held request paid after the crash', () => wallet().getReceiveStatus(held), status => status.phase === 'completed');
    record.pass('crash during submission leaves one outcome and the held request', { payee: payee.phase, rows: rows.map(item => item.status), resend,
      paidOnce: { outgoing: once.outgoing.map(item => item.status), incoming: once.incoming.map(item => item.status) } });
  }

  if (stages.has('persistence')) {
    // Payments land while the whole app is killed, so the engine's encrypted
    // database and the manager's vault files are being written when it dies.
    const requests = [];
    for (let index = 1; index <= 5; index++)
      requests.push(await wallet().receive(await wallet().quoteReceive({ amountSats: 1000 + index, description: `qualify burst ${index}` })));
    const sends = requests.map(request => payer.prepareSend({ request: request.bolt11 })
      .then(review => payer.send(review)).catch(error => ({ refused: error.code ?? error.message })));
    await wait(600);
    await subject.kill();
    await Promise.allSettled(sends);
    subject = await new DesktopApp(subject.profile).open();
    await healthy(subject.api.bind(subject), state.walletId);
    const outcomes = await until('every burst payment settles one way or the other', async () => {
      const [mine, theirs] = await Promise.all([wallet().snapshot(), payer.snapshot()]);
      const rows = requests.map(request => ({
        received: onePer(mine.activity, 'paymentHash', request.paymentHash),
        paid: onePer(theirs.activity, 'paymentHash', request.paymentHash),
      }));
      return rows.every(row => ![...row.received, ...row.paid].some(item => item.status === 'pending')) ? rows : null;
    }, Boolean, 180000);
    for (const [index, row] of outcomes.entries()) {
      const credited = row.received.filter(item => item.status === 'completed').length;
      const paid = row.paid.filter(item => item.status === 'completed').length;
      assert.ok(credited <= 1, `Burst payment ${index + 1} is credited at most once`);
      assert.equal(credited, paid, `Burst payment ${index + 1}: the wallet agrees with the payer`);
    }
    record.pass('a crash while payments are written leaves an intact wallet that agrees with the payer', {
      payments: outcomes.map(row => ({ credited: row.received.filter(item => item.status === 'completed').length,
        paid: row.paid.filter(item => item.status === 'completed').length })) });
  }

  if (stages.has('offline')) {
    // Above the engine's offline minimum (5000 sats), so a refusal here is
    // about settlement, not the amount.
    const OFFLINE_SATS = 6000;
    // The primary does not settle offline receives yet, so this must refuse whatever the engine supports.
    const refusal = await wallet().quoteReceive({ amountSats: OFFLINE_SATS, mode: 'offline' }).then(() => null, error => error);
    assert.ok(refusal, 'Unsupported offline receive refuses');
    assert.doesNotMatch(String(refusal.message), /at least/, 'The refusal is about settlement, not the amount');
    const snap = await wallet().snapshot();
    assert.ok(!snap.offlineReservations?.length, 'Refusal leaves no reservation');
    const offline = (await subject.api('/config')).offlineReceiveAvailable === true;
    if (!offline) {
      record.unsupported('offline receive', 'Engine does not advertise offline receive; request refused without online downgrade');
    } else {
      record.pass('offline receive refused by a primary without settlement, no online downgrade', { refusal: refusal.code ?? refusal.message });
      await peer.api(`/wallets/${primary.id}`, { ffor: { settle: { enabled: true } } }, 'PATCH');
      await healthy(peer.api, primary.id, false);
      // The engine carries an offline receive on a channel where this wallet
      // holds nothing and the primary holds the amount plus a 50,000 sat
      // buffer, unless concurrent receive is negotiated. The primary opens one.
      const id = state.walletId;
      const listChannels = async () => (await (await subject.fetch(`/wallets/${encodeURIComponent(id)}/api/channels`)).json()).result;
      const nodeId = (await subject.api(`/wallets/${id}`)).nodeId;
      await until('primary opens a channel to the wallet', () => peer.call(`/wallets/${primary.id}/api/channel/open`, { pubkey: nodeId, amountSats: 150000 }));
      await until('the primary-opened channel is usable', mining(listChannels), list => Array.isArray(list) &&
        list.some(channel => channel.state === 'NORMAL' && channel.htlcUsable && channel.localBalanceSats === 0 && channel.remoteBalanceSats >= OFFLINE_SATS + 50000), 240000);
      // The Receive screen says how much an offline receive can take, and the
      // engine agrees: that much is quoted, one sat more is refused.
      const cap = (await until('offline receive capacity reported', () => wallet().snapshot(),
        value => value.balance.offlineReceivableSats > 0)).balance.offlineReceivableSats;
      const atCap = await until('an offline quote at the reported capacity', () => wallet().quoteReceive({ amountSats: cap, mode: 'offline' }));
      const over = await wallet().quoteReceive({ amountSats: cap + 1, mode: 'offline' }).then(() => null, error => error);
      assert.ok(over, `An offline receive over the reported ${cap} sats is refused`);
      record.pass('offline receive capacity reported, quoted in full and refused one sat over', { cap, quoted: atCap.amountSats, over: over.code ?? over.message });
      const quote = await until('settlement provider quotes offline receive', () => wallet().quoteReceive({ amountSats: OFFLINE_SATS, mode: 'offline', description: 'qualify offline' }))
        .catch(async error => { throw new Error(`${error.message}; channels ${JSON.stringify((await listChannels()).map(channel => ({ state: channel.state,
          usable: channel.htlcUsable, local: channel.localBalanceSats, remote: channel.remoteBalanceSats })))}`); });
      const request = await wallet().receive(quote);
      assert.equal(request.offlineReceive, true, 'Offline request is not downgraded');
      const balance = (await wallet().snapshot()).balance.totalSats;
      await subject.quit();
      const paid = await payer.send(await payer.prepareSend({ request: request.bolt11 }));
      await until('payer settled while app is closed', async () => (await payer.snapshot()).activity.some(item => item.paymentHash === request.paymentHash && item.status === 'completed'));
      for (const attempt of [1, 2]) {
        subject = await new DesktopApp(subject.profile).open();
        await healthy(subject.api.bind(subject), state.walletId);
        // Balance and Activity are separate reads, so wait for both before comparing.
        const snap = await until(`offline credit after reopen ${attempt}`, () => wallet().snapshot(),
          value => onePer(value.activity, 'paymentHash', request.paymentHash).some(item => item.status === 'completed') && value.balance.totalSats - balance >= OFFLINE_SATS);
        assert.equal(onePer(snap.activity, 'paymentHash', request.paymentHash).length, 1, 'One Activity row');
        assert.equal(snap.balance.totalSats - balance, OFFLINE_SATS, 'One credit');
        if (attempt === 1) await subject.quit();
      }
      record.pass('offline receive paid while the app was closed, one credit after two reopenings', { paymentHash: request.paymentHash, payer: paid.status });
    }
  }

  // The max and drain stages each take a wallet of their own in the same app,
  // funded only by a Lightning receive as a new wallet usually is: one home
  // channel, opened by the primary. The subject's channels after payments (one
  // it opened itself, one just-in-time) are not a shape either stage is about.
  const channelsOf = async id => (await (await subject.fetch(`/wallets/${encodeURIComponent(id)}/api/channels`)).json()).result;
  const freshWallet = async label => {
    const made = await subject.client().createWallet({ name: `Qualify ${label} ${run}`, network: 'regtest', primaryUri, electrum });
    assertRegtestWallets(await subject.api('/wallets'));
    await healthy(subject.api.bind(subject), made.id);
    const client = subject.client(made.id);
    const incoming = await client.receive(await client.quoteReceive({ amountSats: 30000, description: `qualify ${label}` }));
    checkSent(`payer pays the ${label} wallet`, await payer.send(await payer.prepareSend({ request: incoming.bolt11 })));
    await until(`${label} wallet's just-in-time receive settled`, mining(() => client.getReceiveStatus(incoming)), status => status.phase === 'completed');
    const channels = await channelsOf(made.id);
    assert.ok(channels.length === 1 && channels[0].isOpener === false, `The primary opened the ${label} wallet's only channel`);
    return { id: made.id, client, channel: channels[0] };
  };

  if (stages.has('max')) {
    // The primary waives the reserve of a wallet it opens a just-in-time
    // channel to, so send max over Lightning keeps nothing back.
    const maxed = await freshWallet('max');
    assert.equal(maxed.channel.localReserveWaived, true, 'The primary waived the wallet reserve');
    const invoice = await payer.receive(await payer.quoteReceive({ description: 'qualify max out' }));
    const quote = await maxed.client.quoteMax({ request: invoice.bolt11 });
    assert.equal(quote.keptSats, 0, `Send max keeps nothing back (kept ${quote.keptSats}, ${quote.keptReason})`);
    const sent = checkSent('send max', await maxed.client.send(await maxed.client.prepareSend({ request: invoice.bolt11, max: true })));
    await until('payee credited', () => payer.getReceiveStatus(invoice), status => status.phase === 'completed');
    const emptied = await until('max wallet emptied', () => maxed.client.snapshot(), snap => snap.balance.totalSats === 0);
    record.pass('Lightning send max emptied a wallet funded by a Lightning receive', {
      reserveWaived: maxed.channel.localReserveWaived, quote, sent: sent.status, balance: emptied.balance,
    });
  }

  if (stages.has('drain')) {
    const destination = rpc('getnewaddress');
    // Its home channel, and a coin below the channelize floor that stays loose.
    const drained = await freshWallet('drain');
    const loose = await fundWallet(drained.client, 10000);
    // The review covers the coins the wallet's own engine lists, which can trail
    // what Electrum already shows. Wait for the engine.
    await until('loose coin confirmed in the wallet', mining(async () => (await (await subject.fetch(`/wallets/${encodeURIComponent(drained.id)}/api/utxos`)).json()).result),
      coins => coins.some(coin => coin.txid === loose.txid && coin.height > 0));
    record.pass('send max quoted', await drained.client.quoteMax({ request: destination }));
    if ((await subject.api('/config')).drainAvailable !== true) {
      record.unsupported('two-leg drain', 'The manager does not advertise drainAvailable, so the wallet refuses to prepare a drain');
    } else {
      const review = await drained.client.prepareDrain({ address: destination });
      // A coin that arrives after the review, at an address the wallet already watches.
      const late = { txid: gate.fund(loose.address, 7000) };
      const result = await drained.client.send(review);
      const requestId = result.drain?.requestId ?? review.drain?.requestId;
      const drain = await until('two-leg drain completes', async () => { gate.mine(1); return drained.client.getDrain(requestId); },
        progress => progress.phase === 'completed', 300000);
      const after = await until('late deposit kept', () => drained.client.snapshot(), snap => snap.balance.totalSats >= 7000);
      assert.ok(after.balance.totalSats < 7000 + 1000, `Only the later deposit remains: ${JSON.stringify({ balance: after.balance, drain, channels: await channelsOf(drained.id) })}`);
      assert.ok(drain.txids?.length >= 2, 'Both drain legs have confirmed transaction references');
      for (const txid of drain.txids) assert.ok(rpc('getrawtransaction', txid, true).confirmations > 0, `Drain leg ${txid} confirmed`);
      const receivedSats = Math.round(rpc('getreceivedbyaddress', destination, 1) * 1e8);
      assert.equal(receivedSats, drain.amountSats, 'The destination received what the drain reports');
      state.drain = drain;
      record.pass('two-leg drain completed, later deposit excluded', { drain, lateDeposit: late.txid, loose: loose.txid, receivedSats, remainingSats: after.balance.totalSats });
    }
  }

  if (stages.has('primaries')) {
    // Several ranked primary nodes (coreyphillips/beignet#1924): a second node
    // on the peer manager, added through the wallet client as Settings >
    // Primary nodes does, takes a steered receive once the fill target puts it
    // first, and is removed with its channel kept.
    const current = await subject.api('/config');
    if (current.primariesAvailable !== true) {
      record.unsupported('several ranked primary nodes', `Bundled engine ${current.engineVersion} does not advertise ranked primaries`);
    } else {
      const second = (await peer.api('/wallets', { name: `qualify second primary ${run}`, network: 'regtest', networkMode: 'clearnet', publicHost: '127.0.0.1', announce: true })).record;
      await healthy(peer.api, second.id, false);
      // The second node provides liquidity (a just-in-time channel on a receive
      // it cannot otherwise take), as the first does for its dependents.
      await peer.api(`/wallets/${second.id}`, { liquidityProvider: true }, 'PATCH');
      await healthy(peer.api, second.id, false);
      gate.fund(await peer.address(second.id), 5_000_000);
      gate.mine(1);
      const secondRecord = await until('second primary funded', () => peer.api(`/wallets/${second.id}`), value => value.healthy && value.nodeId && value.listenPort && value.liquidityProvider === true);
      const secondUri = `${secondRecord.nodeId}@127.0.0.1:${secondRecord.listenPort}`;
      const before = await wallet().listPrimaries();
      assert.equal(before.primaries.length, 1, 'the wallet starts with its one primary');
      assert.equal(before.primaries[0].pubkey, primaryRecord.nodeId);
      const totalBefore = (await wallet().snapshot()).balance.totalSats;
      const added = await wallet().addPrimary({ uri: secondUri });
      assert.deepEqual(added.primaries.map(entry => [entry.rank, entry.pubkey]), [[1, primaryRecord.nodeId], [2, secondRecord.nodeId]], 'the engine ranks the new node last');
      const followed = await until('manager record follows the add', () => subject.api(`/wallets/${state.walletId}`),
        value => value.lfbw?.primaries?.length === 2 && value.lfbw.primaries.every(entry => entry.setup === 'ready') && !!value.lfbw.primariesSyncedAt);
      // A fill target under the home channel's balance puts the second node
      // first for the next receive that needs a channel.
      const steered = await wallet().setPrimariesThreshold(1000);
      assert.equal(steered.receiveTarget, secondRecord.nodeId, 'the second node is the receive target');
      await until('receive target mirrored', () => subject.api(`/wallets/${state.walletId}`), value => value.lfbw?.primariesReceiveTarget === secondRecord.nodeId);
      // A receive the home channel cannot take asks for a just-in-time channel;
      // the quote names no node, and the engine steers it to the second one. An
      // amount the home channel can take is a plain invoice either node can be
      // paid through, which names no node, as before.
      const room = (await wallet().snapshot()).balance.receivableSats;
      const plain = await wallet().quoteReceive({ amountSats: 1000, description: 'qualify plain' });
      const quote = await until('receive quoted at the second node', () => wallet().quoteReceive({ amountSats: room + 20000, description: 'qualify steered' }).catch(error => ({ refused: error.code ?? error.message })),
        value => value.peer === secondRecord.nodeId);
      // The second node opens the wallet's channel with it, zero-conf since the
      // wallet trusts every primary it keeps, and pays a request over it.
      const subjectRecord = await subject.api(`/wallets/${state.walletId}`);
      await peer.call(`/wallets/${second.id}/api/channel/connect-and-open`, { pubkey: subjectRecord.nodeId, host: '127.0.0.1', port: subjectRecord.listenPort, amountSats: 300000, trusted: true });
      const listed = await until('channel with the second node listed', mining(() => wallet().listPrimaries()), policy => policy.primaries[1]?.channelCount >= 1);
      const incoming = await wallet().receive(await wallet().quoteReceive({ amountSats: 30000, description: 'qualify second node' }));
      await peer.call(`/wallets/${second.id}/api/invoice/pay`, { bolt11: incoming.bolt11 });
      await until('steered receive settled', () => wallet().getReceiveStatus(incoming), status => status.phase === 'completed');
      const credited = await until('second node holds the receive', () => wallet().listPrimaries(), policy => policy.primaries[1]?.balanceSat >= 29000);
      // Cleared and removed: one primary again, the channel and its funds still the wallet's.
      await wallet().setPrimariesThreshold(null);
      const removed = await wallet().removePrimary(secondRecord.nodeId);
      assert.deepEqual(removed.primaries.map(entry => entry.pubkey), [primaryRecord.nodeId]);
      await until('manager record follows the remove', () => subject.api(`/wallets/${state.walletId}`), value => value.lfbw?.primaries?.length === 1 && value.lfbw.primaryPubkey === primaryRecord.nodeId);
      const after = await wallet().snapshot();
      assert.ok(after.balance.totalSats >= totalBefore + 29000, `the channel with the removed node still counts: ${after.balance.totalSats} against ${totalBefore} before`);
      record.pass('a second ranked primary added through the wallet client takes a steered receive and is removed with its channel kept', {
        primaries: listed.primaries.map(entry => ({ rank: entry.rank, pubkey: entry.pubkey, channelCount: entry.channelCount })),
        receiveTarget: steered.receiveTarget, steeredQuote: { peer: quote.peer, mode: quote.mode, amountSats: room + 20000, homeRoomSats: room }, plainQuoteNamesNoNode: plain.peer === undefined,
        paymentHash: incoming.paymentHash,
        secondBalanceSat: credited.primaries[1].balanceSat, managerEntries: followed.lfbw.primaries.map(entry => ({ pubkey: entry.pubkey, setup: entry.setup })),
        totalBefore, totalAfter: after.balance.totalSats });
      state.primaries = { second: secondRecord.nodeId };
    }
  }

  if (stages.has('porch')) {
    // A Porch link as a primary node (coreyphillips/beignet#1980): a node with
    // no listener of its own waits at a relay, and its link is pasted into
    // Settings > Primary nodes. The relay is on loopback and speaks plain
    // WebSocket, so this run says nothing of TLS to a relay or of a relay
    // reached through Tor.
    const current = await subject.api('/config');
    if (current.porchPrimaryAvailable !== true) {
      record.unsupported('a Porch link as a primary node', `Bundled engine ${current.engineVersion} does not route a Porch link's dial`);
    } else {
      porch = await startPorchHost();
      gate.fund((await porch.call('/address/new', {})).address, 2_000_000);
      gate.mine(1);
      const hosting = await until('hosted node waits at the relay', () => porch.call('/porch/links'),
        value => value.listening === true && value.relays?.[0]?.state === 'ready' && !!value.links?.[0]?.uris?.[0]);
      const link = hosting.links[0].uris[0];
      assert.match(link, new RegExp(`^${porch.nodeId}@ws://127\\.0\\.0\\.1:${porch.relayPort}/v1/p/[a-z2-7]{32}$`));
      await until('hosted node funded', async () => { await porch.call('/wallet/refresh', {}).catch(() => {}); return porch.call('/balance'); }, value => value.onchain >= 1_000_000);
      const walletApi = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
        const response = await subject.fetch(`/wallets/${encodeURIComponent(state.walletId)}/api${route}`, { method,
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const packet = await response.json();
        if (!response.ok || packet.ok === false) throw Object.assign(new Error(packet.error?.message ?? `HTTP ${response.status}`), { code: packet.error?.code });
        return packet.result;
      };
      const before = await wallet().listPrimaries();
      const totalBefore = (await wallet().snapshot()).balance.totalSats;
      // Pasted into Settings > Primary nodes, as a person would: the form says
      // who sees what before the link is saved, and offers no Tor fallback.
      const page = subject.page;
      await page.locator('[data-scene="settings"]').click();
      await page.getByRole('button', { name: /^Primary nodes/ }).first().click();
      await page.getByRole('button', { name: 'Add a primary node', exact: true }).click();
      await page.getByRole('textbox', { name: 'Node address', exact: true }).fill(link);
      await expect(page.getByText('A Porch link reaches the node through a relay', { exact: false })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Optional Tor fallback URI', exact: true })).toHaveCount(0);
      await page.screenshot({ path: path.join(output, 'ui-porch-link-entered.png') });
      await page.getByRole('button', { name: 'Save primary node', exact: true }).click();
      await expect(page.getByText('Primary node added.', { exact: false }).first()).toBeVisible({ timeout: 60000 });
      // The list names the node by its relay, never by the route id.
      const relayLabel = `ws://127.0.0.1:${porch.relayPort}`;
      await expect(page.getByText(relayLabel, { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: path.join(output, 'ui-porch-link-added.png') });
      const added = await wallet().listPrimaries();
      assert.deepEqual(added.primaries.map(entry => entry.pubkey), [...before.primaries.map(entry => entry.pubkey), porch.nodeId], 'the engine ranks the Porch node last');
      assert.equal(added.primaries.at(-1).uri, link, 'the engine keeps the link with its route');
      // The manager's record follows: the entry holds the link, is trusted
      // and dialed by its URL, and names no fallback.
      const followed = await until('manager record follows the Porch add', () => subject.api(`/wallets/${state.walletId}`), value => {
        const entry = value.lfbw?.primaries?.find(item => item.pubkey === porch.nodeId);
        return !!entry && entry.setup === 'ready' && entry.uri === link;
      });
      // until() hands back what it read, so each read is the one row wanted.
      const peerRow = await until('wallet connected through the relay', async () => (await walletApi('/peers')).find(item => item.pubkey === porch.nodeId),
        row => row?.transport === 'ws' && row.state === 'ready');
      const subjectRecord = await subject.api(`/wallets/${state.walletId}`);
      const seen = await until('hosted node sees the wallet through its link', async () => (await porch.call('/peers')).find(item => item.pubkey === subjectRecord.nodeId),
        row => !!row?.porch);
      assert.ok(String(seen.porch.relay).includes(`127.0.0.1:${porch.relayPort}`), `the hosted node names the relay the wallet came through: ${JSON.stringify(seen.porch)}`);
      // The hosted node opens a channel on the relayed connection (it has no
      // other way to the wallet's node from here: /channel/open dials nothing)
      // and pays over it once the funding has confirmed.
      await porch.call('/channel/open', { pubkey: subjectRecord.nodeId, amountSats: 300000 });
      const listed = await until('channel with the Porch node listed', mining(() => wallet().listPrimaries()), policy => policy.primaries.find(entry => entry.pubkey === porch.nodeId)?.channelCount >= 1);
      await until('channel with the Porch node usable', mining(() => walletApi('/channels')), list => list.some(channel => channel.peerPubkey === porch.nodeId && channel.htlcUsable));
      const pay = async bolt11 => porch.call('/invoice/pay', { bolt11 });
      const incoming = await walletApi('/invoice/create', { amountSats: 40000, description: 'qualify porch receive' });
      await until('hosted node pays the wallet', () => pay(incoming.bolt11).then(() => true));
      const credited = await until('Porch node holds the receive', () => wallet().listPrimaries(), policy => policy.primaries.find(entry => entry.pubkey === porch.nodeId)?.balanceSat >= 39000);
      // And back: an invoice of the hosted node's, paid by the wallet.
      const outgoing = await porch.call('/invoice/create', { amountSats: 5000, description: 'qualify porch send' });
      const sent = checkSent('send to the Porch node', await wallet().send(await until('route to the Porch node', () => wallet().prepareSend({ request: outgoing.bolt11 }), Boolean, 60000)));
      await until('send to the Porch node settled', () => wallet().snapshot(), snap => snap.activity.some(item => item.paymentHash === outgoing.paymentHash && item.kind === 'sent' && item.status === 'completed'));
      // Removed: the list is as it was, the channel and its funds still the wallet's.
      const removed = await wallet().removePrimary(porch.nodeId);
      assert.deepEqual(removed.primaries.map(entry => entry.pubkey), before.primaries.map(entry => entry.pubkey));
      await until('manager record follows the Porch remove', () => subject.api(`/wallets/${state.walletId}`), value => !value.lfbw?.primaries?.some(entry => entry.pubkey === porch.nodeId));
      const after = await wallet().snapshot();
      assert.ok(after.balance.totalSats >= totalBefore + 30000, `the channel with the removed Porch node still counts: ${after.balance.totalSats} against ${totalBefore} before`);
      record.pass('a Porch link pasted into Settings connects through the relay, takes a channel and pays both ways', {
        relay: porch.relayUrl, link: link.replace(/[a-z2-7]{32}$/, '<route id>'), peerTransport: peerRow.transport, hostSeesRelay: seen.porch.relay,
        managerEntry: (({ pubkey, setup, fallbackUri }) => ({ pubkey, setup, fallbackUri }))(followed.lfbw.primaries.find(entry => entry.pubkey === porch.nodeId)),
        channelCount: listed.primaries.find(entry => entry.pubkey === porch.nodeId).channelCount,
        receivedSats: 40000, porchBalanceSat: credited.primaries.find(entry => entry.pubkey === porch.nodeId).balanceSat,
        sentSats: 5000, sendStatus: sent.status, networkMode: subjectRecord.networkMode, totalBefore, totalAfter: after.balance.totalSats,
        notRun: ['TLS to a relay', 'a relay reached through Tor'] });
      state.porch = { nodeId: porch.nodeId };
    }
  }

  if (stages.has('recovery')) {
    const phrase = await wallet().getRecoveryPhrase();
    const before = await wallet().snapshot();
    const recoveryStatus = await wallet().getRecoveryStatus().catch(error => ({ error: error.code }));
    await subject.quit();
    const restored = subject = await new DesktopApp(await profile('restore')).open();
    const imported = await restored.client().createWallet({ name: 'Qualify restore', network: 'regtest', primaryUri: state.primaryUri, electrum, mnemonic: phrase });
    await healthy(restored.api.bind(restored), imported.id, false);
    const onchain = before.balance.pending.unconfirmedSats + before.balance.pending.confirmedSats;
    const snap = await until('restored on-chain balance', () => restored.client(imported.id).snapshot(), value => value.balance.totalSats > 0 && value.balance.totalSats >= onchain);
    record.pass('recovery phrase import in a fresh profile restores on-chain funds', { totalSats: snap.balance.totalSats, previousTotalSats: before.balance.totalSats });
    record.unsupported('Lightning channel recovery from seed only', 'A seed restore recovers on-chain funds. Channel state needs the engine Recovery Protocol or an encrypted backup.', { recoveryStatus });
  }

  if (stages.has('transport')) {
    const current = await subject.api('/config');
    // No Iroh connection can be opened where the engine predates Iroh or
    // the platform has no native module for it (macOS on x64).
    if (!current.irohAvailable) record.unsupported('Iroh direct, relay and onion fallback', current.irohUnavailable === 'module'
      ? `No Iroh module is bundled for ${process.platform}-${process.arch}, so an Iroh link is taken only with its onion fallback`
      : `Bundled engine ${current.engineVersion} does not advertise Iroh`);
    else record.skip('Iroh direct, relay and onion fallback', 'The harness reaches its primary over TCP on loopback and has no Iroh primary to sample. See docs/desktop-qualification.md.');
  }

  if (stages.has('backup')) {
    // A full backup taken while the channel is funded, made stale by a later
    // payment, and restored into a fresh profile with its own keys while the
    // original stays offline, as recovery on another computer would be.
    const id = state.walletId;
    // The recovery stage leaves a phrase-restored profile open; this needs the original.
    if (subject.profile !== original) {
      await subject.quit();
      subject = await new DesktopApp(original).open();
      await healthy(subject.api.bind(subject), id);
    }
    const exportedAt = await wallet().snapshot();
    // A full backup carries every wallet in the app, and the max and drain
    // stages each add one to it.
    const inApp = (await subject.api('/wallets')).map(item => item.id).sort();
    assert.ok(inApp.includes(id), 'The funded wallet is in the app being backed up');
    const archive = await subject.bytes('/api/backup/full/export', { passphrase: BACKUP_PASSPHRASE });
    assert.equal(archive.subarray(0, 12).toString(), 'CHICORYFULL1', 'A full backup file');
    const later = await payer.receive(await payer.quoteReceive({ amountSats: 1000, description: 'qualify after backup' }));
    checkSent('payment after the backup', await wallet().send(await wallet().prepareSend({ request: later.bolt11 })));
    await until('payment after the backup settled', () => payer.getReceiveStatus(later), status => status.phase === 'completed');
    await subject.quit();
    const restored = subject = await new DesktopApp(await profile('backup-restore')).open();
    const attempt = async (passphrase, bytes) => {
      try { return { result: await restored.api('/backup/full/restore', { passphrase, archive: bytes.toString('base64') }) }; }
      catch (error) { return { refused: error.code }; }
    };
    assert.equal((await attempt('not the backup passphrase', archive)).refused, 'BAD_PASSPHRASE');
    const tampered = Buffer.from(archive); tampered[tampered.length - 100] ^= 1;
    assert.equal((await attempt(BACKUP_PASSPHRASE, tampered)).refused, 'BAD_ARCHIVE');
    assert.deepEqual(await restored.api('/wallets'), [], 'Refused restores leave nothing');
    const { result } = await attempt(BACKUP_PASSPHRASE, archive);
    assert.deepEqual(result.restored.map(item => item.id).sort(), inApp, 'Every wallet in the backup comes back under its own identity');
    await restored.api(`/wallets/${id}/start`, {});
    await healthy(restored.api.bind(restored), id, false);
    const listChannels = async () => (await (await restored.fetch(`/wallets/${encodeURIComponent(id)}/api/channels`)).json()).result;
    const describe = list => list.map(channel => ({ state: channel.state, held: channel.restoreRecencyUnproven === true,
      usable: channel.htlcUsable === true, localSats: channel.localBalanceSats, capacitySats: channel.capacitySats }));
    const atBoot = describe(await until('restored channels loaded', listChannels, list => Array.isArray(list) && list.length > 0, 120000));
    // Reconnecting lets each peer show which channels are current: those may
    // resume, and the one the later payment moved on must not.
    await wait(30000);
    const afterReconnect = describe(await listChannels());
    assert.ok(afterReconnect.some(channel => channel.held || /ERRORED|CLOS/.test(String(channel.state))),
      `The channel the backup is behind on stays held or is closed by its peer: ${JSON.stringify({ atBoot, afterReconnect })}`);
    assert.ok(afterReconnect.every(channel => !(channel.held && channel.usable)), `A held channel takes no new payments: ${JSON.stringify(afterReconnect)}`);
    const history = (await restored.client(id).snapshot()).activity;
    const kept = exportedAt.activity.filter(row => row.status === 'completed' && history.some(item => item.id === row.id)).length;
    record.pass('full backup restored into a fresh profile; the stale channel stays held or is closed by its peer', {
      archiveBytes: archive.length, restoredWallets: result.restored.length, channelsAtBoot: atBoot, channelsAfterReconnect: afterReconnect,
      historyRowsKept: kept, staleBy: 'one payment after export' });
    state.backup = { restoredInto: 'fresh profile', channels: afterReconnect.length };
  }
} catch (error) {
  if (!error.done) {
    await subject?.page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    record.entries.push({ status: 'failed', check: 'run', error: String(error?.stack ?? error) });
    process.exitCode = 1;
  }
} finally {
  await subject?.quit().catch(() => subject?.kill().catch(() => {}));
  peer?.child.kill('SIGTERM');
  porch?.stop();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(record.report({ stages: [...stages], state }), null, 2) + '\n');
  console.log(`Report written to ${path.join(output, 'report.json')}`);
  // Profiles are kept for inspection only on request. They contain test wallets.
  if (process.env.CHICORY_QUALIFY_KEEP !== '1') for (const directory of profiles) await fs.rm(directory, { recursive: true, force: true });
}
