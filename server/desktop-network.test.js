'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { DesktopNetwork, configureDesktopNetwork, resolveElectrum, ensureTor, requiresTor, wantsTor, isOnionHost } = require('./desktop-network');

const onion = 'a'.repeat(56) + '.onion';
const nodeUri = '02' + 'a'.repeat(64) + '@' + onion + ':9735';
function transport() {
  const channel = new EventEmitter(); channel.connected = true; channel.sent = [];
  channel.send = (message, callback) => { channel.sent.push(message); callback?.(); };
  return channel;
}

test('Tor is warmed for every onion a record names: primaries, fallbacks, Electrum, Tor-only mode and guardians', () => {
  assert.equal(wantsTor({ lfbw: { primaryUri: nodeUri } }), true);
  assert.equal(wantsTor({ electrum: { host: onion } }), true);
  assert.equal(wantsTor({ networkMode: 'tor' }), true);
  assert.equal(wantsTor({ recovery: { guardians: [{ uri: nodeUri }] } }), true);
  assert.equal(wantsTor({ lfbw: { primaryUri: '02' + 'a'.repeat(64) + '@node.example:9735' } }), false);
  const irohUri = '02' + 'a'.repeat(64) + '@iroh:' + '8e'.repeat(32);
  assert.equal(wantsTor({ lfbw: { primaryUri: irohUri } }), false);
  assert.equal(wantsTor({ lfbw: { primaryUri: irohUri, primaryFallbackUri: nodeUri } }), true);
  assert.equal(isOnionHost('bad.onion'), true);
});

test('a start waits for Tor only when the wallet cannot run without it', () => {
  const irohUri = '02' + 'a'.repeat(64) + '@iroh:' + '8e'.repeat(32);
  const clearnet = '02' + 'b'.repeat(64) + '@node.example:9735';
  // Tor is the only way in.
  assert.equal(requiresTor({ networkMode: 'tor' }), true);
  assert.equal(requiresTor({ electrum: { host: onion } }), true);
  assert.equal(requiresTor({ lfbw: { primaryUri: nodeUri } }), true);
  assert.equal(requiresTor({ lfbw: { primaries: [{ uri: nodeUri }] } }), true);
  // An Iroh link this computer can dial needs its onion fallback only if Iroh fails.
  assert.equal(requiresTor({ lfbw: { primaryUri: irohUri, primaryFallbackUri: nodeUri } }, { irohAvailable: true }), false);
  // Without the Iroh module the fallback is the only way to that node.
  assert.equal(requiresTor({ lfbw: { primaryUri: irohUri, primaryFallbackUri: nodeUri } }, { irohAvailable: false }), true);
  assert.equal(requiresTor({ lfbw: { primaryUri: irohUri, primaryFallbackUri: nodeUri } }), true, 'Iroh is not assumed');
  // A wallet made on the old onion default, with an Iroh link added beside it.
  const both = { lfbw: { primaryUri: nodeUri, primaries: [{ uri: nodeUri }, { uri: irohUri }] } };
  assert.equal(requiresTor(both, { irohAvailable: true }), false);
  assert.equal(wantsTor(both), true, 'the onion primary still warms Tor');
  assert.equal(requiresTor({ lfbw: { primaries: [{ uri: nodeUri }, { uri: clearnet }] } }), false);
  assert.equal(requiresTor({ lfbw: { primaries: [{ uri: nodeUri }, { walletId: 'sibling', uri: null }] } }), false);
  assert.equal(requiresTor({ lfbw: { mode: 'internal', primaryWalletId: 'sibling', primaryFallbackUri: nodeUri } }), false);
  // Guardians are reached when recovery needs them, through the proxy.
  assert.equal(requiresTor({ lfbw: { primaryUri: clearnet }, recovery: { guardians: [{ uri: nodeUri }] } }), false);
  // No primary at all, or one Tor cannot reach either: nothing to wait for.
  assert.equal(requiresTor({}), false);
  assert.equal(requiresTor({ lfbw: { primaryUri: irohUri } }, { irohAvailable: false }), false);
});

test('private network replies must match a pending request and private endpoint', async t => {
  const channel = transport(); const network = new DesktopNetwork({ transport: channel }); t.after(() => network.close());
  const pending = network.request('tor:ensure'); const message = channel.sent[0];
  channel.emit('message', { type: 'tor:result', requestId: 'other', result: { host: '127.0.0.1', port: 9001 } });
  assert.equal(network.pending.size, 1);
  channel.emit('message', { type: 'tor:result', requestId: message.requestId, result: { host: '0.0.0.0', port: 9001 } });
  await assert.rejects(pending, /invalid local endpoint/);
});

test('private network requests time out or reject on parent disconnect', async t => {
  const channel = transport(); const network = new DesktopNetwork({ transport: channel, timeoutMs: 10 }); t.after(() => network.close());
  await assert.rejects(network.request('tor:ensure'), /did not become ready/);
  const pending = network.request('tor:ensure'); channel.emit('disconnect');
  await assert.rejects(pending, /disconnected/); assert.equal(network.pending.size, 0);
});

test('onion Electrum uses the private bridge and never changes clearnet TLS', async t => {
  const previous = process.env.DESKTOP_TOR_MANAGED; process.env.DESKTOP_TOR_MANAGED = '1';
  t.after(() => { if (previous === undefined) delete process.env.DESKTOP_TOR_MANAGED; else process.env.DESKTOP_TOR_MANAGED = previous; });
  const channel = transport(); const network = configureDesktopNetwork({ transport: channel }); t.after(() => network.close());
  const original = { host: 'electrum.example', port: 50002, tls: true, tlsVerify: true };
  assert.equal(await resolveElectrum(original), original); assert.equal(channel.sent.length, 0);
  const pending = resolveElectrum({ host: onion, port: 50001, tls: true });
  const request = channel.sent[0]; assert.equal(request.type, 'tor:bridge'); assert.equal(request.host, onion);
  channel.emit('message', { type: 'tor:result', requestId: request.requestId, result: { host: '127.0.0.1', port: 19384 } });
  const resolved = await pending;
  assert.equal(resolved.host, '127.0.0.1'); assert.equal(resolved.port, 19384); assert.equal(resolved.tls, false);
  assert.equal(resolved.onionHost, onion);
  await assert.rejects(resolveElectrum({ host: 'invalid.onion', port: 50001 }), /valid onion/);
});

test('an unavailable desktop Tor service cannot silently dial onion names directly', async t => {
  const previous = process.env.DESKTOP_TOR_MANAGED; delete process.env.DESKTOP_TOR_MANAGED;
  t.after(() => { if (previous !== undefined) process.env.DESKTOP_TOR_MANAGED = previous; });
  assert.equal(await ensureTor(), null);
  await assert.rejects(resolveElectrum({ host: onion, port: 50001 }), /requires the bundled desktop/);
});

test('public Tor status contains only bounded progress and a safe failure message', t => {
  const channel = transport(); const network = new DesktopNetwork({ transport: channel }); t.after(() => network.close());
  channel.emit('message', { type: 'tor:status', status: { phase: 'starting', progress: 35, host: 'secret' } });
  assert.deepEqual(network.status(), { phase: 'starting', progress: 35, error: null });
  channel.emit('message', { type: 'tor:status', status: { phase: 'failed', progress: 35, error: '/private/path cookie contents' } });
  assert.equal(network.status().error, 'Tor could not connect. Check the network and retry.');
  channel.emit('message', { type: 'tor:status', status: { phase: 'ready', progress: 9000 } });
  assert.equal(network.status().phase, 'failed');
});
