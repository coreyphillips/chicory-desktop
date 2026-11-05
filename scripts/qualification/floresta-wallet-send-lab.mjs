import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { grantWalletBridge } from '../../desktop/floresta-wallet-bridge.cjs';
import { REGTEST_GENESIS } from './guards.mjs';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const { Block, Transaction, address, networks, opcodes, payments, script } = requireServer('bitcoinjs-lib');
const executable = fileURLToPath(new URL('../../.runtime/node/' + (process.platform === 'win32' ? 'node.exe' : 'bin/node'), import.meta.url));
const btc = networks.regtest;
const miner = payments.p2sh({ network: btc, redeem: { output: Buffer.from([opcodes.OP_TRUE]) } });
async function until(label, read, accept) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const v = await read(); if (accept(v)) return v; await delay(200); }
  throw new Error('Timed out waiting for ' + label);
}

export async function qualifyWalletSend({ node, proof }) {
  assert.equal(await proof('getblockhash', [0]), REGTEST_GENESIS);
  assert.equal(node.status().network, 'regtest');
  assert.equal(node.watch.walletOffersActive, true);
  const owner = randomBytes(32).toString('hex');
  const control = new AbortController();
  const children = [];
  let lease;
  let next = 0;
  function launch(name,args,extra = {}) {
    const child = fork(fileURLToPath(new URL(name, import.meta.url)), args, { execPath: executable, execArgv: [], stdio: ['ignore','ignore','ignore','ipc'],
      env: { CHICORY_FLORESTA_WALLET_LAB: '1', BEIGNET_NETWORK: 'regtest', ...extra, ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }) } });
    children.push(child); return child;
  }
  try {
    const manager = launch('./floresta-wallet-client.cjs', ['manager']);
    lease = await grantWalletBridge({ manager, node, owner, signal: control.signal, qualification: true });
    const wallet = launch('./floresta-sending-wallet.cjs', [], { CHICORY_ELECTRUM_POLICY: 'selected-only', BEIGNET_ELECTRUM_TLS: 'true',
      BEIGNET_ELECTRUM_HOST: '127.0.0.1', BEIGNET_ELECTRUM_PORT: String(lease.endpoint.port) });
    async function ask(type, fields = {}) {
      const id = ++next;
      const reply = once(wallet, 'message', { signal: AbortSignal.timeout(25000) });
      wallet.send({ id, type, ...fields });
      const [r] = await reply;
      assert.equal(r.id, id);
      if (r.error) throw new Error('Pinned Beignet ' + type + ' failed: ' + r.error);
      return r.value;
    }
    const prepared = await ask('prepare', { psk: lease.endpoint.psk });
    assert.deepEqual(prepared.fees, { fast: 4, normal: 3, slow: 2, minimum: 1 });
    const fundingScript = address.toOutputScript(prepared.address, btc);
    await node.registerWatches({ owner, scripts: [], outpoints: [], descriptors: prepared.descriptors.map(descriptor => ({ descriptor, range: [0,127] })) });
    const coverage = hash => until('active wallet coverage', () => node.watchCoverage(owner), v => v.phase === 'caught-up' && v.hash === hash);
    const tipHeight = await proof('getblockcount');
    await coverage(await proof('getbestblockhash'));
    let previous;
    for (let h = 1; h <= tipHeight - 99 && !previous; h++) {
      const candidate = Block.fromHex(await proof('getblock', [await proof('getblockhash', [h]), 0])).transactions[0];
      if (candidate.outs[0].script.equals(miner.output) && await proof('gettxout', [candidate.getId(), 0, true])) previous = candidate;
    }
    assert.ok(previous, 'An unspent mature disposable miner output is required.');
    const funding = new Transaction();
    funding.addInput(previous.getHash(), 0, 0xffffffff, script.compile([miner.redeem.output]));
    funding.addOutput(fundingScript, 150000);
    funding.addOutput(miner.output, previous.outs[0].value - 151000);
    assert.equal(await proof('sendrawtransaction', [funding.toHex()]), funding.getId());
    const [fundingBlock] = await proof('generate', [1]);
    await coverage(fundingBlock);
    await until('wallet tip heartbeat', () => node.status(), v => v.tipHash === fundingBlock && v.historicalVerification === 'verified');
    await ask('connect');
    assert.equal((await ask('refresh')).balance, 150000);
    const reviewed = await ask('sign', { destination: miner.address });
    const signed = Transaction.fromHex(reviewed.hex);
    assert.equal(signed.getId(), reviewed.txid);
    assert.equal(signed.ins.length, 1);
    assert.ok(signed.ins[0].witness.length);
    assert.ok(signed.ins[0].hash.equals(funding.getHash()));
    assert.equal(signed.ins[0].index, 0);
    assert.ok(signed.outs.some(out => out.value === 42000 && out.script.equals(miner.output)));
    const fee = 150000 - signed.outs.reduce((sum,out) => sum + out.value, 0);
    assert.ok(fee > 0 && fee < 3000);
    const offer = (raw,txid = reviewed.txid,who = owner,tip = fundingBlock) => node.watch.request({ action: 'broadcast', owner: who, txid, offer: { hex: raw, tip } });
    const forged = signed.clone(); forged.setWitness(0, [Buffer.alloc(45,7),signed.ins[0].witness[1]]);
    await assert.rejects(offer(forged.toHex()));
    await assert.rejects(offer(reviewed.hex,reviewed.txid,'fa'.repeat(32)));
    await assert.rejects(offer(reviewed.hex,reviewed.txid,owner,REGTEST_GENESIS));
    assert.deepEqual(await proof('getrawmempool'), []);
    const wtxid = createHash('sha256').update(createHash('sha256').update(signed.toBuffer()).digest()).digest().reverse().toString('hex');
    lease.authorizeBroadcast(reviewed.txid, wtxid);
    assert.equal(await ask('send'), reviewed.txid);
    await until('independent peer admission', () => proof('getrawmempool'), ids => ids.includes(reviewed.txid));
    assert.equal(await proof('getrawtransaction', [reviewed.txid,0]), reviewed.hex);
    await assert.rejects(ask('send'));
    const [blockHash] = await proof('generate', [1]);
    await coverage(blockHash);
    const block = Block.fromHex(await proof('getblock',[blockHash,0]));
    assert.ok(block.transactions.some(tx => tx.toHex() === reviewed.hex));
    const checked = await node.confirmedTransaction(owner,reviewed.txid);
    assert.equal(checked.hex, reviewed.hex);
    assert.equal(checked.blockHash, blockHash);
    return { network: 'regtest', txid: signed.getId(), wtxid,
      sent: 42000, fee, virtualBytes: signed.virtualSize(), engineFeesSatVb: prepared.fees, txConfirmedHeight: checked.height,
      rejectedForgedWitness: true, rejectedWrongOwner: true, rejectedStaleTip: true, submittedOnce: true, independentAdmission: true };
  } finally {
    control.abort(); lease?.close();
    for (const child of children) if (child.exitCode === null && !child.signalCode) {
      const end = once(child,'exit'); if (child.connected) child.disconnect(); const timer = setTimeout(() => child.kill(), 2000);
      try { await end; } finally { clearTimeout(timer); }
    }
  }
}
