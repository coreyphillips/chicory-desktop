// Drives the packaged desktop app and its bundled engine through funded
// regtest flows. Every profile is a fresh temporary directory, and nothing is
// funded or mined until RegtestGate has verified the chain and every manager.
// See docs/desktop-qualification.md.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { createHostWalletClient } from '../../web/platform/walletClient.ts';
import { PROFILE_PREFIX, RegtestGate, assertDisposableProfile, assertLoopback, assertRegtestWallets } from './guards.mjs';
import { Recorder, dependencyVersions, hostEvidence, packageEvidence, resourcesDirectory } from './evidence.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.CHICORY_ELECTRON_EXECUTABLE;
const runtime = process.env.CHICORY_RUNTIME_DIR || (executable ? path.join(resourcesDirectory(executable), 'runtime') : path.join(root, '.runtime'));
const bitcoin = process.env.REGTEST_BITCOIN_CONTAINER ?? 'chicory-browser-regtest-bitcoin-1';
const electrum = { host: '127.0.0.1', port: Number(process.env.REGTEST_ELECTRUM_PORT ?? '62401'), tls: false };
const peerPort = Number(process.env.REGTEST_PEER_PORT ?? '3920');
const output = path.resolve(process.env.CHICORY_QUALIFY_OUTPUT || path.join(root, 'artifacts/qualification'));
const ALL = ['preflight', 'payments', 'restart', 'crash', 'offline', 'drain', 'recovery', 'transport'];
const stages = new Set((process.env.CHICORY_QUALIFY_STAGES || ALL.join(',')).split(',').map(item => item.trim()).filter(Boolean));
for (const stage of stages) assert.ok(ALL.includes(stage), `Unknown stage ${stage}`);
const record = new Recorder();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const profiles = [];
let peer;

async function until(label, read, okay = Boolean, timeout = 180000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const value = await read(); if (okay(value)) return value; } catch (error) { last = error; }
    await wait(1000);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
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
      executablePath: executable || electronPath, args: executable ? [] : [path.join(root, 'desktop/main.cjs')],
      cwd: root, env: { ...process.env, CHICORY_PROFILE_DIR: this.profile }, timeout: 30000,
    });
    this.page = await this.electron.firstWindow({ timeout: 30000 });
    this.page.setDefaultTimeout(20000);
    await this.page.waitForURL('chicory-app://wallet/', { timeout: 30000 });
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
    await expect(this.page.locator('#browser-wallet-selector')).toHaveValue(walletId, { timeout: 60000 });
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
    await hold.focus();
    // A short press must not submit. The deliberate hold below submits once.
    await page.keyboard.down('Enter'); await wait(150); await page.keyboard.up('Enter');
    await wait(1200);
    await expect(hold).toBeVisible();
    await page.keyboard.down('Enter'); await wait(1600); await page.keyboard.up('Enter');
    await page.screenshot({ path: path.join(output, 'ui-hold-sent.png') });
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
  return { child, api, address, client: walletId => createHostWalletClient({ walletId, fetch: fetchPeer }) };
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

