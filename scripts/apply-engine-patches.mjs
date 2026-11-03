import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ORIGINAL_METHOD = `    async getNewAddress() {
        const result = await this.wallet.fetchNextAvailableAddress();
        if (result.isErr()) {
            throw new errors_1.BeignetError('ADDRESS_FAILED', result.error.message);
        }
        return result.value.addressIndex.address;
    }`;
export const FRESH_METHOD = `
    // chicory-host-fresh-address-v1: persist the advance before watching it.
    async getFreshReceiveAddress() {
        const current = await this.wallet.fetchNextAvailableAddress();
        if (current.isErr()) throw new errors_1.BeignetError('ADDRESS_FAILED', current.error.message);
        const generated = await this.wallet.generateNewReceiveAddress();
        if (generated.isErr()) throw new errors_1.BeignetError('ADDRESS_FAILED', generated.error.message);
        const address = generated.value.address;
        if (address === current.value.addressIndex.address)
            throw new errors_1.BeignetError('RECEIVE_ADDRESS_LIMIT', 'The unused receive address limit has been reached.');
        const bitcoin = require('bitcoinjs-lib');
        const script = bitcoin.address.toOutputScript(address, this.getBitcoinNetwork());
        const scriptHash = require('crypto').createHash('sha256').update(script).digest().reverse().toString('hex');
        const watched = await this.wallet.electrum.subscribeToAddresses({ scriptHashes: [scriptHash] });
        if (watched.isErr())
            throw new errors_1.BeignetError('ADDRESS_FAILED', 'The address was reserved but its payment notifications could not be connected.');
        return address;
    }`;
const ORIGINAL_ROUTE = 'const address = await node.getNewAddress();';
const FRESH_ROUTE = 'const address = body?.fresh === true ? await node.getFreshReceiveAddress() : await node.getNewAddress(); // chicory-host-fresh-address-v1';
const RESPONSES = [
  ['return success({ address });', 'return success({ address, ...(body?.fresh === true ? { fresh: true } : {}) });'],
  ['return success({ address, bip21: uri.value });', 'return success({ address, bip21: uri.value, ...(body?.fresh === true ? { fresh: true } : {}) });'],
];
const once = (text, needle) => text.split(needle).length === 2;

/** Patch an installed package or an isolated copy, never a source checkout. */
export function patchEngine(directory) {
  const root = path.resolve(directory);
  if (fs.existsSync(path.join(root, '.git'))) throw new Error('Refusing to patch a source checkout. Install or copy the engine first.');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (packageInfo.name !== 'beignet' || packageInfo.version !== '0.36.1') throw new Error('The host patch requires exactly Beignet 0.36.1.');
  const nodePath = path.join(root, 'dist/cli/beignet-node.js');
  const daemonPath = path.join(root, 'dist/cli/daemon.js');
  const node = fs.readFileSync(nodePath, 'utf8');
  const daemon = fs.readFileSync(daemonPath, 'utf8');
  if (once(node, FRESH_METHOD) && once(daemon, FRESH_ROUTE) && RESPONSES.every(([, replacement]) => once(daemon, replacement))) return { changed: false, version: packageInfo.version };
  if (node.includes('chicory-host-fresh-address-v1') || daemon.includes('chicory-host-fresh-address-v1') || !once(node, ORIGINAL_METHOD) || !once(daemon, ORIGINAL_ROUTE) || !RESPONSES.every(([original]) => once(daemon, original)))
    throw new Error('The engine source shape does not match the reviewed fresh-address patch. No files were changed.');
  const nodePatched = node.replace(ORIGINAL_METHOD, ORIGINAL_METHOD + FRESH_METHOD);
  let daemonPatched = daemon.replace(ORIGINAL_ROUTE, FRESH_ROUTE);
  for (const [original, replacement] of RESPONSES) daemonPatched = daemonPatched.replace(original, replacement);
  fs.writeFileSync(nodePath, nodePatched);
  fs.writeFileSync(daemonPath, daemonPatched);
  return { changed: true, version: packageInfo.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node scripts/apply-engine-patches.mjs /path/to/installed/beignet');
  const result = patchEngine(directory);
  console.log(`Beignet ${result.version} host fresh-address patch ${result.changed ? 'applied' : 'already present'}.`);
}
