'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { createRequire } = require('node:module');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { KEY, CERT, PIN } = require('./fixtures/electrum-test-cert');

const engine = path.resolve(__dirname, '../.runtime/engine/node_modules/beignet');
const available = fs.existsSync(path.join(engine, 'package.json'));
const requireEngine = createRequire(path.join(engine, 'package.json'));
const policyName = 'rn-electrum-client/helpers/chicory-endpoint-policy.cjs';

function configure(t, file, values) {
  for (const [key, value] of Object.entries(values)) setEnv(t, key, value);
  delete require.cache[file];
  t.after(() => { delete require.cache[file]; });
  return require(file);
}

function setEnv(t, key, value) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

function selected(network, port, useTls = false) {
  return { CHICORY_ELECTRUM_POLICY: 'selected-only', BEIGNET_NETWORK: network, BEIGNET_ELECTRUM_HOST: 'electrum.test',
    BEIGNET_ELECTRUM_TLS: String(useTls), BEIGNET_ELECTRUM_PORT: String(port) };
}

test('selected-only policy refuses incomplete, overridden or unbridged settings before DNS', async t => {
  const file = require.resolve('../scripts/engine-endpoint-policy.cjs');
  for (const invalid of [{ BEIGNET_NETWORK: 'typo' }, { BEIGNET_ELECTRUM_HOST: undefined },
    { BEIGNET_ELECTRUM_HOST: 'service.onion' }, { BEIGNET_ELECTRUM_PORT: '42x' }, { BEIGNET_ELECTRUM_TLS: '' },
    { CHICORY_ELECTRUM_POLICY: 'unknown' }]) {
    await t.test(`rejects invalid ${Object.keys(invalid)[0]}`, sub => {
      assert.throws(() => configure(sub, file, { ...selected('regtest', 50001), ...invalid }));
    });
  }
  const policy = configure(t, file, selected('regtest', 50001));
  let attempts = 0;
  const resolve = async () => { attempts++; return '127.0.0.1'; };
  for (const args of [['mainnet', 'electrum.test', 50001, false], ['regtest', 'other.test', 50001, false],
    ['regtest', 'electrum.test', 50002, false], ['regtest', 'electrum.test', 50001, true]]) {
    await assert.rejects(policy.resolveHost(...args, resolve), /conflicts/);
  }
  assert.equal(attempts, 0);
  assert.equal(policy.allows('bitcoinRegtest', '127.0.0.1', 50001, 'tcp'), false);
});

test('prepared engine retains external server selection and fee behavior when the policy is unset', { skip: !available }, async t => {
  const { patchEngineEndpointPolicy } = await import('../scripts/apply-engine-endpoint-policy.mjs');
  assert.deepEqual(patchEngineEndpointPolicy(engine, { verifyOnly: true }), { changed: false });
  configure(t, requireEngine.resolve(policyName), { CHICORY_ELECTRUM_POLICY: undefined });
  const { Wallet, generateMnemonic } = requireEngine('beignet');
  const requested = { host: '127.0.0.1', port: 50001, tcp: 50001, ssl: 0, protocol: 'tcp' };
  const wallet = new Wallet({ mnemonic: generateMnemonic(), network: 'bitcoin', electrumOptions: { net, tls, servers: requested } });
  const fallback = wallet.electrum.getServerCandidates([requested], 'bitcoin');
  assert.deepEqual(fallback[0], requested);
  assert.ok(fallback.length > 1);
  assert.equal(wallet.feeEstimationSource, 'auto');
  const http = t.mock.method(global, 'fetch', async () => ({ json: async () => ({ fastestFee: 12, halfHourFee: 8, hourFee: 4, minimumFee: 1 }) }));
  assert.equal((await wallet.fetchFeeEstimates()).fast, 12);
  assert.equal(http.mock.callCount(), 1);
});

