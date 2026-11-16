'use strict';

const { randomUUID } = require('node:crypto');

const isOnionHost = host => typeof host === 'string' && /\.onion\.?$/i.test(host.trim());
const validOnionHost = host => typeof host === 'string' && /^[a-z2-7]{56}\.onion$/i.test(host);
const enabled = () => process.env.DESKTOP_TOR_MANAGED === '1';
const torError = message => Object.assign(new Error(message), { code: 'TOR_UNAVAILABLE', statusCode: 503 });

function onionInUri(value) {
  return typeof value === 'string' && /(?:^|@|\/\/)[a-z2-7]{56}\.onion(?::\d+)?(?:\/|$)/i.test(value.trim());
}

/**
 * Whether a record names an onion anywhere: Tor mode, an onion Electrum
 * server, a primary, a primary's fallback or a recovery guardian. Such a
 * wallet brings up the app's Tor as it starts, so Tor is warm when an onion is
 * dialed. Whether the start waits for it is `requiresTor`.
 */
function wantsTor(record) {
  if (!record) return false;
  if (record.networkMode === 'tor' || record.tor === true || isOnionHost(record.electrum?.host)) return true;
  const ranked = Array.isArray(record.lfbw?.primaries) ? record.lfbw.primaries.flatMap(entry => [entry?.uri, entry?.fallbackUri]) : [];
  if ([record.primaryUri, record.lfbw?.primaryUri, record.lfbw?.primaryFallbackUri, ...ranked].some(onionInUri)) return true;
  return (record.recovery?.guardians || []).some(guardian =>
    onionInUri(typeof guardian === 'string' ? guardian : guardian?.uri || guardian?.address));
}

/** The record's primaries, ranked or the one its scalar fields name. */
function primaryRoutes(record) {
  const lf = record.lfbw;
  if (Array.isArray(lf?.primaries) && lf.primaries.some(Boolean))
    return lf.primaries.filter(Boolean).map(entry => ({ walletId: entry.walletId, uri: entry.uri, fallbackUri: entry.fallbackUri }));
  const single = { walletId: lf?.mode === 'internal' ? lf.primaryWalletId : null,
    uri: lf?.primaryUri || record.primaryUri, fallbackUri: lf?.primaryFallbackUri };
  return single.walletId || single.uri ? [single] : [];
}

/** Whether a primary is reached with Tor down: a sibling wallet, a clearnet host, a Porch link or a dialable Iroh link. */
function reachableWithoutTor(entry, irohAvailable) {
  if (entry.walletId) return true;
  if (typeof entry.uri !== 'string' || !entry.uri.trim() || onionInUri(entry.uri)) return false;
  return /^[^@]+@iroh:/i.test(entry.uri) ? irohAvailable : true;
}

/**
 * Whether a wallet cannot run without Tor, so its engine start waits for it:
 * Tor mode, an onion Electrum server (its bridge runs through Tor), or
 * primaries that are all reached only over Tor. Any primary with another way
 * in means the wallet runs without Tor, and an onion it also names, a fallback,
 * a lower-ranked primary or a guardian, is reached through the app's proxy,
 * which starts Tor on first use. Those only warm Tor (`wantsTor`). Without
 * `irohAvailable`, an Iroh link counts as reached by its onion fallback alone.
 */
function requiresTor(record, { irohAvailable = false } = {}) {
  if (!record) return false;
  if (record.networkMode === 'tor' || record.tor === true || isOnionHost(record.electrum?.host)) return true;
  const routes = primaryRoutes(record);
  return routes.length > 0 && !routes.some(entry => reachableWithoutTor(entry, irohAvailable)) &&
    routes.some(entry => onionInUri(entry.uri) || onionInUri(entry.fallbackUri));
}

class DesktopNetwork {
  constructor({ transport = process, timeoutMs = 130000 } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.state = { phase: 'stopped', progress: 0, error: null };
    this.response = message => {
      if (message?.type === 'tor:status') {
        const status = message.status;
        if (!status || !['stopped', 'starting', 'ready', 'failed'].includes(status.phase) ||
            !Number.isInteger(status.progress) || status.progress < 0 || status.progress > 100) return;
        this.state = { phase: status.phase, progress: status.progress,
          error: status.phase === 'failed' ? 'Tor could not connect. Check the network and retry.' : null };
        return;
      }
      if (message?.type !== 'tor:result' || typeof message.requestId !== 'string') return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.error) return pending.reject(torError(String(message.error).slice(0, 240)));
      const result = message.result;
      if (result?.host !== '127.0.0.1' || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535)
        return pending.reject(torError('The desktop Tor service returned an invalid local endpoint.'));
      pending.resolve({ host: result.host, port: result.port });
    };
    this.disconnect = () => {
      this.state = { phase: 'failed', progress: 0, error: 'The desktop Tor service disconnected.' };
      this.rejectAll('The desktop Tor service disconnected.');
    };
    transport.on('message', this.response);
    transport.on('disconnect', this.disconnect);
  }
  request(type, payload = {}) {
    if (!this.transport.connected || typeof this.transport.send !== 'function')
      return Promise.reject(torError('The bundled Tor service is unavailable. Reopen Chicory.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(torError('Tor did not become ready in time. Check the network and retry.'));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      const failed = cause => {
        if (!cause || !this.pending.has(requestId)) return;
        this.pending.delete(requestId); clearTimeout(timer);
        reject(torError('The bundled Tor service could not be reached.'));
      };
      try { this.transport.send({ type, requestId, ...payload }, failed); }
      catch (cause) { failed(cause); }
    });
  }
  rejectAll(message) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(torError(message)); }
    this.pending.clear();
  }
  status() { return { ...this.state }; }
  close() {
    this.rejectAll('The bundled Tor service stopped.');
    this.transport.off('message', this.response);
    this.transport.off('disconnect', this.disconnect);
  }
}

let service;
function configureDesktopNetwork(options) {
  if (service) service.close();
  service = new DesktopNetwork(options);
  return service;
}
function network() { return service || configureDesktopNetwork(); }
function torStatus() { return enabled() ? network().status() : null; }
function ensureTor() {
  if (!enabled()) return Promise.resolve(null);
  return network().request('tor:ensure');
}
async function resolveElectrum(server) {
  if (!isOnionHost(server?.host)) return server;
  const host = server.host.trim().toLowerCase();
  if (!validOnionHost(host) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535)
    throw torError('Choose a valid onion Electrum server and port.');
  if (!enabled()) throw torError('This onion Electrum server requires the bundled desktop Tor service.');
  const endpoint = await network().request('tor:bridge', { host, port: server.port });
  // The onion address authenticates this route. Match the mobile transport:
  // do not send local TLS server-name or DNS lookups to the onion endpoint.
  return { ...server, ...endpoint, tls: false, tlsVerify: false, onionHost: host };
}

module.exports = { DesktopNetwork, configureDesktopNetwork, ensureTor, resolveElectrum, requiresTor, wantsTor, isOnionHost, validOnionHost, enabled, torStatus };
