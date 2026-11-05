// Disposable proof peer and watch-only Floresta. No Chicory profile is opened.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { probe, readFixture } from './floresta-electrum.mjs';
import { REGTEST_GENESIS } from './guards.mjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block, Transaction, networks, opcodes, payments, script } = requireServer('bitcoinjs-lib');
const network = networks.regtest;
const host = '127.0.0.1';
const children = [];
const cancel = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cancel.abort(new Error(signal)));

async function ports(count) {
  const reservations = [];
  try {
    for (let i = 0; i < count; i++) {
      const socket = net.createServer();
      reservations.push(socket);
      socket.listen(0, host);
      await once(socket, 'listening');
    }
    return reservations.map(socket => socket.address().port);
  } finally {
    await Promise.all(reservations.map(socket => new Promise(resolve => socket.close(resolve))));
  }
}

function start(name, bin, args, cwd, env) {
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, output: '', stopped: false };
  function log(chunk) { state.output = (state.output + chunk).slice(-8192); }
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  state.closed = new Promise(resolve => child.once('close', (code, signal) => {
    state.stopped = true;
    cancel.abort(new Error(`${name} exited (${signal || code}): ${state.output}`));
    resolve();
  }));
  child.once('error', error => cancel.abort(error));
  children.push(state);
  return state;
}

async function stop(state) {
  if (state.stopped) return;
  state.child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
  const timer = setTimeout(() => state.child.kill('SIGKILL'), 5000);
  try { await state.closed; } finally { clearTimeout(timer); }
}

function rpcClient(port, password) {
  const headers = { 'Content-Type': 'application/json' };
  if (password) headers.Authorization = `Basic ${Buffer.from(`lab:${password}`).toString('base64')}`;
  return async (method, params = []) => {
    cancel.signal.throwIfAborted();
    const response = await fetch(`http://${host}:${port}/`, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(30000)]),
      body: JSON.stringify({ jsonrpc: '1.0', method, params, id: 1 })
    });
    const reply = await response.json();
    if (!response.ok || reply.error) throw new Error(`${method}: ${reply.error?.message || response.status}`);
    return reply.result;
  };
}

