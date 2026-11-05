'use strict';

const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { ManagedFloresta, removeOwnedData } = require('./floresta.cjs');

const networks = ['mainnet', 'testnet', 'regtest'];
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const prefsFile = 'floresta-sync.json';
const cleanupFile = 'floresta-cleanup.json';
const validFolder = folder => folder === null || typeof folder === 'string' && path.isAbsolute(folder);

function writePrivate(file, value) {
  const stage = file + '.' + randomUUID();
  try {
    fs.writeFileSync(stage, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(stage, file);
  } finally { fs.rmSync(stage, { force: true }); }
}

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
  const executable = process.platform === 'win32' ? 'florestad.exe' : 'florestad';
  const files = [executable, 'bundle.json', 'LICENSE.md', 'LICENSE-APACHE', 'LICENSE-MIT'];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (!fs.lstatSync(directory).isDirectory() || entries.length !== files.length ||
      !entries.every(entry => entry.isFile() && files.includes(entry.name)) ||
      fs.statSync(path.join(directory, 'bundle.json')).size > 16384) {
    throw new Error('The prepared Floresta directory contains an unexpected or missing file.');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8'));
  if (manifest.sha256 !== digest || manifest.commit !== pin.commit || manifest.release !== pin.release ||
      manifest.archiveSha256 !== pin.archiveSha256 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
      Object.keys(manifest.patches || {}).length !== pin.patches.length ||
      !pin.patches.every(file => manifest.patches?.[file] === sha256(fs.readFileSync(path.join(recipe, file))))) {
    throw new Error('Rebuild the Floresta candidate from this source checkout.');
  }
  const { release, commit, archiveSha256, patches } = manifest;
  return { binary: path.join(directory, executable), sha256: digest, receipt: { release, commit, archiveSha256, patches } };
}

class FlorestaSettings {
  constructor({ root, profile, digest, create = options => new ManagedFloresta(options), load = candidate,
    remove = removeOwnedData, canCollect = () => false, setCollection = () => {}, reconcile = async () => ({}) }) {
    this.profile = profile;
    this.file = path.join(profile, prefsFile);
    this.root = root;
    this.digest = digest;
    this.create = create;
    this.remove = remove;
    this.cleanupFile = path.join(profile, cleanupFile);
    this.removals = new Map();
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
            value.storeDigest != null && !validDigest(value.storeDigest) ||
            !validFolder(value.folder) || value.used !== undefined && typeof value.used !== 'boolean' ||
            value.checkpointHold !== undefined && typeof value.checkpointHold !== 'boolean' ||
            value.checkpointQuickStart !== undefined && typeof value.checkpointQuickStart !== 'boolean' ||
            value.initialized !== undefined && typeof value.initialized !== 'boolean') throw new Error();
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
    const locations = this._locations();
    const cleanupPending = Object.hasOwn(locations, network);
    const folder = cleanupPending ? locations[network] : entry?.folder ?? null;
    const recordedStore = !!entry && entry.used !== false;
    const used = cleanupPending || recordedStore || this._hasNodeData(network, folder);
    // Older previews saved the build that last requested the store in digest.
    const storeDigest = recordedStore && !cleanupPending
      ? (Object.hasOwn(entry, 'storeDigest') ? entry.storeDigest : entry.digest) : null;
    const alreadyEnabled = Boolean(entry?.enabled && entry.digest === this.digest);
    // Older previews approved full verification only. Keep that policy when
    // resuming them. A fresh enable has a native checkpoint disclosure.
    const quickStart = entry?.checkpointQuickStart ?? !alreadyEnabled;
    return { digest: this.digest, storeDigest, enabled: alreadyEnabled && !cleanupPending && storeDigest === this.digest, checkpointHold: entry?.checkpointHold === true,
      checkpointQuickStart: network === 'mainnet' && quickStart,
      folder,
      // Older versions recorded the selected folder before the first start.
      // Treat a previously used custom volume as initialized to avoid creating
      // replacement data on another disk mounted at its old path.
      initialized: cleanupPending || (entry?.initialized ?? Boolean(entry?.folder && entry.used !== false)), used };
  }
  _locations() {
    try {
      const stat = fs.lstatSync(this.cleanupFile);
      if (!stat.isFile() || stat.size > 16384) throw new Error();
      const values = JSON.parse(fs.readFileSync(this.cleanupFile, 'utf8'));
      if (!values || Array.isArray(values) || typeof values !== 'object' ||
          Object.entries(values).some(([network, folder]) => !networks.includes(network) || !validFolder(folder))) throw new Error();
      return values;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('The saved local node storage locations could not be read.');
    }
  }
  _saveLocations(locations) {
    if (Object.keys(locations).length) writePrivate(this.cleanupFile, locations);
    else fs.rmSync(this.cleanupFile, { force: true });
  }
  _save(network, entry) {
    writePrivate(this.file, { version: 1, networks: { ...this._read(), [network]: entry } });
  }
  _path(network, folder) { return path.join(folder || this.profile, 'chicory-floresta', network); }
  _profileStoreMissing(network) {
    try {
      if (!fs.statSync(this.profile).isDirectory()) return false;
      const dir = this._path(network, null);
      const parent = fs.lstatSync(path.dirname(dir), { throwIfNoEntry: false });
      return !parent || parent.isDirectory() && !fs.lstatSync(dir, { throwIfNoEntry: false });
    } catch { return false; }
  }
  _hasNodeData(network, folder) {
    const dir = this._path(network, folder);
    const store = network === 'mainnet' ? dir : path.join(dir, network === 'testnet' ? 'testnet3' : network);
    try {
      return fs.readdirSync(store).some(name => !['chicory-managed.lock', 'chicory-owner.json', '.DS_Store', 'config.toml'].includes(name));
    } catch (error) { return error.code !== 'ENOENT'; }
  }
  status(network) {
    const { enabled, folder, used, storeDigest, checkpointQuickStart, checkpointHold } = this._saved(network);
    const node = this.nodes.get(network)?.status();
    let volumeAvailable = true;
    try { if (folder) volumeAvailable = fs.statSync(folder).isDirectory(); } catch { volumeAvailable = false; }
    return { requested: enabled, checkpointQuickStart, checkpointAccepted: node?.checkpointAccepted === true,
      storageNeedsRebuild: used && storeDigest !== this.digest,
      storagePath: this._path(network, folder),
      canConfirmRemoved: used && !enabled && !folder && this._profileStoreMissing(network),
      checkpointHold: node?.checkpointReason ?? (checkpointHold ? 'independent-replay-required' : null), storage: folder || 'Profile folder', storageUsed: used, volumeAvailable,
      customStorage: process.platform !== 'win32', removalAvailable: ['darwin', 'linux'].includes(process.platform),
      phase: this.errors.has(network) ? 'failed' : node?.phase || 'stopped', height: node?.height ?? null,
      validatedHeight: node?.validatedHeight ?? null, tipSynced: node?.tipSynced ?? null, error: this.errors.get(network) || node?.error || null,
      historicalVerification: node?.historicalVerification ?? 'unknown', historicalHeight: node?.historicalHeight ?? null,
      historicalTarget: node?.historicalTarget ?? null, watches: this.collection.get(network)?.summary ?? null };
  }
  async inspectStorage(network, state) {
    if (!state.volumeAvailable) return { ...state, freeBytes: null };
    const folder = this._saved(network).folder || this.profile;
    try {
      const { bavail, bsize } = await fs.promises.statfs(folder, { bigint: true });
      const free = bavail * bsize;
      return { ...state, freeBytes: free >= 0n && free <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(free) : null };
    } catch {
      return { ...state, freeBytes: null };
    }
  }
  pauseCollection(network) {
    const lease = this.collection.get(network);
    if (!lease) return;
    this.collection.delete(network);
    clearInterval(lease.timer);
    lease.controller.abort();
    try { Promise.resolve(this.setCollection(network, false)).catch(() => {}); } catch { /* The manager may have exited. */ }
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
        let savedHold = prefs.checkpointHold;
        this.nodes.set(network, this.create({ ...build, network, profileDirectory: this.profile, storageDirectory: prefs.folder, initialized: prefs.initialized, checkpointQuickStart: prefs.checkpointQuickStart,
          checkpointHold: prefs.checkpointHold, onStatus: state => {
            if (network !== 'mainnet' || state.checkpointHold === savedHold) return;
            this._save(network, { ...this._saved(network), checkpointHold: state.checkpointHold });
            savedHold = state.checkpointHold;
          } }));
      }
      const node = this.nodes.get(network);
      void node.start().then(() => {
        if (this.nodes.get(network) !== node) return;
        const saved = this._saved(network);
        if (!saved.enabled) return;
        if (!saved.initialized) this._save(network, { ...saved, initialized: true });
        this.refreshCollection();
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
        if (prefs.used && prefs.storeDigest !== this.digest) {
          throw new Error('Remove the previous local node data before starting this build. Its storage compatibility has not been verified.');
        }
        if (!prefs.enabled && !await confirm(prefs.checkpointQuickStart ? 'startCheckpoint' : 'start')) return this.status(network);
        if (!admitted()) throw new Error('Unlock Chicory and try again.');
        this._save(network, { ...prefs, storeDigest: this.digest, enabled: true, used: true });
        this._start(network, prefs);
      } else if (['allowCheckpoint', 'requireHistory'].includes(operation) && network === 'mainnet') {
        const enable = operation === 'allowCheckpoint';
        if (enable && !prefs.checkpointQuickStart && !await confirm('allowCheckpoint')) return this.status(network);
        if (!admitted()) throw new Error('Unlock Chicory and try again.');
        // Verification can fail while the native confirmation is open. Only
        // change the user's preference in the latest persisted state.
        this._save(network, { ...this._saved(network), checkpointQuickStart: enable });
        this.nodes.get(network)?.setCheckpointQuickStart(enable);
      } else if (operation === 'stop') {
        this._save(network, { ...prefs, enabled: false });
        this.pauseCollection(network);
        this.errors.delete(network);
        const node = this.nodes.get(network);
        if (node) { await node.stop(); this.nodes.delete(network); }
        this.errors.delete(network);
      } else if (operation === 'remove' && !prefs.enabled && prefs.used && !this.nodes.has(network)) {
        const missing = !prefs.folder && this._profileStoreMissing(network);
        if (!await confirm(missing ? 'confirmRemoved' : 'remove', this._path(network, prefs.folder))) return this.status(network);
        if (!admitted()) throw new Error('Unlock Chicory and try again.');
        try {
          if (missing) {
            if (!this._profileStoreMissing(network)) throw new Error('Node data reappeared.');
          } else {
            await this._remove(network, prefs.folder);
          }
          this._save(network, { ...prefs, storeDigest: null, used: false, initialized: false });
          const locations = this._locations();
          delete locations[network];
          this._saveLocations(locations);
          this.errors.delete(network);
        } catch { this.errors.set(network, 'Removal is pending. Reconnect the original local APFS or Linux ext4 volume, stop any other node using it, and retry with the prepared build. Unrecognized files prevent removal.'); }
      } else if (operation === 'folder' && !prefs.used && !prefs.enabled && process.platform !== 'win32') {
        const picked = await folder();
        if (!admitted()) throw new Error('Unlock Chicory and try again.');
        if (picked) this._save(network, { ...prefs, folder: fs.realpathSync(picked) });
      } else throw new Error('This local node setting is unavailable.');
      return this.status(network);
    } finally { this.inFlight.delete(network); }
  }
  _remove(network, folder) {
    const build = this.load(this.root, this.digest);
    const task = this.remove({ ...build, network, profileDirectory: this.profile, storageDirectory: folder });
    this.removals.set(network, task);
    return task.finally(() => this.removals.delete(network));
  }
  async prepareErase(confirmRemaining) {
    // A still-live node keeps the kernel lock. It can leave its own data
    // pending but must never prevent an explicitly confirmed wallet key erase.
    await this.stopAll().catch(() => {});
    const epoch = this.epoch;
    // Persist only unresolved locations after an explicit wallet erase, so
    // an absent removable drive cannot hold the wallet keys hostage.
    const remaining = {};
    let unreadable = false;
    let entries = {}, locations = {};
    try { entries = this._read(); } catch { unreadable = true; }
    try { locations = this._locations(); } catch { unreadable = true; }
    for (const network of networks) {
      const known = Object.hasOwn(locations, network);
      const entry = entries[network];
      const folder = known ? locations[network] : entry?.folder ?? null;
      if (!known && (!entry || entry.used === false) && !this._hasNodeData(network, null)) continue;
      try { await this._remove(network, folder); }
      catch { remaining[network] = folder; }
    }
    const paths = Object.entries(remaining).map(([network, folder]) => this._path(network, folder));
    if (unreadable) paths.push('An unreadable storage location record. Check any location previously selected in Settings.');
    const consent = !paths.length || await confirmRemaining(paths);
    if (!consent || this.epoch !== epoch) {
      if (this.epoch === epoch) { this.closed = false; this.resume(); }
      return false;
    }
    this._saveLocations(remaining);
    fs.rmSync(this.file, { force: true });
    return true;
  }
  afterErase() {
    if (this.nodes.size === 0) this.closed = false;
  }
  async stopAll({ reset = false } = {}) {
    this.closed = true;
    this.epoch++;
    for (const network of this.collection.keys()) this.pauseCollection(network);
    const outcomes = await Promise.allSettled([...this.nodes].map(async ([network, node]) => {
      await node.stop();
      this.nodes.delete(network);
    }));
    await Promise.allSettled(this.removals.values());
    this.errors.clear();
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('A local node is still stopping.');
    if (reset) {
      fs.rmSync(this.file, { force: true });
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
    const state = op === 'status' ? settings.status(network) : await settings.change(network, op, {
      current,
      confirm: async (action, location) => (await appLock.duringPrompt(() => dialog.showMessageBox(window(), action === 'remove' ? {
        type: 'warning', title: 'Remove local node data', message: 'Remove generated ' + network + ' node data?',
        detail: 'This removes the chain database, public wallet and channel watches, and verification records in ' + location + '. A future sync starts over.',
        buttons: ['Remove node data', 'Cancel'], defaultId: 1, cancelId: 1
      } : action === 'confirmRemoved' ? {
        type: 'question', title: 'Confirm node data removal', message: 'Start the next sync with fresh storage?',
        detail: 'The node directory at ' + location + ' is absent. Confirm to clear its saved storage record.',
        buttons: ['Confirm removal', 'Cancel'], defaultId: 1, cancelId: 1
      } : action === 'allowCheckpoint' ? {
        type: 'question', title: 'Checkpoint quick start', message: 'Trust Floresta’s mainnet checkpoint during verification?',
        detail: 'Floresta will temporarily trust the state at block 939,969 while independently checking older blocks. Local wallet reads still require the current tip and completed wallet scans. Lightning also requires its channel safety checks. A verification failure withdraws access. This preference applies to this build and mainnet profile.',
        buttons: ['Allow checkpoint quick start', 'Cancel'], defaultId: 1, cancelId: 1
      } : {
        type: 'question', title: 'Floresta qualification', message: 'Start a ' + network + ' node?',
        detail: (action === 'startCheckpoint' ? 'Quick start trusts Floresta’s mainnet checkpoint at block 939,969 while earlier history is verified in the background. ' : network === 'mainnet' ? 'Local wallet reads will wait for full historical verification. ' : '') + 'Floresta downloads blocks over its own peer connections and stores public wallet and channel watches in the selected node folder. Initial sync and historical backfill can use substantial storage and bandwidth. Your wallet and Lightning channels keep using your selected Electrum server. Sync resumes when you reopen this development build with the same candidate.',
        buttons: [action === 'startCheckpoint' ? 'Start with checkpoint' : 'Start node', 'Cancel'], defaultId: 1, cancelId: 1
      }))).response === 0,
      folder: async () => {
        const answer = await appLock.duringPrompt(() => dialog.showOpenDialog(window(), {
          title: 'Choose a folder for local Bitcoin data', properties: ['openDirectory', 'createDirectory']
        }));
        return answer.canceled ? null : answer.filePaths[0];
      }
    });
    const inspected = await settings.inspectStorage(network, state);
    if (!current()) throw new Error('Local node settings are locked.');
    return inspected;
  });
}

module.exports = { candidateDigest, candidate, FlorestaSettings, installFlorestaIpc };
