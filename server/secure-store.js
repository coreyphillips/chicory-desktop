'use strict';

/**
 * Private interface state for the desktop app (issue #4): offline request
 * drafts, cached wallet views, auto-pay policy and network profiles. Each
 * entry is a file under the wallet storage, written through the encrypted
 * vault like wallet secrets, so it is protected by the profile's OS-held key,
 * gated by the app lock with the rest of /api, and removed by an erase.
 */
const crypto = require('node:crypto');
const path = require('node:path');

const SERVICE = /^com\.beignet\.wallet\.(?:auto-pay|network-profiles|last-snapshot(?:\.[A-Za-z0-9%_.-]{1,200})?|offline-request\.[A-Za-z0-9%_.-]{1,200})$/;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 500;

function failure(status, code, message) {
  return Object.assign(new Error(message), { statusCode: status, code });
}

function createSecureStore({ dataDir, vault = require('./vault-files') }) {
  const directory = path.join(dataDir, 'secure-store');
  const fileFor = (service) => path.join(directory, `${crypto.createHash('sha256').update(service).digest('hex')}.json`);
  const ready = () => {
    if (!vault.isActive()) throw failure(409, 'SECURE_STORE_UNAVAILABLE', 'Private app state needs the desktop app\'s encrypted wallet storage.');
    return vault.fs;
  };
  const checked = (service) => {
    if (typeof service !== 'string' || !SERVICE.test(service)) throw failure(400, 'SECURE_STORE_REFUSED', 'This app state is not kept in the encrypted store.');
    return service;
  };
  const read = (fs, file) => {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!entry || typeof entry.service !== 'string' || typeof entry.username !== 'string' || typeof entry.password !== 'string') throw new Error();
    return entry;
  };

  return {
    get(service) {
      const fs = ready();
      const file = fileFor(checked(service));
      try { return read(fs, file); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw failure(500, 'SECURE_STORE_UNREADABLE', 'Saved app state could not be read.');
      }
    },
    set(service, { username, password } = {}) {
      const fs = ready();
      checked(service);
      if (typeof username !== 'string' || typeof password !== 'string')
        throw failure(400, 'SECURE_STORE_REFUSED', 'Saved app state must be text.');
      const text = JSON.stringify({ service, username, password });
      if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw failure(413, 'SECURE_STORE_TOO_LARGE', 'This app state is too large to save.');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const exists = (() => { try { fs.statSync(fileFor(service)); return true; } catch { return false; } })();
      if (!exists && fs.readdirSync(directory).length >= MAX_ENTRIES) throw failure(507, 'SECURE_STORE_FULL', 'Too much app state is saved.');
      fs.writeFileSync(fileFor(service), text, { mode: 0o600 });
      return true;
    },
    remove(service) {
      const fs = ready();
      try { fs.rmSync(fileFor(checked(service)), { force: true }); } catch { /* already gone */ }
      return true;
    },
    list() {
      const fs = ready();
      let names = [];
      try { names = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, MAX_ENTRIES); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const services = [];
      for (const name of names) {
        try { services.push(read(fs, path.join(directory, name)).service); } catch { /* an unreadable entry is not listed */ }
      }
      return services;
    }
  };
}

module.exports = { createSecureStore, SERVICE, MAX_ENTRY_BYTES };