test('prepared engine restricts Electrum reconnects and fee sources on each wallet network', { skip: !available }, async t => {
  for (const [network, transportNetwork, useTls] of [
    ['mainnet', 'bitcoin', true], ['regtest', 'bitcoinRegtest', false],
    ['testnet', 'bitcoinTestnet', false], ['signet', 'bitcoinSignet', false],
  ]) {
    await t.test(network, async sub => {
      const sockets = new Set();
      const methods = [];
      const accept = socket => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        const lines = createInterface({ input: socket });
        // A deliberate client disconnect can reset the test socket while the
        // reader is still waiting for its next line.
        lines.on('error', err => { if (err.code !== 'ECONNRESET') throw err; });
        lines.on('line', line => {
          const requests = JSON.parse(line);
          const respond = ({ id, method }) => {
            methods.push(method);
            const replies = { 'server.version': ['fixture', '1.4'], 'server.ping': null,
              'blockchain.headers.subscribe': { height: 0, hex: '00'.repeat(80) },
              'blockchain.scripthash.get_balance': { confirmed: 0, unconfirmed: 0 },
              'blockchain.estimatefee': 0.00012 };
            return { jsonrpc: '2.0', id, result: replies[method] };
          };
          socket.write(JSON.stringify(Array.isArray(requests) ? requests.map(respond) : respond(requests)) + '\n');
        });
      };
      const server = useTls ? tls.createServer({ key: KEY, cert: CERT }, accept) : net.createServer(accept);
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      sub.after(() => {
        for (const socket of sockets) socket.destroy();
        return new Promise(resolve => server.close(resolve));
      });
      const policy = configure(sub, requireEngine.resolve(policyName), selected(network, port, useTls));
      const ip = await policy.resolveHost(network, 'electrum.test', port, useTls, async host => {
        assert.equal(host, 'electrum.test');
        return '127.0.0.1';
      });
      const { Wallet, generateMnemonic } = requireEngine('beignet');
      const { electrumTlsModule } = require(path.join(engine, 'dist/cli/electrum-tls-config.js'));
      const wire = requireEngine('rn-electrum-client/helpers');
      const peer = { host: ip, ssl: useTls ? port : 0, tcp: useTls ? 0 : port, protocol: useTls ? 'ssl' : 'tcp' };
      const other = { ...peer, host: 'other.invalid' };
      const verifiedTls = electrumTlsModule({ electrumTlsVerify: true, electrumTlsFingerprints: [PIN] }, ip, 'electrum.test');
      const wallet = new Wallet({ mnemonic: generateMnemonic(), network: network === 'mainnet' ? 'bitcoin' : network,
        feeEstimationSource: 'http', electrumOptions: { net, tls: verifiedTls, servers: peer } });
      assert.deepEqual(wallet.electrum.getServerCandidates([other, peer], transportNetwork), [peer]);
      const http = sub.mock.method(global, 'fetch', async () => assert.fail('Unpermitted HTTP fee query'));
      assert.equal(wallet.feeEstimationSource, 'electrum');
      await wallet.fetchFeeEstimates();
      await wallet.fetchFeeEstimatesFromHttp();
      await wallet.fetchFallbackFeeEstimates();
      assert.equal(http.mock.callCount(), 0);
      const start = params => wire.start({ clientName: 'beignet', protocolVersion: '1.4', network: transportNetwork,
        net, tls: verifiedTls, ...params });
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal((await wallet.connectToElectrum([other, peer])).isOk(), true);
        const rates = await wallet.fetchFeeEstimates();
        if (network !== 'regtest') assert.equal(rates.fast, 12);
        assert.equal(http.mock.callCount(), 0);
        await wallet.electrum.disconnect();
        // No socket is currently registered. Previously these helpers chose a
        // random default and tried connecting before they returned a failure.
        assert.match((await wire.getAddressScriptHashBalance({ network: transportNetwork, scriptHash: 'ab'.repeat(32) })).data, /selected Electrum/);
        // Observe failure BEFORE any resolver or network object can be used.
        const trap = { get Socket() { assert.fail('Unpermitted TCP endpoint'); } };
        const denied = await start({ customPeers: [other], net: trap, tls: {} });
        assert.match(denied.data, /outside the selected policy/);
        const wrongTransport = await start({ customPeers: [{ host: ip, tcp: port, ssl: port, protocol: useTls ? 'tcp' : 'ssl' }], net: trap, tls: {} });
        assert.match(wrongTransport.data, /outside the selected policy/);
      }
      assert.equal(methods.filter(method => method === 'server.version').length, 2);
      assert.equal(methods.filter(method => method === 'blockchain.estimatefee').length, network === 'regtest' ? 0 : 8);
    });
  }
});

test('onion TLS checks the onion identity over loopback before releasing any wallet bytes', { skip: !available }, async t => {
  const name = 'a'.repeat(56) + '.onion';
  const names = [];
  const data = [];
  const server = tls.createServer({ key: KEY, cert: CERT }, socket => {
    names.push(socket.servername);
    socket.on('error', () => {});
    socket.on('data', bytes => data.push(bytes.toString()));
    socket.on('end', () => socket.end());
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const policy = configure(t, requireEngine.resolve(policyName), { ...selected('regtest', port, true),
    BEIGNET_ELECTRUM_HOST: '127.0.0.1', CHICORY_ELECTRUM_ONION_NAME: name });
  const ip = await policy.resolveHost('regtest', '127.0.0.1', port, true, () => assert.fail('Unexpected DNS'));
  const { electrumTlsModule } = require(path.join(engine, 'dist/cli/electrum-tls-config.js'));
  const dial = pins => new Promise((resolve, reject) => {
    const transport = electrumTlsModule({ electrumTlsVerify: true, electrumTlsFingerprints: pins }, ip, ip);
    const socket = transport.connect({ host: ip, port }, () => socket.end('accepted'));
    socket.once('error', reject);
    socket.once('close', resolve);
  });
  await assert.rejects(dial(['00'.repeat(32)]), /certificate rejected/);
  await dial([PIN]);
  assert.deepEqual(data, ['accepted']);
  assert.ok(names.includes(name));
});
