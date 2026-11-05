import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import readline from 'node:readline';
import test from 'node:test';
import { headerHash } from './guards.mjs';
import { probe, readFixture } from './floresta-electrum.mjs';

const { Transaction, address, networks } = createRequire(new URL('../../server/package.json', import.meta.url))('bitcoinjs-lib');
const genesis = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000';
const publicScript = Buffer.from('0014' + '11'.repeat(20), 'hex');
const otherScript = Buffer.from('52', 'hex');
const hash = data => createHash('sha256').update(data).digest();

function transactions() {
  const parent = new Transaction();
  parent.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from('0101', 'hex'));
  parent.addOutput(otherScript, 10_000);
  const funding = new Transaction();
  funding.addInput(parent.getHash(), 0);
  funding.addOutput(otherScript, 500);
  funding.addOutput(publicScript, 6_500);
  funding.addOutput(publicScript, 2_500);
  const pending = new Transaction();
  pending.addInput(funding.getHash(), 1);
  pending.addOutput(otherScript, 5_500);
  // Known test block with a coinbase and the funded transaction at position 1.
  const root = hash(hash(Buffer.concat([parent.getHash(), funding.getHash()])));
  const header = genesis.slice(0, 72) + root.toString('hex') + genesis.slice(136);
  const fixture = {
    network: 'regtest', scriptPubKey: publicScript.toString('hex'), parents: [parent.toHex()],
    transactions: [{ hex: funding.toHex(), height: 1, position: 1, blockHash: headerHash(header) }, { hex: pending.toHex(), height: 0 }]
  };
  return { fixture, parent, funding, pending, header };
}

