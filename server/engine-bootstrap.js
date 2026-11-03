"use strict";

const path = require('node:path');
const Module = require('node:module');
const vault = require('./vault-files');
const entry = process.argv[2];
const args = process.argv.slice(3);
let initialized = false;
const timeout = setTimeout(() => process.exit(1), 15000);
process.once('disconnect', () => {
  if (!initialized) process.exit(0);
  else if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
  else process.exit(0);
});
process.on('message', message => {
  if (initialized || message?.type !== 'initialize-storage') return;
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
    const engineRoot = path.resolve(path.dirname(entry), '..') + path.sep;
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