async function until(label, ready, timeout = 90000) {
  console.error(label);
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    cancel.signal.throwIfAborted();
    try { if (await ready()) return; } catch (error) { last = error; }
    await sleep(300, undefined, { signal: cancel.signal });
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

async function assertRegtest(rpc) {
  assert.equal((await rpc('getblockchaininfo')).chain, 'regtest');
  assert.equal(await rpc('getblockhash', [0]), REGTEST_GENESIS);
}

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function lab(root, florestad, utreexod) {
  const env = { HOME: root, APPDATA: root, LOCALAPPDATA: root, TMPDIR: root, TEMP: root, TMP: root };
  if (process.platform === 'win32') env.SystemRoot = process.env.SystemRoot;
  const version = bin => execFileSync(bin, ['--version'], { env, cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  const versions = { florestad: version(florestad), utreexod: version(utreexod) };
  assert.match(versions.florestad, /^florestad v?0\.9\.1$/i);
  assert.equal(versions.utreexod, 'utreexod version 0.6.0');
  const binarySha256 = { florestad: await sha256(florestad), utreexod: await sha256(utreexod) };
  const [peerPort, peerRpc, nodeRpc, electrumPort] = await ports(4);
  const password = randomBytes(32).toString('hex');
  const proof = rpcClient(peerRpc, password);
  const local = rpcClient(nodeRpc);
  const miner = payments.p2sh({ network, redeem: { output: Buffer.from([opcodes.OP_TRUE]) } });
  const watched = payments.p2wsh({ network, redeem: { output: script.compile([randomBytes(16), opcodes.OP_DROP, opcodes.OP_TRUE]) } });
  const peerConf = path.join(root, 'peer.conf');
  const nodeConf = path.join(root, 'node.toml');
  await fs.writeFile(peerConf, `rpcuser=lab\nrpcpass=${password}\n`, { mode: 0o600 });
  await fs.writeFile(nodeConf, `[wallet]\nxpubs = []\ndescriptors = []\naddresses = ["${watched.address}"]\n`, { mode: 0o600 });
  start('utreexod', utreexod, [
    '--regtest', '--nodnsseed', '--noonion', '--nobdkwallet', '--notls', '--cfilters', '--v2transport', '--trickleinterval=100ms',
    '--utreexoproofindex', '--prune=0', `--miningaddr=${miner.address}`, `--listen=${host}:${peerPort}`,
    `--connect=${host}:${peerPort}`, // Suppress automatic outbound peers. Floresta dials in.
    `--rpclisten=${host}:${peerRpc}`, `--configfile=${peerConf}`, `--datadir=${path.join(root, 'peer')}`, `--logdir=${root}`
  ], root, env);
  await until('Starting the private regtest proof peer', async () => !!await proof('getblockchaininfo'));
  await assertRegtest(proof);
  assert.equal(await proof('getblockcount'), 0);
  const mined = await proof('generate', [101]);
  assert.equal(mined.length, 101);
  const node = start('florestad', florestad, [
    '--network', 'regtest', '--disable-dns-seeds', '--connect', `${host}:${peerPort}`, '--config-file', nodeConf,
    '--data-dir', path.join(root, 'node'), '--rpc-address', `${host}:${nodeRpc}`, '--electrum-address', `${host}:${electrumPort}`
  ], root, env);
  // Require our own child's bind announcements before using its unauthenticated endpoints.
  await until('Starting the private Floresta listeners', () => node.output.includes(`RPC server is running at ${host}:${nodeRpc}`)
    && node.output.includes(`Electrum Server is running at ${host}:${electrumPort}`));
  await assertRegtest(local);
  async function validated(height, hash) {
    await until(`Waiting for Floresta to validate regtest block ${height}`, async () => {
      const tip = await local('getblockchaininfo');
      return tip.height === height && tip.validated === height && tip.best_block === hash && !tip.ibd;
    });
  }
  await validated(101, mined.at(-1));
  const firstBlock = Block.fromHex(await proof('getblock', [mined[0], 0]));
  const parent = firstBlock.transactions[0];
  const vout = parent.outs.findIndex(out => out.script.equals(miner.output));
  assert(parent.isCoinbase() && vout >= 0);
  const funding = new Transaction();
  funding.addInput(parent.getHash(), vout, 0xfffffffd, script.compile([miner.redeem.output]));
  funding.addOutput(miner.output, parent.outs[vout].value - 52000);
  funding.addOutput(miner.output, 1000);
  funding.addOutput(watched.output, 50000);
  await assertRegtest(proof);
  assert.equal(await proof('sendrawtransaction', [funding.toHex()]), funding.getId());
  assert((await proof('getrawmempool')).includes(funding.getId()));
  const fixture = {
    network: 'regtest', scriptPubKey: watched.output.toString('hex'), parents: [parent.toHex()]
  };
  // Allow the connected peer to announce the transaction before taking the pending snapshot.
  await sleep(10000, undefined, { signal: cancel.signal });
  const pending = await probe(electrumPort, readFixture({ ...fixture, transactions: [{ hex: funding.toHex(), height: 0 }] }));
  await assertRegtest(proof);
  const [blockHash] = await proof('generate', [1]);
  const block = Block.fromHex(await proof('getblock', [blockHash, 0]));
  const position = block.transactions.findIndex(tx => tx.getId() === funding.getId());
  assert.equal(position, 1, 'Fixture must distinguish block position 1 from output 2');
  await validated(102, blockHash);
  const confirmed = await probe(electrumPort, readFixture({ ...fixture,
    transactions: [{ hex: funding.toHex(), height: 102, blockHash, position }] }));

  const anonymous = await fetch(`http://${host}:${nodeRpc}/`, {
    method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '1.0', method: 'getblockchaininfo', params: [], id: 2 }),
    redirect: 'error', signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)])
  });
  let authorization = 'blocked';
  if ([401, 403].includes(anonymous.status)) authorization = 'passed';
  else if (anonymous.ok && (await anonymous.json()).result?.best_block === blockHash) authorization = 'failed';
  confirmed.rows.push({ check: 'Control RPC denies unauthenticated browser-origin POST', status: authorization,
    detail: `Anonymous text/plain POST returned HTTP ${anonymous.status}` });
  console.log(JSON.stringify({ versions, binarySha256, height: 102, blockHash, txid: funding.getId(), position, vout: 2,
    qualified: false, pending, confirmed }, null, 2));
  return [...pending.rows, ...confirmed.rows].some(row => row.status === 'failed') ? 1 : 2;
}

const { values } = parseArgs({ options: { florestad: { type: 'string' }, utreexod: { type: 'string' } } });
if (!values.florestad || !values.utreexod) throw new Error('Supply --florestad <binary> --utreexod <binary>');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-lab-'));
try {
  process.exitCode = await lab(root, path.resolve(values.florestad), path.resolve(values.utreexod));
} catch (error) {
  console.error(cancel.signal.aborted ? cancel.signal.reason.message : error.message);
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stop));
  await fs.rm(root, { recursive: true, force: true });
}
