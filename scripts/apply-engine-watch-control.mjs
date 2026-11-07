import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = 'chicory-watch-control.cjs';
const helperSource = fileURLToPath(new URL('./engine-watch-control.cjs', import.meta.url));

// Insertions are anchored to the published 0.38.0 build. Preserve the
// original method bodies for ordinary external wallets.
const sites = {
  'cli/beignet-node.js': [
    ['await instance.init(opts);', 'attach(instance)'],
  ],
  'wallet/index.js': [
    ['this.moveReceiveIndex(addressType, next);\n        const issued', 'checkAddress(this, next.address)'],
  ],
  'lightning/chain/chain-watcher.js': [
    ['const hash = (0, provider_1.sha256)(scriptPubkey);', 'script(scriptPubkey)'],
    ['this.getSweepFeeRatePerVbyte = config.getSweepFeeRatePerVbyte;', 'script(this.destinationScript)'],
    ['this.destinationScript = destinationScript;', 'script(destinationScript)'],
    ["this.emit('watch:output:requested', txid, outputIndex);", 'outpoint(txid, outputIndex)'],
    ['this.watchedFundings.set(key, watched);', 'funding(watched)', 2],
    ['this.watchedSpliceInputs.set(key, {', 'outpoint(input.txid, input.vout, input.script)'],
    ['watched.scriptHash = computeScriptHash(Buffer.from(prevout.script));', 'outpoint(watched.txid, watched.vout, prevout.script)'],
    ['const key = `${txid}:${outputIndex}`;\n        const watched', 'outpoint(txid, outputIndex, scriptPubkey)'],
    ['const rawTx = await this.backend.getTransaction(txid);', 'outpoint(txid, outputIndex)'],
    ['const scriptPubkey = tx.outs[outputIndex].script;', 'verifyParent(tx, txid)'],
    ['const parentRaw = await this.backend.getTransaction(prevTxid);', 'outpoint(prevTxid, prevVout)'],
    ['const history = await this.backend.getScriptHashHistory(computeScriptHash(Buffer.from(prevout.script)));', 'outpoint(prevTxid, prevVout, prevout.script)'],
    ['const scriptHash = computeScriptHash(outpoint.scriptPubKey);', 'outpoint(outpoint.txidDisplayHex, outpoint.vout, outpoint.scriptPubKey)'],
  ],
  'lightning/node/lightning-node.js': [
    ['const rawTx = await this._chainBackend.getTransaction(txidHex);\n        const fundingTx =', 'outpoint(txidHex, state.fundingOutputIndex)'],
    ['if (state.fundingOutputIndex >= fundingTx.outs.length) {', 'verifyParent(fundingTx, txidHex)'],
  ],
  'lightning/chain/electrum-backend.js': [
    ['async subscribeToScriptHash(scriptHash, onChange) {', 'checkHash(scriptHash)', 1, true],
    ['async getScriptHashHistory(scriptHash) {', 'checkHash(scriptHash)', 1, true],
    ['async listUnspent(scriptHash) {', 'checkHash(scriptHash)', 1, true],
    ['const history = [];\n        if (response.data', 'validateHistory(scriptHash, response)'],
    ['return (result.value.utxos || []).map((u) => ({', 'checkHash(scriptHash)'],
    ['await this.withTimeout(this.electrum.subscribeToAddresses({\n                    scriptHashes: [scriptHash]', 'checkHash(scriptHash)'],
  ],
};

export function patchEngineWatchControl(directory, { verifyOnly = false } = {}) {
  const engine = path.resolve(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8'));
  if (fs.existsSync(path.join(engine, '.git')) || pkg.name !== 'beignet' || pkg.version !== '0.38.0') {
    throw new Error('The watch control patch requires installed Beignet 0.38.0.');
  }
  const pending = new Map();
  for (const [relative, edits] of Object.entries(sites)) {
    const target = path.join(engine, 'dist', relative);
    const original = fs.readFileSync(target, 'utf8');
    let source = original;
    const from = path.posix.relative(path.posix.dirname(relative), helper);
    for (const [before, method, count = 1, append = false] of edits) {
      const indent = /^ */.exec(source.slice(source.lastIndexOf('\n', source.indexOf(before)) + 1))[0];
      const call = `require('${from}').${method};`;
      const after = append ? `${before}\n${indent}    ${call}` : `${call}\n${indent}${before}`;
      const installed = source.split(after);
      if (installed.length === count + 1 && !installed.join('').includes(before)) continue;
      if (installed.length !== 1 || source.split(before).length !== count + 1) {
        throw new Error(`Unexpected watch control patch site in ${relative}.`);
      }
      source = source.split(before).join(after);
    }
    if (source !== original) pending.set(target, source);
  }
  const file = path.join(engine, 'dist', helper);
  const expected = fs.readFileSync(helperSource, 'utf8');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) pending.set(file, expected);
  if (verifyOnly && pending.size) throw new Error('Incomplete engine watch control patch. Run npm run runtime:prepare.');
  for (const [target, contents] of pending) fs.writeFileSync(target, contents);
  return { changed: pending.size > 0 };
}
