'use strict';

const { randomUUID } = require('node:crypto');

const isOnionHost = host => typeof host === 'string' && /\.onion\.?$/i.test(host.trim());
const validOnionHost = host => typeof host === 'string' && /^[a-z2-7]{56}\.onion$/i.test(host);
const enabled = () => process.env.DESKTOP_TOR_MANAGED === '1';
const torError = message => Object.assign(new Error(message), { code: 'TOR_UNAVAILABLE', statusCode: 503 });

function onionInUri(value) {
  return typeof value === 'string' && /(?:^|@|\/\/)[a-z2-7]{56}\.onion(?::\d+)?(?:\/|$)/i.test(value.trim());
}

function requiresTor(record) {
  if (!record) return false;
  if (record.networkMode === 'tor' || record.tor === true || isOnionHost(record.electrum?.host)) return true;
  if ([record.primaryUri, record.lfbw?.primaryUri, record.lfbw?.primaryFallbackUri].some(onionInUri)) return true;
  return (record.recovery?.guardians || []).some(guardian =>
    onionInUri(typeof guardian === 'string' ? guardian : guardian?.uri || guardian?.address));
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

module.exports = { DesktopNetwork, configureDesktopNetwork, ensureTor, resolveElectrum, requiresTor, isOnionHost, validOnionHost, enabled, torStatus };
