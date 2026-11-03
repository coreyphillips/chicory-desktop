import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import torModule from '../../desktop/tor.cjs';

// Tor Project publishes this address in https://www.torproject.org/'s
// Onion-Location header. This smoke test opens only that public website.
const onion = '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion';
const root = fileURLToPath(new URL('../../', import.meta.url));
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-tor-smoke-'));
const tor = new torModule.BundledTor({
  bundleDirectory: path.join(root, '.runtime/tor'), dataDirectory: state,
  onStatus: status => console.log(`Tor ${status.phase}: ${status.progress}%`),
});
try {
  const proxy = await tor.startProxy();
  assert.equal(proxy.host, '127.0.0.1'); assert.equal(tor.child, null);
  await tor.ensureReady();
  assert.equal(tor.status().progress, 100);
  const bridge = await tor.createBridge(onion, 80);
  const status = await new Promise((resolve, reject) => {
    const request = http.get({ host: bridge.host, port: bridge.port, path: '/',
      headers: { Host: onion }, agent: false }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.setTimeout(45000, () => request.destroy(new Error('The Tor Project onion request timed out.')));
    request.on('error', reject);
  });
  assert.ok(status >= 200 && status < 400, `Unexpected Tor Project response: ${status}`);
  await bridge.close();
  console.log('Bundled Tor bootstrap and onion HTTP tunnel verified.');
} finally {
  await tor.stop();
  assert.equal(tor.child, null); assert.equal(tor.proxy.listening, false);
  await fs.rm(state, { recursive: true, force: true });
  console.log('Tor process and private listeners stopped.');
}
