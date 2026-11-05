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
let dialHost;

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
  dialHost = await resolve(host);
  return dialHost;
}

function allows(transportNetwork, requestedHost, requestedPort, requestedProtocol) {
  return !strict || (dialHost !== undefined && requestedHost === dialHost && requestedPort === port &&
    requestedProtocol === protocol && transportNetwork === networks.get(network));
}

module.exports = { strict, resolveHost, allows };