let subject; let wallet; let state = {};
try {
  await fs.mkdir(output, { recursive: true });
  record.pass('host and package identified', { host: hostEvidence(), versions: dependencyVersions(root), package: packageEvidence(executable) });

  // Preflight: no wallet, address or block exists before every guard passes.
  assertLoopback(electrum.host, 'Electrum');
  subject = await new DesktopApp(await profile('subject')).open();
  const config = await subject.api('/config');
  const subjectWallets = await subject.api('/wallets');
  assert.deepEqual(subjectWallets, [], 'A fresh profile starts with zero wallets');
  peer = await startPeer();
  const peerWallets = await peer.api('/wallets');
  gate.verify({ chain: rpc('getblockchaininfo').chain, genesis: rpc('getblockhash', 0),
    electrumHeader: await until('Electrum ready', () => electrumCall('blockchain.block.header', [0])), electrum,
    managers: [subjectWallets, peerWallets] });
  record.pass('regtest-only guards passed before funding or mining', { engineVersion: config.engineVersion,
    capabilities: { offlineReceive: config.offlineReceiveAvailable, iroh: config.irohAvailable, recovery: config.recoveryAvailable, tor: config.torAvailable } });
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
    await payer.send(await payer.prepareSend({ request: incoming.bolt11 }));
    await until('Lightning receive settled', () => wallet().getReceiveStatus(incoming), status => status.phase === 'completed');
    record.pass('Lightning receive settled', { paymentHash: incoming.paymentHash });

    const outgoing = await payer.receive(await payer.quoteReceive({ amountSats: 5000, description: 'qualify outgoing' }));
    await subject.holdToSend(outgoing.bolt11);
    await until('payee credited', () => payer.getReceiveStatus(outgoing), status => status.phase === 'completed');
    const sent = await until('sent row settled', () => wallet().snapshot(), snap => onePer(snap.activity, 'paymentHash', outgoing.paymentHash).some(item => item.status === 'completed'));
    assert.equal(onePer(sent.activity, 'paymentHash', outgoing.paymentHash).length, 1, 'One Activity row per payment');
    record.pass('Lightning send through the UI review and hold, one Activity row', { paymentHash: outgoing.paymentHash });

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

  if (stages.has('crash')) {
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
    await assert.rejects(() => wallet().send(review), 'A reviewed payment cannot be resent after a crash');
    // getReceiveStatus reports waiting even for a request the wallet no longer has.
    const saved = await (await subject.fetch(`/wallets/${encodeURIComponent(state.walletId)}/api/receive/requests`)).json();
    assert.ok(saved.result.requests.some(item => item.id === held.id && item.bolt11 === held.bolt11), 'Held request is still saved after the crash');
    await payer.send(await payer.prepareSend({ request: held.bolt11 }));
    await until('held request paid after the crash', () => wallet().getReceiveStatus(held), status => status.phase === 'completed');
    record.pass('crash during submission leaves one outcome and the held request', { payee: payee.phase, rows: rows.map(item => item.status) });
  }

  if (stages.has('offline')) {
    // The primary does not settle offline receives yet, so this must refuse whatever the engine supports.
    await assert.rejects(() => wallet().quoteReceive({ amountSats: 4000, mode: 'offline' }), 'Unsupported offline receive refuses');
    const snap = await wallet().snapshot();
    assert.ok(!snap.offlineReservations?.length, 'Refusal leaves no reservation');
    const offline = (await subject.api('/config')).offlineReceiveAvailable === true;
    if (!offline) {
      record.unsupported('offline receive', 'Engine does not advertise offline receive; request refused without online downgrade');
    } else {
      record.pass('offline receive refused by a primary without settlement, no online downgrade');
      await peer.api(`/wallets/${primary.id}`, { ffor: { settle: { enabled: true } } }, 'PATCH');
      await healthy(peer.api, primary.id, false);
      const quote = await until('settlement provider quotes offline receive', () => wallet().quoteReceive({ amountSats: 4000, mode: 'offline', description: 'qualify offline' }));
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
          value => onePer(value.activity, 'paymentHash', request.paymentHash).some(item => item.status === 'completed') && value.balance.totalSats - balance >= 4000);
        assert.equal(onePer(snap.activity, 'paymentHash', request.paymentHash).length, 1, 'One Activity row');
        assert.equal(snap.balance.totalSats - balance, 4000, 'One credit');
        if (attempt === 1) await subject.quit();
      }
      record.pass('offline receive paid while the app was closed, one credit after two reopenings', { paymentHash: request.paymentHash, payer: paid.status });
    }
  }

  if (stages.has('drain')) {
    const destination = rpc('getnewaddress');
    const max = await wallet().quoteMax({ request: destination });
    record.pass('send max quoted', max);
    if ((await subject.api('/config')).drainAvailable !== true) {
      record.unsupported('two-leg drain', 'The manager does not advertise drainAvailable, so the wallet refuses to prepare a drain');
    } else {
      const review = await wallet().prepareDrain({ address: destination });
      const late = await fundWallet(wallet(), 7000, false);
      const result = await wallet().send(review);
      const drain = await until('two-leg drain completes', async () => { gate.mine(1); return wallet().getDrain(result.drain?.requestId ?? review.drain?.requestId); },
        progress => progress.phase === 'completed', 300000);
      const after = await until('late deposit kept', () => wallet().snapshot(), snap => snap.balance.totalSats >= 7000);
      assert.ok(after.balance.totalSats < 7000 + 1000, 'Only the later deposit remains');
      assert.ok(drain.txids?.length >= 2, 'Both drain legs have confirmed transaction references');
      for (const txid of drain.txids) assert.ok(rpc('getrawtransaction', txid, true).confirmations > 0, `Drain leg ${txid} confirmed`);
      state.drain = drain;
      record.pass('two-leg drain completed, later deposit excluded', { drain, lateDeposit: late.txid, remainingSats: after.balance.totalSats });
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
    if (!current.irohAvailable) record.unsupported('Iroh direct, relay and onion fallback', `Bundled engine ${current.engineVersion} does not advertise Iroh`);
    else record.skip('Iroh direct, relay and onion fallback', 'Transport evidence requires the engine to report its active path. See docs/desktop-qualification.md.');
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
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(record.report({ stages: [...stages], state }), null, 2) + '\n');
  console.log(`Report written to ${path.join(output, 'report.json')}`);
  // Profiles are kept for inspection only on request. They contain test wallets.
  if (process.env.CHICORY_QUALIFY_KEEP !== '1') for (const directory of profiles) await fs.rm(directory, { recursive: true, force: true });
}
