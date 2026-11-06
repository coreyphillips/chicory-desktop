import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GuardError, PROFILE_PREFIX, REGTEST_GENESIS, RegtestGate, assertDisposableProfile, assertLoopback,
  assertRegtestAddress, assertRegtestChain, assertRegtestWallets, headerHash, productionProfiles } from './guards.mjs';
import { Recorder, dependencyVersions, packageEvidence, packageFiles, redact } from './evidence.mjs';

// Regtest genesis header, and mainnet's, as Electrum returns them.
const REGTEST_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000';
const MAINNET_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const regtest = { chain: 'regtest', genesis: REGTEST_GENESIS, electrumHeader: REGTEST_HEADER, electrum: { host: '127.0.0.1' } };

test('Electrum header hashes to the regtest genesis', () => {
  assert.equal(headerHash(REGTEST_HEADER), REGTEST_GENESIS);
  assert.throws(() => headerHash('00'), GuardError);
});

test('chain check requires both sources to agree on regtest', () => {
  assert.doesNotThrow(() => assertRegtestChain(regtest));
  assert.throws(() => assertRegtestChain({ ...regtest, chain: 'main' }), /chain main/);
  assert.throws(() => assertRegtestChain({ ...regtest, genesis: '00'.repeat(32) }), /not regtest/);
  assert.throws(() => assertRegtestChain({ ...regtest, electrumHeader: MAINNET_HEADER }), /Electrum genesis/);
});

