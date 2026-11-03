"use strict";

const { configureVault, initializeVault } = require('./vault-files');
let initialized = false;
let handedOff = false;
let stopping = false;
const timeout = setTimeout(() => process.exit(1), 30000);
function cancel() { stopping = true; if (!initialized) process.exit(0); }
process.on('disconnect', () => { if (!handedOff) cancel(); });
process.on('message', async message => {
  if (!handedOff && message?.type === 'shutdown') return cancel();
  if (initialized || message?.type !== 'initialize-storage') return;
  initialized = true;
  clearTimeout(timeout);
  let key;
  try {
    if (typeof message.key !== 'string' || !/^[a-f0-9]{64}$/.test(message.key)) throw new Error();
    key = Buffer.from(message.key, 'hex');
    configureVault({ root: process.env.DATA_DIR, key });
    key.fill(0); key = null; message.key = undefined;
    initializeVault();
    if (stopping) return process.exit(0);
    require('./desktop-network').configureDesktopNetwork();
    handedOff = true;
    await require('./index').main();
  } catch (error) {
    key?.fill(0);
    // Key-bearing database queries and engine errors never cross this boundary.
    const message = error.code === 'VAULT_UNAVAILABLE' ? error.message : 'Encrypted wallet storage could not be opened. Existing data was preserved.';
    if (process.connected) process.send({ type: 'startup-error', code: 'STORAGE_UNAVAILABLE', message }, () => process.exit(1));
    else process.exit(1);
  }
});