async function serve(t, answer) {
  const server = net.createServer(socket => {
    const lines = readline.createInterface({ input: socket });
    lines.on('line', line => {
      const request = JSON.parse(line);
      function reply(message) {
        return { jsonrpc: '2.0', id: message.id, ...answer(message) };
      }
      // Reverse the batch to exercise correlation by id.
      socket.write(JSON.stringify(Array.isArray(request) ? request.map(reply).reverse() : reply(request)) + '\n');
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('validates public fixture and derives spent outputs and pending balance from raw bytes', () => {
  const { fixture, funding, pending } = transactions();
  const f = readFixture(fixture);
  assert.deepEqual(f.history, [{ tx_hash: funding.getId(), height: 1 }, { tx_hash: pending.getId(), height: 0 }]);
  assert.deepEqual(f.unspent, [{ tx_hash: funding.getId(), tx_pos: 2, value: 2500, height: 1 }]);
  assert.deepEqual(f.balance, { confirmed: 9000, unconfirmed: -6500 });
  assert.throws(() => readFixture({ ...fixture, network: 'mainnet' }), /regtest/);
  assert.throws(() => readFixture({ ...fixture, parents: [pending.toHex()] }), /parent/);
  assert.throws(() => readFixture({ ...fixture, transactions: [] }), /funded/);
});

test('does not send a fixture to an endpoint serving a different genesis', async t => {
  const methods = [];
  const port = await serve(t, ({ method }) => {
    methods.push(method);
    return { result: method === 'server.version' ? ['fixture', '1.4'] : '00'.repeat(80) };
  });
  const { rows, qualified } = await probe(port, readFixture(transactions().fixture));
  assert.deepEqual(methods, ['server.version', 'blockchain.block.header']);
  assert.equal(rows[0].status, 'failed');
  assert.equal(qualified, false);
});

test('requires funded values and reports unsupported behavior even on a responsive endpoint', async t => {
  const { fixture, parent, funding, pending, header } = transactions();
  const f = readFixture(fixture);
  const wire = new Map([parent, funding, pending].map(tx => [tx.getId(), tx]));
  let verbose = false;
  let badConfirmations = false;
  const port = await serve(t, ({ method, params }) => {
    switch (method) {
      case 'server.version': return { result: ['fixture', '1.4'] };
      case 'server.ping': return { result: null };
      case 'blockchain.block.header': return { result: params[0] ? header : genesis };
      case 'blockchain.headers.subscribe': return { result: { height: 1, hex: header } };
      case 'blockchain.estimatefee': return { result: 0.0001 };
      case 'blockchain.scripthash.get_history': return { result: f.history };
      case 'blockchain.scripthash.subscribe': return { result: hash(funding.getId() + ':1:' + pending.getId() + ':0:').toString('hex') };
      case 'blockchain.scripthash.listunspent': return { result: [{ ...f.unspent[0], tx_pos: 1 }] };
      case 'blockchain.scripthash.get_balance': return { result: { confirmed: params[0] === f.scriptHash ? f.balance.confirmed : null, unconfirmed: 0 } };
      case 'blockchain.scripthash.get_mempool': return { result: [] };
      case 'blockchain.transaction.get': {
        if (!wire.has(params[0])) return { error: { code: -32602, message: 'Invalid params' } };
        const tx = wire.get(params[0]);
        if (!params[1] || !verbose) return { result: tx.toHex() }; // Pinned server ignores verbose=true.
        const confirmed = tx === funding;
        return { result: {
          hex: tx.toHex(), txid: tx.getId(), vsize: tx.virtualSize(),
          confirmations: confirmed && !badConfirmations ? 1 : 0, blockhash: confirmed ? headerHash(header) : undefined,
          vin: tx.ins.map(prev => tx.isCoinbase() ? { coinbase: prev.script.toString('hex'), sequence: prev.sequence }
            : { txid: Buffer.from(prev.hash).reverse().toString('hex'), vout: prev.index, sequence: prev.sequence }),
          vout: tx.outs.map((out, n) => ({ n, value: out.value / 1e8, scriptPubKey: {
            hex: out.script.toString('hex'), address: out.script.equals(publicScript) ? address.fromOutputScript(publicScript, networks.regtest) : undefined
          } }))
        } };
      }
      case 'blockchain.transaction.get_merkle':
        return { result: { block_height: 1, pos: 1, merkle: [parent.getId()] } };
      default: return { error: { code: -32602, message: 'Invalid params' } };
    }
  });
  const report = await probe(port, f);
  assert.equal(report.qualified, false);
  const rows = Object.fromEntries(report.rows.map(row => [row.check, row.status]));
  assert.equal(rows['Startup ping and batch balance query'], 'passed');
  assert.deepEqual(report.rows.find(row => row.check === 'Startup ping and batch balance query').detail, { numericBalance: false });
  for (const name of ['Initial header subscription', 'Watched history', 'Initial script subscription',
    'Raw watched transactions', 'Raw parent transactions', 'Merkle branches and block positions']) {
    assert.equal(rows[name], 'passed', name);
  }
  for (const name of ['Beignet recognizes a missing transaction', 'Watched UTXOs', 'Watched balance',
    'Pending script transactions', 'Verbose watched transaction batch', 'Verbose parent transaction batch']) {
    assert.equal(rows[name], 'failed', name);
  }
  assert.equal(rows['Dynamic fee estimates'], 'blocked');
  assert.equal(rows['Fee responses for Beignet targets'], 'observed');
  const utxoError = report.rows.find(r => r.check === 'Watched UTXOs').detail;
  assert.match(utxoError, /vout 2 with 2500 sats at height 1\. Received vouts \[1\]/);

  verbose = true;
  const valid = await probe(port, f);
  const verboseStatus = r => r.rows.find(row => row.check === 'Verbose watched transaction batch').status;
  assert.equal(verboseStatus(valid), 'passed');
  badConfirmations = true;
  assert.equal(verboseStatus(await probe(port, f)), 'failed');

  const changed = readFixture({ ...fixture, transactions: [{ ...fixture.transactions[0], blockHash: 'aa'.repeat(32) }] });
  const altered = await probe(port, changed);
  assert.equal(altered.rows.find(r => r.check === 'Merkle branches and block positions').status, 'failed');
});
