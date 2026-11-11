'use strict';

const path = require('node:path');
const { SUPPORTED_NETWORKS } = require('./config');
const vault = require('./vault-files');

// This directory belongs to the wallet, outside the daemon and both backup formats.
const DIRECTORY = 'payment-notes';
const MAX_BYTES = 8 * 1024 * 1024;

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode, code: 'PAYMENT_NOTES_UNAVAILABLE' });
}

const validKey = key => typeof key === 'string' && key.length > 0;
const validNote = note => note && typeof note.text === 'string' &&
  (note.address === undefined || typeof note.address === 'string');

/** Read, edit and atomically replace the encrypted file in a single manager turn. */
function openPaymentNotes(manager, id, network) {
  const record = manager.registry.get(id);
  if (!record || !/^[a-zA-Z0-9_-]+$/.test(id) || !SUPPORTED_NETWORKS.includes(network) || record.network !== network)
    fail(404, 'This wallet is unavailable on the selected network.');
  const file = path.join(manager.paths(id).base, DIRECTORY, network + '.json');
  if (!vault.protects(file)) fail(409, 'Private notes need encrypted desktop wallet storage.');
  let entries = new Map();
  try {
    const saved = JSON.parse(vault.fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved) || !saved.every(pair => Array.isArray(pair) && pair.length === 2 &&
      validKey(pair[0]) && validNote(pair[1]))) throw new Error();
    entries = new Map(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') fail(503, 'The saved private notes could not be read.');
  }
  function commit() {
    const bytes = JSON.stringify([...entries]);
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail(413, 'There is too much private note text to save.');
    vault.atomicWriteFileSync(file, bytes);
  }
  return {
    read: () => [...entries],
    save({ key, note } = {}) {
      if (!validKey(key) || !validNote(note)) fail(400, 'Choose a payment and enter its private note.');
      const text = note.text.trim();
      const address = note.address ?? entries.get(key)?.address;
      if (text) entries.set(key, { text, ...(address !== undefined ? { address } : {}) });
      else entries.delete(key);
      commit();
      return [...entries];
    },
    move({ moves } = {}) {
      if (!Array.isArray(moves) || !moves.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(validKey)))
        fail(400, 'The private notes could not be matched to their payments.');
      let changed = false;
      for (const [from, to] of moves) {
        if (!entries.has(from) || entries.has(to)) continue;
        entries.set(to, entries.get(from));
        entries.delete(from);
        changed = true;
      }
      if (changed) commit();
      return [...entries];
    },
  };
}

/** Removing a wallet also forgets its notes when the daemon data is retained. */
function removePaymentNotes(base) {
  const directory = path.join(base, DIRECTORY);
  if (vault.protects(directory)) vault.fs.rmSync(directory, { recursive: true, force: true });
}

module.exports = { openPaymentNotes, removePaymentNotes };
