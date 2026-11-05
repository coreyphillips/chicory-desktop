import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const policyName = 'chicory-endpoint-policy.cjs';
const policySource = fileURLToPath(new URL('./engine-endpoint-policy.cjs', import.meta.url));
const policyImport = "require('rn-electrum-client/helpers/chicory-endpoint-policy.cjs')";

const engineFiles = {
  'dist/cli/beignet-node.js': [
    ['const electrumHost = await resolveHostToIPv4(rawElectrumHost);',
      `const electrumHost = await ${policyImport}.resolveHost(networkName, rawElectrumHost, electrumPort, electrumTls, resolveHostToIPv4);`],
    ['if (opts.electrumServers && opts.electrumServers.length > 1) {',
      `if (!${policyImport}.strict && opts.electrumServers && opts.electrumServers.length > 1) {`],
  ],
  'dist/electrum/index.js': [
    ['getServerCandidates(customPeers, electrumNetwork) {\n        const fallback =',
      `getServerCandidates(customPeers, electrumNetwork) {
        const policy = ${policyImport};
        if (policy.strict) {
            return customPeers.filter(server => policy.allows(electrumNetwork, server.host, server[server.protocol], server.protocol));
        }
        const fallback =`],
  ],
  'dist/wallet/index.js': [
    ['this.feeEstimationSource = feeEstimationSource;', `this.feeEstimationSource = ${policyImport}.strict ? 'electrum' : feeEstimationSource;`],
    ...['fetchFeeEstimatesFromHttp', 'fetchFallbackFeeEstimates'].map(method => [
      `async ${method}(network = this._network) {\n        if (this.remainOffline)`,
      `async ${method}(network = this._network) {\n        if (${policyImport}.strict || this.remainOffline)`,
    ]),
  ],
};
const transportFiles = {
  'helpers/index.js': [
    ['clients.network = network;\n\t\t\tlet needToConnect', `if (!require('./${policyName}').allows(network, host, port, protocol)) {
                return resolve({ error: true, data: 'Electrum endpoint is outside the selected policy' });
            }
            clients.network = network;
            let needToConnect`],
    ['//Peers can be found in peers.json.', `if (require('./${policyName}').strict) {
        return { error: true, data: 'Waiting for the selected Electrum server' };
    }
    //Peers can be found in peers.json.`],
  ],
};

function checkPackage(directory, name, version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (fs.existsSync(path.join(directory, '.git')) || pkg.name !== name || pkg.version !== version) {
    throw new Error(`The endpoint policy requires installed ${name} ${version}.`);
  }
}

// Check every original or previously patched site before writing any file.
// A retry repairs an interrupted installation. Packaging uses the same checks
// in read-only mode and rejects a partly applied or older patch.
export function patchEngineEndpointPolicy(directory, { verifyOnly = false } = {}) {
  const engine = path.resolve(directory);
  checkPackage(engine, 'beignet', '0.38.0');
  const requireEngine = createRequire(path.join(engine, 'package.json'));
  const transport = path.dirname(requireEngine.resolve('rn-electrum-client/package.json'));
  checkPackage(transport, 'rn-electrum-client', '0.0.22');
  const pending = new Map();
  for (const [root, files] of [[engine, engineFiles], [transport, transportFiles]]) {
    for (const [relative, patches] of Object.entries(files)) {
      const target = path.join(root, relative);
      const original = fs.readFileSync(target, 'utf8');
      let source = original;
      for (const [before, after] of patches) {
        // Some substitutions extend the original line. Strip the replacement
        // first to reject a file containing duplicate or mixed patch sites.
        const installed = source.split(after);
        if (installed.length === 2 && !installed.join('').includes(before)) continue;
        if (installed.length > 1 || source.split(before).length !== 2) {
          throw new Error(`Unexpected endpoint policy patch site in ${relative}.`);
        }
        source = source.replace(before, after);
      }
      if (source !== original) pending.set(target, source);
    }
  }
  const policy = path.join(transport, 'helpers', policyName);
  const helper = fs.readFileSync(policySource, 'utf8');
  if (!fs.existsSync(policy) || fs.readFileSync(policy, 'utf8') !== helper) pending.set(policy, helper);
  if (verifyOnly && pending.size) throw new Error('The selected-only Electrum patch is incomplete. Run npm run runtime:prepare.');
  for (const [file, content] of pending) fs.writeFileSync(file, content);
  return { changed: pending.size > 0 };
}
