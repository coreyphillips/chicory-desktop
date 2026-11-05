'use strict';

// Installed beside rn-electrum-client's helpers so the daemon, wallet and
// transport share this process-local policy. Chicory runs one daemon per wallet.
const mode = process.env.CHICORY_ELECTRUM_POLICY;
if (mode !== undefined && mode !== 'selected-only') throw new Error('Unknown Chicory Electrum endpoint policy.');
const strict = mode === 'selected-only';
const networks = new Map([
  ['mainnet', 'bitcoin'], ['testnet', 'bitcoinTestnet'], ['regtest', 'bitcoinRegtest'], ['signet', 'bitcoinSignet'],
]);
const network = process.env.BEIGNET_NETWORK;
const host = process.env.BEIGNET_ELECTRUM_HOST;
const portText = process.env.BEIGNET_ELECTRUM_PORT;
const port = Number(portText);
const tls = process.env.BEIGNET_ELECTRUM_TLS;
const protocol = tls === 'true' ? 'ssl' : 'tcp';
const onionName = process.env.CHICORY_ELECTRUM_ONION_NAME;
let dialHost;
let sessionKey;
const sessionCipher = 'PSK-AES128-GCM-SHA256';

if (onionName !== undefined && (!strict || host !== '127.0.0.1' || !/^[a-z2-7]{56}\.onion$/.test(onionName))) {
  throw new Error('An onion Electrum session requires a verified loopback bridge.');
}

if (strict && (!networks.has(network) || !host || host.trim() !== host || /\.onion\.?$/i.test(host) ||
    !/^\d+$/.test(portText || '') || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
    !['true', 'false'].includes(tls))) {
  throw new Error('Selected-only Electrum requires the effective wallet network, host, port and TLS policy. Onion endpoints require the desktop Tor bridge.');
}

// Validate before DNS. The standard resolver and TLS wrapper retain the
// original name for certificate verification and the resolved address for TCP.
async function resolveHost(networkName, requestedHost, requestedPort, requestedTls, resolve) {
  if (!strict) return resolve(requestedHost);
  if (networkName !== network || requestedHost !== host || requestedPort !== port || requestedTls !== (tls === 'true')) {
    throw new Error('The daemon configuration conflicts with the selected Electrum endpoint.');
  }
  dialHost = onionName || sessionKey ? host : await resolve(host);
  return dialHost;
}

// Called by the wallet's fork parent before the engine loads. The key stays
// in this process. It never enters Electrum messages, environment or argv.
function bindLocalSession(key) {
  if (sessionKey || dialHost || !strict || network !== 'regtest' || host !== '127.0.0.1' || tls !== 'true' || onionName ||
      process.env.BEIGNET_ELECTRUM_TLS_VERIFY === 'true' || process.env.BEIGNET_ELECTRUM_TLS_FINGERPRINTS ||
      typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Invalid private Electrum session.');
  }
  if (!require('node:tls').getCiphers().includes(sessionCipher.toLowerCase())) {
    throw new Error('The wallet runtime cannot authenticate the private Electrum session.');
  }
  sessionKey = Buffer.from(key, 'hex');
}

function allows(transportNetwork, requestedHost, requestedPort, requestedProtocol) {
  return !strict || (dialHost !== undefined && requestedHost === dialHost && requestedPort === port &&
    requestedProtocol === protocol && transportNetwork === networks.get(network));
}

// An owner-scoped backend cannot answer Beignet's unrelated balance probe.
// Ping the existing wallet socket without giving a reconnect helper a chance
// to dial another destination. A stalled peer must not stall the wallet.
async function pingWalletPeer(transportNetwork) {
  if (!sessionKey || transportNetwork !== networks.get(network)) return false;
  const clients = require('./clients');
  const client = clients.mainClient?.[transportNetwork];
  const peer = clients.peer?.[transportNetwork];
  if (!client || !peer || !allows(transportNetwork, peer.host, peer.port, peer.protocol)) return false;
  let timer;
  try {
    const reply = await Promise.race([
      client.server_ping(),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); }),
    ]);
    return clients.mainClient[transportNetwork] === client && (reply === null || reply?.result === null && !reply.error);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

// The selected bridge carries raw TCP. Set SNI on the TLS connection itself,
// including when the user selected encryption without certificate validation.
// Beignet applies its ordinary CA and fingerprint checks to this socket.
function tlsForEndpoint(transport) {
  if (sessionKey) {
    return { ...transport, connect(options, secure) {
      if (options.host !== host || options.port !== port || dialHost !== host) throw new Error('Unrecognized private Electrum endpoint.');
      // This exclusive TLS 1.2 cipher authenticates both ends using the
      // ephemeral wallet lease. A certificate from a different listener
      // cannot substitute for the lease. Never pass caller-supplied sessions.
      const socket = transport.connect({ host, port, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
        ciphers: sessionCipher, rejectUnauthorized: false,
        pskCallback: () => ({ identity: 'chicory-wallet-1', psk: sessionKey }) }, () => {
        if (socket.getProtocol() !== 'TLSv1.2' || socket.getCipher()?.name !== sessionCipher) {
          socket.destroy(new Error('Private Electrum authentication failed.'));
          return;
        }
        socket.disableRenegotiation();
        secure.call(socket);
      });
      return socket;
    } };
  }
  if (!onionName) return transport;
  return { ...transport, connect(options, secure) {
    if (options.host !== host || options.port !== port) throw new Error('Unrecognized onion Electrum bridge.');
    return transport.connect({ ...options, servername: onionName }, secure);
  } };
}

module.exports = { strict, resolveHost, allows, tlsForEndpoint, bindLocalSession, pingWalletPeer, get walletSession() { return Boolean(sessionKey); } };
