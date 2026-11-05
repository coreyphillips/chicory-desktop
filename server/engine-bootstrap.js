"use strict";

const path = require('node:path');
const Module = require('node:module');
const vault = require('./vault-files');
const entry = process.argv[2];
const args = process.argv.slice(3);
let initialized = false;
let fenced = false;
let chainWatch;
const engineRoot = path.resolve(path.dirname(entry), '..') + path.sep;
const timeout = setTimeout(() => process.exit(1), 15000);
process.once('disconnect', () => {
  if (!initialized) process.exit(0);
  else if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
});
process.on('message', message => {
  // Only our fork parent has this channel. No HTTP endpoint or renderer IPC
  // can request descriptors, acknowledge coverage or stop startup.
  if (message?.type === 'chicory-chain-control/v1') {
    if (!Number.isSafeInteger(message.id) || message.id < 0) return;
    let result;
    try {
      switch (message.action) {
        case 'enable-observation':
          if (!initialized || fenced) {
            result = { enabled: false };
            break;
          }
          chainWatch = require(path.join(engineRoot, 'chicory-watch-control.cjs'));
          chainWatch.enable();
          result = { enabled: true };
          break;
        case 'disable-observation':
          result = { disabled: chainWatch?.disableObservation() ?? true };
          break;
        case 'fence-before-init':
          if (!initialized) fenced = true;
          result = { fenced, status: fenced ? 'fenced-before-init' : 'deferred-engine-started' };
          break;
        case 'watch-snapshot':
          result = chainWatch?.snapshot() || { status: 'disabled', coverageComplete: false };
          break;
        case 'acknowledge-watch':
          result = chainWatch?.acknowledge(message.generation) || { accepted: false };
          break;
        case 'invalidate-watch':
          chainWatch?.invalidate();
          result = { invalidated: true };
          break;
        default: return;
      }
    } catch {
      result = { status: 'watch-control-unavailable', coverageComplete: false };
    }
    if (process.connected) process.send({ type: 'chicory-chain-reply/v1', id: message.id, result }, () => {});
    return;
  }
  if (fenced || initialized || message?.type !== 'initialize-storage') return;
  initialized = true;
  clearTimeout(timeout);
  try {
    if (!/^[a-f0-9]{64}$/.test(message.filesKey) || !/^[a-f0-9]{64}$/.test(message.databaseKey) || !path.isAbsolute(message.filesRoot)) throw new Error();
    const filesKey = Buffer.from(message.filesKey, 'hex');
    vault.configureVault({ root: message.filesRoot, key: filesKey, scope: 'wallet' });
    filesKey.fill(0);
    process.env.CHICORY_DATABASE_KEY = message.databaseKey;
    if (message.mnemonic !== undefined) {
      if (typeof message.mnemonic !== 'string' || message.mnemonic.length > 512) throw new Error();
      process.env.BEIGNET_MNEMONIC = message.mnemonic;
      message.mnemonic = undefined;
    }
    if (message.apiToken !== undefined) {
      if (typeof message.apiToken !== 'string' || !/^[a-f0-9]{64}$/.test(message.apiToken)) throw new Error();
      process.env.BEIGNET_API_TOKEN = message.apiToken;
      message.apiToken = undefined;
    }
    message.filesKey = undefined; message.databaseKey = undefined;
    if (message.electrumLease !== undefined) {
      const fromEngine = Module.createRequire(entry);
      fromEngine('rn-electrum-client/helpers/chicory-endpoint-policy.cjs').bindLocalSession(message.electrumLease);
      message.electrumLease = undefined;
    }
    if (message.requireWatchAck === true && message.chainWatch !== true) throw new Error();
    if (message.chainWatch === true) {
      chainWatch = require(path.join(engineRoot, 'chicory-watch-control.cjs'));
      chainWatch.enable({ requireWatchAck: message.requireWatchAck === true });
    }
    const load = Module._load;
    Module._load = function(request, parent, isMain) {
      if (parent?.filename?.startsWith(engineRoot) && !parent.filename.endsWith(`${path.sep}engine-storage.cjs`)) {
        if (request === 'fs' || request === 'node:fs') return vault.fs;
        if (request === 'fs/promises' || request === 'node:fs/promises') return vault.fs.promises;
      }
      return load.call(this, request, parent, isMain);
    };
    process.argv = [process.execPath, entry, ...args];
    require(entry);
  } catch {
    process.stderr.write('Encrypted wallet runtime could not start. Existing wallet data was preserved.\n');
    process.exit(1);
  }
});
