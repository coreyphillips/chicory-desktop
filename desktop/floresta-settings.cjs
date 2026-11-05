'use strict';

const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { ManagedFloresta } = require('./floresta.cjs');

const networks = ['mainnet', 'testnet', 'regtest'];
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const prefsFile = 'floresta-sync.json';

function candidateDigest({ isPackaged, demo, digest }) {
  return !isPackaged && !demo && validDigest(digest) ? digest : null;
}

// The user selects a digest at source-app launch. A mutable build receipt alone
// cannot select an executable, change its trusted hash or enable a release build.
function candidate(root, digest) {
  if (!validDigest(digest)) throw new Error('Select a locally prepared Floresta candidate.');
  const recipe = path.join(root, 'build', 'floresta');
  const pin = JSON.parse(fs.readFileSync(path.join(recipe, 'source.json'), 'utf8'));
  const directory = path.join(root, '.runtime', 'floresta-candidates', process.platform + '-' + process.arch, digest);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8'));
  if (manifest.sha256 !== digest || manifest.commit !== pin.commit || manifest.release !== pin.release ||
      manifest.archiveSha256 !== pin.archiveSha256 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
      !pin.patches.every(file => manifest.patches?.[file] === sha256(fs.readFileSync(path.join(recipe, file))))) {
    throw new Error('Rebuild the Floresta candidate from this source checkout.');
  }
  return { binary: path.join(directory, process.platform === 'win32' ? 'florestad.exe' : 'florestad'), sha256: digest };
}

class FlorestaSettings {
  constructor({ root, profile, digest, create = options => new ManagedFloresta(options), load = candidate,
    canCollect = () => false, setCollection = () => {}, reconcile = async () => ({}) }) {
    this.profile = profile;
    this.file = path.join(profile, prefsFile);
    this.root = root;
    this.digest = digest;
    this.create = create;
    this.load = load;
    this.nodes = new Map();
    this.errors = new Map();
    this.inFlight = new Set();
    this.epoch = 0;
    this.collection = new Map();
    this.canCollect = canCollect;
    this.setCollection = setCollection;
    this.reconcile = reconcile;
  }
  _read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.size > 16384) throw new Error();
      const prefs = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (prefs.version !== 1 || !prefs.networks || typeof prefs.networks !== 'object') throw new Error();
      for (const [network, value] of Object.entries(prefs.networks)) {
        if (!networks.includes(network) || !validDigest(value.digest) || typeof value.enabled !== 'boolean' ||
            !(value.folder === null || (typeof value.folder === 'string' && path.isAbsolute(value.folder)))) throw new Error();
      }
      return prefs.networks;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('The local node sync preferences could not be read.');
    }
  }
  _saved(network) {
    if (!networks.includes(network)) throw new Error('Unsupported Floresta network.');
    const entry = this._read()[network];
    return entry?.digest === this.digest ? entry : { digest: this.digest, enabled: false, folder: null };
  }
  _save(network, entry) {
    const entries = this._read();
    entries[network] = entry;
    const stage = this.file + '.' + randomUUID();
    try {
      fs.writeFileSync(stage, JSON.stringify({ version: 1, networks: entries }), { mode: 0o600, flag: 'wx', flush: true });
      fs.renameSync(stage, this.file);
    } finally { fs.rmSync(stage, { force: true }); }
  }
  status(network) {
    const { enabled, folder } = this._saved(network);
    const node = this.nodes.get(network)?.status();
    return { requested: enabled, storage: folder ? path.basename(folder) : 'Profile folder', customStorage: process.platform !== 'win32',
      phase: this.errors.has(network) ? 'failed' : node?.phase || 'stopped', height: node?.height ?? null,
      validatedHeight: node?.validatedHeight ?? null, tipSynced: node?.tipSynced ?? null, error: this.errors.get(network) || node?.error || null,
      watches: this.collection.get(network)?.summary ?? null };
  }
  pauseCollection(network) {
    const lease = this.collection.get(network);
    if (!lease) return;
    this.collection.delete(network);
    clearInterval(lease.timer);
    lease.controller.abort();
    Promise.resolve(this.setCollection(network, false)).catch(() => {});
  }
  refreshCollection() {
    for (const [network, node] of this.nodes) {
      let requested = false;
      try { requested = this._saved(network).enabled; } catch { /* Keep corrupt preferences fail-closed. */ }
      if (!requested || this.closed || !this.canCollect() || node.status().phase !== 'running') { this.pauseCollection(network); continue; }
      if (this.collection.has(network)) continue;
      const controller = new AbortController();
      const lease = { controller, busy: false, summary: null };
      const run = async () => {
        if (controller.signal.aborted) return;
        if (this.closed || !this.canCollect()) { this.pauseCollection(network); return; }
        if (node.status().phase !== 'running') { lease.summary = { unavailable: true }; return; }
        if (lease.busy) return;
        lease.busy = true;
        try {
          // An idempotent manager enable also covers engines opened after this node.
          await this.setCollection(network, true);
          if (controller.signal.aborted) return;
          const { observedWallets, confirmedScansCaughtUp } = await this.reconcile(node, network, controller.signal);
          lease.summary = { observedWallets, confirmedScansCaughtUp };
        } catch { lease.summary = { unavailable: true }; }
        finally { lease.busy = false; }
      };
      this.collection.set(network, lease);
      lease.timer = setInterval(run, 10000);
      lease.timer.unref();
      void run();
    }
  }
  _start(network, prefs) {
    this.errors.delete(network);
    try {
      if (!this.nodes.has(network)) {
        const build = this.load(this.root, this.digest);
        this.nodes.set(network, this.create({ ...build, network, profileDirectory: this.profile, storageDirectory: prefs.folder }));
      }
      const node = this.nodes.get(network);
      void node.start().then(() => {
        if (this.nodes.get(network) === node && this._saved(network).enabled) this.refreshCollection();
      }).catch(error => {
        if (this.nodes.get(network) === node) this.errors.set(network, error.message);
      });
    } catch {
      this.errors.set(network, 'Prepare this source checkout with npm run runtime:prepare:floresta and select its binary digest.');
    }
  }
  // Only called after the app lock admits the profile. Each consent is scoped to
  // this network and the exact build approved by the person starting the app.
  resume() {
    if (this.closed) return;
    for (const network of networks) {
      try {
        const prefs = this._saved(network);
        if (prefs.enabled && !this.nodes.has(network)) this._start(network, prefs);
      } catch { this.errors.set(network, 'The saved Floresta settings are unavailable.'); }
    }
    this.refreshCollection();
  }
  async change(network, operation, { current, confirm, folder }) {
    const prefs = this._saved(network);
    const epoch = this.epoch;
    const admitted = () => !this.closed && this.epoch === epoch && current();
    if (!admitted() || this.inFlight.has(network)) throw new Error('Local node settings are busy or locked.');
    this.inFlight.add(network);
    try {
      if (operation === 'start') {
        if (!prefs.enabled && !await confirm()) return this.status(network);
        if (!admitted()) throw new Error('Unlock Chicory and try again.');
        this._save(network, { ...prefs, enabled: true });
        this._start(network, prefs);
      } else if (operation === 'stop') {
        this._save(network, { ...prefs, enabled: false });
        this.pauseCollection(network);
        this.errors.delete(network);
        const node = this.nodes.get(network);
        if (node) { await node.stop(); this.nodes.delete(network); }
      } else if (operation === 'folder' && !prefs.enabled && process.platform !== 'win32') {
        const picked = await folder();
        if (!admitted()) throw new Error('Unlock Chicory and try again.');
        if (picked) this._save(network, { ...prefs, folder: fs.realpathSync(picked) });
      } else throw new Error('This local node setting is unavailable.');
      return this.status(network);
    } finally { this.inFlight.delete(network); }
  }
  async stopAll({ reset = false } = {}) {
    this.closed = true;
    this.epoch++;
    for (const network of this.collection.keys()) this.pauseCollection(network);
    const nodes = [...this.nodes.values()];
    await Promise.all(nodes.map(node => node.stop()));
    this.nodes.clear();
    this.errors.clear();
    if (reset) {
      fs.rmSync(this.file, { force: true }); // Preserve chain data even on an external volume.
      this.closed = false;
    }
  }
}