test('only regtest addresses can be funded', () => {
  assert.doesNotThrow(() => assertRegtestAddress('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'));
  assert.doesNotThrow(() => assertRegtestAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'));
  for (const address of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', ''])
    assert.throws(() => assertRegtestAddress(address), GuardError, address);
});

test('managers containing another network are refused', () => {
  assert.doesNotThrow(() => assertRegtestWallets([]));
  assert.doesNotThrow(() => assertRegtestWallets([{ network: 'regtest' }]));
  assert.throws(() => assertRegtestWallets([{ network: 'regtest' }, { network: 'mainnet' }]), /mainnet wallet/);
  assert.throws(() => assertRegtestWallets(undefined), /malformed/);
});

test('remote Electrum is refused', () => {
  assert.doesNotThrow(() => assertLoopback('127.0.0.1', 'Electrum'));
  assert.doesNotThrow(() => assertLoopback('[::1]', 'Electrum'));
  assert.throws(() => assertLoopback('electrum.example.com', 'Electrum'), /loopback/);
});

test('profiles must be fresh suite directories away from production data', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ours = fs.mkdtempSync(path.join(tmp, PROFILE_PREFIX));
  assert.equal(assertDisposableProfile(ours, { tmp, production: [] }), fs.realpathSync(ours));
  fs.writeFileSync(path.join(ours, 'wallet.json'), '{}');
  assert.throws(() => assertDisposableProfile(ours, { tmp, production: [] }), /not empty/);
  assert.doesNotThrow(() => assertDisposableProfile(ours, { tmp, production: [], fresh: false }));
  const foreign = fs.mkdtempSync(path.join(tmp, 'other-'));
  assert.throws(() => assertDisposableProfile(foreign, { tmp, production: [] }), /not created by this suite/);
  assert.throws(() => assertDisposableProfile(tmp, { tmp, production: [] }), /outside/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => assertDisposableProfile(outside, { tmp, production: [] }), /outside/);
  const production = fs.mkdtempSync(path.join(tmp, PROFILE_PREFIX));
  assert.throws(() => assertDisposableProfile(production, { tmp, production: [production] }), /overlaps production/);
  assert.throws(() => assertDisposableProfile(production, { tmp, production: [path.join(production, 'Chicory Desktop')] }), /overlaps production/);
});

test('production profile locations match the desktop defaults', () => {
  assert.ok(productionProfiles({ platform: 'darwin', home: '/Users/a' })
    .includes(path.join('/Users/a/Library/Application Support', 'Chicory Desktop')));
  assert.ok(productionProfiles({ platform: 'linux', home: '/home/a', env: {} })
    .includes(path.join('/home/a/.config', 'Chicory Desktop')));
  assert.ok(productionProfiles({ platform: 'win32', home: 'C:/Users/a', env: { APPDATA: 'C:/Users/a/AppData/Roaming' } })
    .includes(path.join('C:/Users/a/AppData/Roaming', 'Chicory Desktop')));
});

test('funding and mining are refused before verification and rechecked after', () => {
  const calls = [];
  let chain = 'regtest';
  const rpc = (method, ...params) => {
    calls.push([method, ...params]);
    if (method === 'getblockchaininfo') return { chain };
    if (method === 'getnewaddress') return 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    return 'ok';
  };
  const gate = new RegtestGate({ rpc });
  assert.throws(() => gate.fund('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 1000), /before regtest verification/);
  assert.throws(() => gate.mine(1), /before regtest verification/);
  assert.equal(calls.length, 0);
  assert.throws(() => gate.verify({ ...regtest, managers: [[{ network: 'mainnet' }]] }), /mainnet wallet/);
  assert.equal(gate.verified, false);
  assert.throws(() => gate.verify({ ...regtest, electrum: { host: '10.0.0.2' } }), /loopback/);
  gate.verify({ ...regtest, managers: [[], [{ network: 'regtest' }]] });
  assert.equal(gate.fund('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 1000), 'ok');
  assert.deepEqual(calls.at(-1), ['sendtoaddress', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', '0.00001000']);
  assert.throws(() => gate.fund('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 1000), /non-regtest/);
  assert.throws(() => gate.fund('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 0.5), /Refusing to fund/);
  assert.throws(() => gate.mine(201), /Refusing to mine/);
  gate.mine(2);
  assert.deepEqual(calls.at(-1), ['generatetoaddress', 2, 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080']);
  chain = 'main';
  const before = calls.length;
  assert.throws(() => gate.mine(1), /switched to main/);
  assert.throws(() => gate.fund('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 1000), /switched to main/);
  assert.deepEqual(calls.slice(before).map(call => call[0]), ['getblockchaininfo', 'getblockchaininfo']);
});

test('reports redact secrets at any depth and keep public evidence', () => {
  const lines = [];
  const recorder = new Recorder({ log: line => lines.push(line) });
  recorder.pass('restore', { txid: 'ab', nested: [{ mnemonic: 'abandon abandon', sessionToken: 'x' }], paymentHash: 'cd' });
  recorder.unsupported('channel recovery', 'seed only');
  recorder.skip('suspend', 'manual');
  const report = recorder.report({ state: { recoveryPhrase: 'abandon', walletId: 'w1' } });
  const text = JSON.stringify(report) + lines.join('\n');
  assert.equal(text.includes('abandon'), false);
  assert.equal(text.includes('"x"'), false);
  assert.equal(report.state.walletId, 'w1');
  assert.equal(report.entries[0].details.txid, 'ab');
  assert.equal(report.entries[0].details.paymentHash, 'cd');
  assert.deepEqual(report.summary, { passed: 1, unsupported: 1, skipped: 1 });
  assert.deepEqual(redact({ cookie: 'c', amountSats: 1 }), { cookie: '[redacted]', amountSats: 1 });
});

test('dependency versions come from the lockfiles', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const versions = dependencyVersions(root);
  assert.match(versions.electron, /^\d+\.\d+\.\d+$/);
  assert.equal(versions.beignet, '0.38.0');
  assert.match(versions.tor, /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(versions.walletCore, /#[0-9a-f]{40}$/);
});

test('package files resolve per platform', () => {
  const resources = path.resolve('/A/Chicory.app/Contents/Resources');
  assert.deepEqual(packageFiles('/A/Chicory.app/Contents/MacOS/Chicory', 'darwin').slice(1, 3),
    [path.join(resources, 'app.asar'), path.join(resources, 'runtime/node/bin/node')]);
  assert.equal(packageFiles('/opt/chicory/chicory', 'linux')[1], path.join('/opt/chicory/resources', 'app.asar'));
  assert.deepEqual(packageFiles(undefined), []);
});

test('package evidence changes when any bundled engine file changes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-package-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.writeFileSync(path.join(directory, relative), text);
  };
  write('chicory-desktop', 'electron');
  write('resources/app.asar', 'asar');
  write('resources/server/desktop-bootstrap.js', 'bootstrap');
  write('resources/runtime/node/bin/node', 'node');
  write('resources/runtime/engine/node_modules/beignet/package.json', '{"version":"0.38.0"}');
  write('resources/runtime/engine/node_modules/beignet/dist/cli/cli.js', 'engine one');
  write('resources/runtime/tor/tor/tor', 'tor');
  const executable = path.join(directory, 'chicory-desktop');
  const before = packageEvidence(executable, 'linux');
  write('resources/runtime/engine/node_modules/beignet/dist/cli/cli.js', 'engine two');
  const after = packageEvidence(executable, 'linux');
  assert.notEqual(after.components['runtime/engine'].sha256, before.components['runtime/engine'].sha256);
  assert.notEqual(after.application.sha256, before.application.sha256);
  for (const name of ['app.asar', 'server', 'runtime/node', 'runtime/tor'])
    assert.equal(after.components[name].sha256, before.components[name].sha256, name);
  assert.equal(after.components['runtime/engine'].files, 2);
  assert.deepEqual(after.components.dist, { missing: true });
  assert.deepEqual(after.files.map(entry => entry.file), ['chicory-desktop', 'resources/app.asar', 'resources/runtime/node/bin/node',
    'resources/runtime/engine/node_modules/beignet/package.json']);
  assert.equal(JSON.stringify(after).includes(directory), false, 'no absolute local paths');
  assert.equal(packageEvidence(undefined), null);
});
