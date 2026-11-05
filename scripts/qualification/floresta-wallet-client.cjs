'use strict';

// The funded lab gives this disposable child a single authenticated regtest
// endpoint. Use the pinned engine transport and selected-only TLS policy.
const { createRequire } = require('node:module');
const path = require('node:path');
if (!process.connected || process.env.CHICORY_FLORESTA_WALLET_LAB !== '1' || process.env.BEIGNET_NETWORK !== 'regtest') process.exit(2);
if (process.argv[2] === 'manager') {
  require('../../server/floresta-bridge-control').installBridgeControl(process, { qualification: true });
  process.once('disconnect', () => process.exit(0));
  return;
}
const pinned = createRequire(path.resolve(__dirname, '../../.runtime/engine/node_modules/beignet/package.json'));
const policy = pinned('rn-electrum-client/helpers/chicory-endpoint-policy.cjs');
const Client = pinned('rn-electrum-client/lib/electrum_client.js');
let client;
process.on('disconnect', () => { client?.close(); process.exit(0); });
process.on('message', async message => {
  const { id } = message;
  try {
    let value;
    if (message.type === 'open' && !client) {
      const host = process.env.BEIGNET_ELECTRUM_HOST;
      const port = Number(process.env.BEIGNET_ELECTRUM_PORT);
      policy.bindLocalSession(message.psk);
      await policy.resolveHost('regtest', host, port, true, async () => '127.0.0.1');
      client = new Client(port, host, 'ssl', require('node:net'), policy.tlsForEndpoint(require('node:tls')));
      client.subscribe.on('blockchain.scripthash.subscribe', params => {
        if (process.connected) process.send({ event: 'script-status', params });
      });
      if ((await client.connect()).error) throw new Error();
      value = await client.server_version('beignet', '1.4');
    } else if (message.type === 'read' && client && message.method !== 'blockchain.transaction.broadcast') {
      value = await client.request(message.method, message.params);
    } else throw new Error();
    process.send({ id, value });
  } catch { if (process.connected) process.send({ id, error: true }); }
});