function installFlorestaIpc({ ipcMain, settings, trusted, allowed, appLock, dialog, window }) {
  ipcMain.handle('floresta:settings', async (event, network, op) => {
    appLock.expire();
    const generation = appLock.generation;
    const current = () => {
      appLock.expire();
      return trusted(event) && allowed() && !appLock.required() && appLock.generation === generation;
    };
    if (!current()) throw new Error('Local node settings are locked.');
    if (op === 'status') return settings.status(network);
    const state = await settings.change(network, op, {
      current,
      confirm: async () => (await appLock.duringPrompt(() => dialog.showMessageBox(window(), {
        type: 'question', title: 'Floresta qualification', message: 'Start a ' + network + ' node?',
        detail: 'Floresta downloads blocks over its own peer connections and stores public wallet and channel watches in the selected node folder. Initial sync and historical backfill can use substantial storage and bandwidth. Your wallet and Lightning channels keep using your selected Electrum server. Sync resumes when you reopen this development build with the same candidate.',
        buttons: ['Start node', 'Cancel'], defaultId: 1, cancelId: 1
      }))).response === 0,
      folder: async () => {
        const answer = await appLock.duringPrompt(() => dialog.showOpenDialog(window(), {
          title: 'Choose a folder for local Bitcoin data', properties: ['openDirectory', 'createDirectory']
        }));
        return answer.canceled ? null : answer.filePaths[0];
      }
    });
    if (!current()) throw new Error('Local node settings are locked.');
    return state;
  });
}

module.exports = { candidateDigest, candidate, FlorestaSettings, installFlorestaIpc };
