'use strict';

// A fresh, memory-only Lightning node. Its signer never crosses process IPC.
// The ordinary funding provider selects, pledges and signs the opener input.
// Its v2 external witness slot holds tx_signatures until the parent reviews
// both parties, exact signed transaction and both completed watch scans.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const pinned = createRequire(join(__dirname, '../../.runtime/engine/node_modules/beignet/package.json'));
if (process.env.CHICORY_FLORESTA_WALLET_LAB !== '1' || process.env.BEIGNET_NETWORK !== 'regtest' ||
    process.env.BEIGNET_ELECTRUM_HOST !== '127.0.0.1' || process.env.BEIGNET_ELECTRUM_TLS !== 'true' ||
    process.env.CHICORY_ELECTRUM_POLICY !== 'selected-only') process.exit(2);

async function derive() {
  const { Wallet } = pinned('beignet');
  const offline = new Wallet({ mnemonic: workerData, network: 'regtest', disableRefreshOnCreate: true });
  assert((await offline.setWalletData()).isOk());
  const descriptor = offline.exportDescriptors();
  assert(descriptor.isOk());
  parentPort.postMessage({ descriptors: descriptor.value.descriptors.flatMap(entry => [entry.external, entry.internal]),
    address: await offline.getAddress({ index: '0' }), change: await offline.getAddress({ index: '0', changeAddress: true }) });
}
if (!isMainThread) {
  // A separate module cache keeps offline derivation independent of the live
  // endpoint. This worker constructs a wallet without starting any transport.
  derive().catch(() => process.exit(1));
} else if (process.connected) {
  const mnemonic = pinned('bip39').generateMnemonic(256);
  let node, proposal, release, selected, consumed = false, witnessSignatures = 0;
  async function action(m) {
    if (m.type === 'lease-status' && node) return {
      disconnected: pinned('rn-electrum-client/helpers/chicory-endpoint-policy.cjs').leaseDisconnected,
      witnessSignatures, height: node.node.getChainWatcher().getCurrentBlockHeight(),
    };
    if (m.type === 'renew' && node) return pinned('./dist/chicory-watch-control.cjs').reconnectConfirmedFunding(m);
    if (m.type === 'prepare' && !node) {
      const offline = new Worker(__filename, { workerData: mnemonic, env: { ...process.env, BEIGNET_ELECTRUM_PORT: '1' } });
      try {
        return await new Promise((resolve, reject) => {
          offline.once('message', resolve); offline.once('error', reject);
          offline.once('exit', () => reject(new Error('Derivation stopped')));
        });
      } finally { await offline.terminate(); }
    }
    if (m.type === 'start' && !node) {
      assert(Number.isInteger(m.port) && m.port > 0 && m.port <= 65535);
      process.env.BEIGNET_ELECTRUM_PORT = String(m.port);
      pinned('rn-electrum-client/helpers/chicory-endpoint-policy.cjs').bindLocalSession(m.psk);
      const { BeignetNode } = pinned('./dist/cli/beignet-node.js');
      const { MemoryStorage } = pinned('./dist/lightning/storage/memory-storage.js');
      node = await BeignetNode.create({ mnemonic, network: 'regtest', storage: new MemoryStorage(),
        electrumHost: '127.0.0.1', electrumPort: m.port, electrumTls: true, addressType: 'p2wpkh', feeEstimationSource: 'electrum',
        autoGossipSync: false, rapidGossipSync: false, autoBootstrap: false, autoReconnect: false, logLevel: 'silent' });
      await node.waitForInitialSync();
      return { id: node.getInfo().nodeId, balance: node.wallet.balance, address: await node.wallet.getAddress({ index: '0' }) };
    }
    if (m.type === 'listen') { await node.node.listen(m.port, '127.0.0.1'); return true; }
    if (m.type === 'connect') { await node.connectPeer(m.peer, '127.0.0.1', m.port); return true; }
    if (m.type === 'open' && !consumed) {
      consumed = true;
      const provider = node.node.fundingProvider;
      const select = provider.selectDualFundingInputs.bind(provider);
      provider.selectDualFundingInputs = async (...args) => {
        const result = await select(...args);
        assert(!selected && result.inputs.length === 1);
        [selected] = result.inputs;
        return { ...result, inputs: [{ ...selected, external: true,
          signWitness() { throw new Error('Review required'); } }] };
      };
      node.node.on('channel:txsigs-needed', ({ channelId, fundingTxid, fundingOutputIndex, externalInputIndices }) => {
        if (proposal) return;
        assert.deepEqual(externalInputIndices, [0]);
        const [channel] = node.node.getChannelManager().listChannels();
        const record = channel.getFullState().v2InFlight;
        assert(!record.sentTxSignatures && !record.fullySigned && record.inputPrevouts.length === 1);
        const { Transaction } = pinned('bitcoinjs-lib');
        const tx = Transaction.fromHex(record.fundingTxHex);
        assert.equal(tx.ins.length, 1);
        assert(tx.getHash().equals(fundingTxid) && tx.ins[0].witness.length === 0);
        const { valueSats, script } = record.inputPrevouts[0];
        witnessSignatures++;
        const witness = selected.signWitness(tx, 0, valueSats, { scripts: [script], values: [valueSats] });
        tx.setWitness(0, witness);
        proposal = { hex: tx.toHex(), vout: fundingOutputIndex, txid: tx.getId() };
        release = () => {
          const result = node.node.provideV2ExternalWitness(channelId, tx.ins[0].hash, tx.ins[0].index, witness);
          assert(result.ok && !result.sendsWithheld);
        };
      });
      return node.openChannel(m.peer, m.amount, { satsPerVbyte: 3, trusted: false }).channelId;
    }
    if (m.type === 'proposal') return proposal || null;
    if (m.type === 'negotiated') {
      const [channel] = node.node.getChannelManager().listChannels();
      if (!channel) return null;
      const state = channel.getFullState();
      if (!state.remoteBasepoints) return null;
      return { local: state.localBasepoints.fundingPubkey.toString('hex'), remote: state.remoteBasepoints.fundingPubkey.toString('hex'),
        capacity: Number(state.fundingSatoshis), temporary: state.temporaryChannelId.toString('hex') };
    }
    if (m.type === 'release' && release && proposal.txid === m.txid) { release(); release = null; return true; }
    if (m.type === 'resend' && proposal) return node.node.fundingProvider.broadcastTransaction(proposal.hex);
    if (m.type === 'signed-record' || m.type === 'publish') {
      const [channel] = node.node.getChannelManager().listChannels();
      const record = channel?.getFullState().v2InFlight;
      if (!record?.sentTxSignatures || !record.receivedTxSignatures || !record.fullySigned) return null;
      const raw = record.fundingTxHex;
      const { Transaction } = pinned('bitcoinjs-lib');
      const tx = Transaction.fromHex(raw);
      if (m.type === 'publish') {
        assert(proposal && raw === proposal.hex && tx.getId() === m.txid && !release);
        return node.node.fundingProvider.broadcastTransaction(raw);
      }
      return { txid: tx.getId(), wtxid: Buffer.from(tx.getHash(true)).reverse().toString('hex') };
    }
    if (m.type === 'channels') return node.listChannels().map(({ channelId, fundingTxid, state, localBalanceSats, remoteBalanceSats, htlcUsable, htlcCount, capacitySats }) =>
      ({ channelId, fundingTxid, state, localBalanceSats, remoteBalanceSats, htlcUsable, htlcCount, capacitySats }));
    if (m.type === 'invoice') {
      const invoice = m.hold ? node.createHoldInvoice({ paymentHash: randomBytes(32).toString('hex'), amountSats: m.amount, minFinalCltvExpiry: 72 }) :
        node.createInvoice(m.amount, 'managed private regtest fixture');
      return { bolt11: invoice.bolt11, hash: invoice.paymentHash };
    }
    if (m.type === 'pay') return node.sendPaymentAsync(m.bolt11, 0);
    if (m.type === 'payments') return node.listPayments().filter(p => p.paymentHash === m.hash).map(p => ({ status: p.status, direction: p.direction, amountSats: p.amountSats }));
    if (m.type === 'hold') {
      const row = node.listHoldInvoices().find(p => p.paymentHash === m.hash);
      return row ? { state: row.state, count: row.htlcCount, held: row.heldAmountMsat, expiry: row.earliestExpiry } : null;
    }
    if (m.type === 'cancel') return node.cancelHoldInvoice(m.hash).htlcsFailed;
    throw new Error('Invalid fixture action');
  }
  process.once('disconnect', () => process.exit(0));
  process.on('message', async m => {
    try { process.send({ id: m.id, value: await action(m) }); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'refused';
      const frame = error.stack?.match(/(?:floresta-channel-wallet\.cjs|beignet-node\.js|lightning-node\.js):(\d+):\d+/)?.[0];
      process.send({ id: m.id, error: code + (frame ? ' at ' + frame : '') });
    }
  });
} else { process.exit(2); }
