'use strict';

// A memory-only Beignet regtest wallet for the funded send fixture. Return
// public descriptors, reviewed transaction bytes and receipts over private IPC.
const { createRequire } = require('node:module');
const path = require('node:path');
if (!process.connected || process.env.CHICORY_FLORESTA_WALLET_LAB !== '1' || process.env.BEIGNET_NETWORK !== 'regtest') process.exit(2);
const pinned = createRequire(path.resolve(__dirname, '../../.runtime/engine/node_modules/beignet/package.json'));
const { Wallet, generateMnemonic } = pinned('beignet');
const policy = pinned('rn-electrum-client/helpers/chicory-endpoint-policy.cjs');
let wallet;
let signed;
let peer;
function ok(result) {
  if (result.isErr()) {
    const categories = ['history', 'electrum', 'utxo', 'connection', 'address', 'network', 'transaction', 'complete', 'server', 'balance', 'timeout', 'offline', 'subscribe', 'request'];
    const words = categories.filter(word => result.error?.message?.toLowerCase().includes(word));
    throw new Error([result.error?.code || 'REFUSED', ...words.map(word => word.toUpperCase())].join('_'));
  }
  return result.value;
}
process.once('disconnect', () => process.exit(0));
process.on('message', async m => {
  try {
    let value;
    if (m.type === 'prepare' && !wallet) {
      const host = process.env.BEIGNET_ELECTRUM_HOST;
      const port = Number(process.env.BEIGNET_ELECTRUM_PORT);
      policy.bindLocalSession(m.psk);
      await policy.resolveHost('regtest', host, port, true, async () => '127.0.0.1');
      peer = { host, ssl: port, tcp: 0, protocol: 'ssl' };
      wallet = new Wallet({ mnemonic: generateMnemonic(), network: 'regtest', addressType: 'p2wpkh',
        addressTypesToMonitor: ['p2wpkh'], disableRefreshOnCreate: true,
        electrumOptions: { net: require('node:net'), tls: policy.tlsForEndpoint(require('node:tls')), servers: peer } });
      ok(await wallet.setWalletData());
      const descriptors = ok(wallet.exportDescriptors()).descriptors.flatMap(d => [d.external,d.internal]);
      const { fast, normal, slow, minimum } = await wallet.fetchFeeEstimates();
      value = { address: await wallet.getAddress({ index: '0' }), descriptors, fees: { fast, normal, slow, minimum } };
    } else if (m.type === 'connect') {
      ok(await wallet.connectToElectrum([peer])); value = true;
    } else if (m.type === 'refresh') {
      ok(await wallet.refreshWallet({ force: true })); value = { balance: wallet.balance };
    } else if (m.type === 'sign' && !signed) {
      const tx = ok(await wallet.createSignedTransaction({ address: m.destination, amount: 42000, satsPerByte: 3, shuffleOutputs: false }));
      signed = tx.txHex; value = { txid: tx.txid, hex: signed };
    } else if (m.type === 'send' && signed) { value = ok(await wallet.broadcastTransaction(signed)); }
    else throw new Error('unknown');
    process.send({ id: m.id, value });
  } catch (error) {
    const code = typeof error.message === 'string' && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : null;
    process.send({ id: m.id, error: code || 'wallet-refused' });
  }
});
