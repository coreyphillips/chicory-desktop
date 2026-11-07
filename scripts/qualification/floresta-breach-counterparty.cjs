'use strict';

// Disposable, memory-only regtest counterparty. There is no listener or
// signer API. It can release one of its own former states to its parent only
// after a real peer has moved this fresh channel past that commitment.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
if (!process.connected || process.env.CHICORY_BREACH_LAB !== '1' || process.env.BEIGNET_NETWORK !== 'regtest' ||
    process.env.BEIGNET_ELECTRUM_HOST !== '127.0.0.1' || process.env.CHICORY_ELECTRUM_POLICY !== 'selected-only') process.exit(2);
const pinned = createRequire(path.resolve('engine/node_modules/beignet/package.json'));
const { BeignetNode } = pinned('./dist/cli/beignet-node.js');
const { MemoryStorage } = pinned('./dist/lightning/storage/memory-storage.js');
const { Transaction } = pinned('bitcoinjs-lib');
const secret = randomBytes(32);
const heldHash = createHash('sha256').update(secret).digest('hex');
let node, captured, channelId, oldNumber;

async function action(message) {
  if (message.action === 'start' && !node) {
    const [, pubkey, port] = /^([a-f0-9]{66})@127\.0\.0\.1:([1-9]\d{0,4})$/.exec(message.peerUri) || [];
    assert(pubkey && Number(port) <= 65535);
    node = await BeignetNode.create({ storage: new MemoryStorage(), network: 'regtest',
      electrumHost: '127.0.0.1', electrumPort: Number(process.env.BEIGNET_ELECTRUM_PORT), electrumTls: false,
      feeEstimationSource: 'electrum', autoGossipSync: false, rapidGossipSync: false, autoBootstrap: false,
      autoReconnect: false, logLevel: 'silent' });
    await node.connectPeer(pubkey, '127.0.0.1', Number(port));
    return node.getInfo().nodeId;
  }
  if (message.action === 'fund-invoice') return node.createInvoice(90000, 'synthetic breach funding').bolt11;
  if (message.action === 'hold-invoice') {
    const invoice = node.createHoldInvoice({ paymentHash: heldHash, amountSats: 30000, minFinalCltvExpiry: 72 });
    return { bolt11: invoice.bolt11, paymentHash: heldHash };
  }
  if (message.action === 'capture' && oldNumber === undefined) {
    const held = node.listHoldInvoices().find(row => row.paymentHash === heldHash);
    if (!held?.earliestExpiry || held.htlcCount !== 1) return false;
    assert.match(message.channelId, /^[a-f0-9]{64}$/);
    channelId = Buffer.from(message.channelId, 'hex');
    const ch = node.node.getChannelManager().getChannel(channelId);
    assert(ch && ch.getState() === 'NORMAL');
    // This library call constructs the current commitment without applying a
    // close to the channel, sending a transaction, or perturbing its monitor.
    const plan = ch.prepareForceClose(ch.getSigner());
    assert(plan.ok);
    const tx = Transaction.fromBuffer(plan.commitmentTx);
    assert.equal(tx.ins.length, 1);
    assert(tx.outs.some(output => output.value === 30000));
    captured = plan.commitmentTx;
    oldNumber = ch.getCommitmentNumbers().local;
    return { txid: tx.getId(), number: oldNumber.toString() };
  }
  if (message.action === 'settle' && captured) return node.settleHoldInvoice(secret.toString('hex')).paymentHash === heldHash;
  if (message.action === 'release' && captured) {
    const channel = node.node.getChannelManager().getChannel(channelId);
    const current = channel.getCommitmentNumbers().local;
    if (current <= oldNumber || node.getChannel(channelId.toString('hex')).htlcCount !== 0) return false;
    const hex = captured.toString('hex');
    captured.fill(0);
    captured = null;
    return { hex, current: current.toString() };
  }
  throw new Error('Invalid fixture action');
}

process.once('disconnect', () => process.exit(0));
process.on('message', async message => {
  try { process.send({ result: await action(message) }); }
  catch (error) {
    const line = error.stack?.match(/floresta-breach-counterparty\.cjs:(\d+):\d+/)?.[1];
    process.send({ failed: true, line: line || 'unknown' });
  }
});
