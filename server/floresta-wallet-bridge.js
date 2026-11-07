'use strict';

const { randomBytes } = require('node:crypto');
const tls = require('node:tls');
const { walletElectrum } = require('./floresta-wallet-electrum');

const CIPHER = 'PSK-AES128-GCM-SHA256';
const IDENTITY = 'chicory-wallet-1';
const MAX_FRAME = 8_400_000;
const closed = () => new Error('Wallet qualification bridge closed.');

// Runs in the pinned Node process. The Electron runtime has a different TLS
// implementation. A cipher/handshake failure must never open a plaintext port.
async function openWalletBridge({ qualification, signal, ...backend }) {
  if (qualification !== true || backend.network !== 'regtest') throw new Error('The wallet bridge requires an explicitly enabled regtest fixture.');
  if (!(signal instanceof AbortSignal) || !tls.getCiphers().includes(CIPHER.toLowerCase())) throw closed();
  signal.throwIfAborted();
  const wallet = walletElectrum({ ...backend, qualification });
  const key = randomBytes(32);
  const connections = new Set();
  let active;
  let timer;
  let refreshing = false;
  let consumed = false;
  let stopped = false;
  const server = tls.createServer({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: CIPHER,
    handshakeTimeout: 3000, pskCallback: (_socket, identity) => !stopped && !consumed && identity === IDENTITY ? key : null });
  server.maxConnections = 4;
  function close() {
    if (stopped) return;
    stopped = true;
    key.fill(0);
    clearTimeout(timer);
    clearInterval(poll);
    signal.removeEventListener('abort', close);
    server.close();
    active?.destroy();
    for (const socket of connections) socket.destroy();
    backend.confirmed.close();
    backend.pending.close();
  }
  function write(object) {
    if (stopped || !active || active.destroyed) throw closed();
    const line = JSON.stringify(object) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME) throw closed();
    return new Promise((resolve, reject) => active.write(line, e => e ? reject(closed()) : resolve()));
  }
  async function refresh() {
    if (!active || stopped || refreshing) return;
    refreshing = true;
    try { await wallet.refresh((method, params) => write({ jsonrpc: '2.0', method, params })); }
    catch { close(); }
    finally { refreshing = false; }
  }
  const poll = setInterval(refresh, 2000);
  poll.unref();
  server.on('connection', socket => {
    if (consumed || stopped) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
  });
  server.on('tlsClientError', (_error, socket) => socket.destroy());
  server.on('error', close);
  server.on('secureConnection', socket => {
    if (stopped || consumed || socket.getCipher()?.name !== CIPHER || socket.getProtocol() !== 'TLSv1.2') { socket.destroy(); return; }
    active = socket;
    consumed = true;
    key.fill(0);
    clearTimeout(timer);
    server.close();
    for (const connection of connections) if (connection.remotePort !== socket.remotePort) connection.destroy();
    socket.on('error', close);
    socket.once('close', close);
    socket.setTimeout(120000, close);
    async function serve() {
      let buffered = Buffer.alloc(0);
      let first = true;
      for await (const chunk of socket) {
        buffered = Buffer.concat([buffered, chunk]);
        let end;
        while ((end = buffered.indexOf(10)) !== -1) {
          if (end > MAX_FRAME) throw closed();
          const frame = JSON.parse(buffered.toString('utf8', 0, end));
          buffered = buffered.subarray(end + 1);
          const batch = Array.isArray(frame);
          const calls = batch ? frame : [frame];
          if (!calls.length || calls.length > 256 || (first && (calls.length !== 1 || calls[0]?.method !== 'server.version'))) throw closed();
          const replies = [];
          let bytes = 0;
          for (const item of calls) {
            if ((!Number.isSafeInteger(item?.id) && !(typeof item?.id === 'string' && item.id.length <= 128)) ||
                typeof item.method !== 'string' || !Array.isArray(item.params)) throw closed();
            const reply = { jsonrpc: '2.0', id: item.id };
            try { reply.result = await wallet.call(item.method, item.params); }
            catch { if (first) throw closed(); reply.error = { code: -32000, message: 'Wallet data or requested operation unavailable.' }; }
            first = false;
            bytes += Buffer.byteLength(JSON.stringify(reply)) + 1;
            if (bytes > MAX_FRAME) throw closed();
            replies.push(reply);
          }
          await write(batch ? replies : replies[0]);
        }
        if (buffered.length > MAX_FRAME) throw closed();
      }
    }
    serve().catch(close);
  });
  signal.addEventListener('abort', close, { once: true });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('close', () => reject(closed()));
      server.listen(0, '127.0.0.1', resolve);
    });
    signal.throwIfAborted();
    timer = setTimeout(close, 30000);
    timer.unref();
    return { endpoint: { host: '127.0.0.1', port: server.address().port, tls: true, psk: key.toString('hex') }, close, refresh };
  } catch (error) { close(); throw error; }
}

module.exports = { openWalletBridge };
