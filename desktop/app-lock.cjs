'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const LOCK_FILE = 'app-lock.json';
const MAX_LOCK_BYTES = 4096;
/** Matches mobile: a payment often bounces through another app or a prompt. */
const BACKGROUND_GRACE_MS = 30000;
/** A reveal grant covers the one request that follows its prompt. */
const REVEAL_GRANT_MS = 60000;
/** Focus returns a moment after a system prompt closes. */
const PROMPT_SETTLE_MS = 600;

const WALLET_ROUTE = /^\/(api|wallets)(\/|$)/;
const SECRET_ROUTES = [/^\/api\/wallets\/[^/]+\/recovery-phrase\/?$/, /^\/api\/backup(\/|$)/];

const MESSAGES = {
  cancelled: 'Authentication was cancelled. Chicory stays locked.',
  failed: 'Authentication did not succeed. Chicory stays locked.',
  unavailable: 'System authentication is unavailable. Turn on Touch ID, Windows Hello or your sign-in password, then retry. Chicory stays locked.',
  busy: 'An authentication prompt is already open.',
  locked: 'Unlock Chicory first.',
  enableCancelled: 'Authentication was cancelled. The app lock was not changed.',
  enableUnavailable: 'System authentication is unavailable on this computer.',
  saveFailed: 'The app lock setting could not be saved. It was not changed.',
};

function readMetadata(profile) {
  const file = path.join(profile, LOCK_FILE);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'missing', enabled: false } : { status: 'corrupt', enabled: true };
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return { status: 'corrupt', enabled: true };
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (value?.version !== 1 || typeof value.enabled !== 'boolean') return { status: 'corrupt', enabled: true };
    return { status: 'ok', enabled: value.enabled };
  } catch {
    // Unreadable metadata never turns an enabled lock off.
    return { status: 'corrupt', enabled: true };
  } finally { fs.closeSync(descriptor); }
}

function writeMetadata(profile, enabled) {
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const file = path.join(profile, LOCK_FILE);
  const temporary = path.join(profile, `.app-lock-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, enabled }) + '\n');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/**
 * The app lock lives in the main process. The renderer can ask for a prompt
 * but can never mark the app unlocked, and wallet routes are refused here
 * while it is locked. It is separate from storage encryption: the storage key
 * is only loaded once the lock has opened.
 */
class AppLock {
  constructor({ profile, authenticator, now = Date.now, graceMs = BACKGROUND_GRACE_MS,
    settleMs = PROMPT_SETTLE_MS, isForeground = () => true, onEvent = () => {}, timers = { setTimeout, clearTimeout } }) {
    this.profile = profile;
    this.authenticator = authenticator;
    this.now = now;
    this.graceMs = graceMs;
    this.settleMs = settleMs;
    this.isForeground = isForeground;
    this.onEvent = onEvent;
    this.timers = timers;
    const metadata = readMetadata(profile);
    this.enabled = metadata.enabled;
    this.metadataStatus = metadata.status;
    this.unlocked = !this.enabled;
    this.generation = 0;
    this.concealed = 0;
    this.controller = new AbortController();
    this.concealController = new AbortController();
    this.grant = null;
    this.backgroundedAt = null;
    this.prompting = 0;
    this.quietUntil = 0;
    this.unlocking = null;
    this.availability = null;
  }

  /** Whether wallet capabilities are held back right now. */
  required() { return this.enabled && !this.unlocked; }

  async kind() {
    this.availability ??= Promise.resolve()
      .then(() => this.authenticator.availability())
      .then(value => value?.kind ?? null, () => null);
    return this.availability;
  }

  async state() {
    return { enabled: this.enabled, locked: this.required(), kind: await this.kind(),
      repair: this.metadataStatus === 'corrupt' };
  }

  async duringPrompt(raise) {
    this.prompting += 1;
    try { return await raise(); }
    finally {
      this.prompting -= 1;
      this.backgroundedAt = null;
      this.quietUntil = this.now() + this.settleMs;
      // A switch away while our own prompt was up still counts once it closes.
      this.timers.setTimeout(() => { if (!this.isForeground()) this.background('blur'); }, this.settleMs);
    }
  }

  quiet() { return this.prompting > 0 || this.now() < this.quietUntil; }

  async authenticate(purpose) {
    if (this.prompting) return { ok: false, reason: 'busy', error: MESSAGES.busy };
    let result;
    try { result = await this.duringPrompt(() => this.authenticator.authenticate(purpose)); }
    catch { result = { ok: false, reason: 'failed' }; }
    if (result?.ok === true) return { ok: true };
    const reason = ['cancelled', 'unavailable', 'busy'].includes(result?.reason) ? result.reason : 'failed';
    return { ok: false, reason, error: MESSAGES[reason] };
  }

  /** Opens the gate. Concurrent callers share one prompt. */
  unlock() {
    if (!this.enabled) { this.unlocked = true; return Promise.resolve({ ok: true }); }
    this.foreground();
    if (this.unlocked) return Promise.resolve({ ok: true });
    this.unlocking ??= this.authenticate('unlock').then(result => {
      if (result.ok) {
        this.unlocked = true;
        this.backgroundedAt = null;
        if (this.metadataStatus === 'corrupt') {
          // Repair to the fail-closed reading once its owner has proved presence.
          try { writeMetadata(this.profile, true); this.metadataStatus = 'ok'; } catch {}
        }
        this.onEvent('unlocked');
      }
      return result;
    }).finally(() => { this.unlocking = null; });
    return this.unlocking;
  }

  async setEnabled(next) {
    if (next !== true && next !== false) return { ok: false, error: MESSAGES.saveFailed };
    if (this.required()) return { ok: false, error: MESSAGES.locked };
    if (next === this.enabled && this.metadataStatus === 'ok') return { ok: true };
    if (next) {
      this.availability = null;
      if (!(await this.kind())) return { ok: false, error: MESSAGES.enableUnavailable };
      const result = await this.authenticate('enable');
      if (!result.ok) {
        return { ok: false, error: result.reason === 'cancelled' ? MESSAGES.enableCancelled
          : result.reason === 'unavailable' ? MESSAGES.enableUnavailable : result.error };
      }
    }
    try { writeMetadata(this.profile, next); }
    catch { return { ok: false, error: MESSAGES.saveFailed }; }
    this.enabled = next;
    this.metadataStatus = 'ok';
    this.unlocked = true;
    this.grant = null;
    this.onEvent('changed', next);
    return { ok: true };
  }

  /** Fresh authentication for a recovery phrase or backup, granting one request. */
  async authorizeSecret() {
    if (!this.enabled) return { ok: true };
    if (this.required()) return { ok: false, error: MESSAGES.locked };
    const result = await this.authenticate('reveal');
    if (!result.ok) return result;
    if (this.required()) return { ok: false, error: MESSAGES.locked };
    this.grant = { expires: this.now() + REVEAL_GRANT_MS, generation: this.generation, concealed: this.concealed };
    return { ok: true };
  }

  relock(reason) {
    if (!this.enabled) return;
    const wasUnlocked = this.unlocked;
    this.unlocked = false;
    this.generation += 1;
    this.grant = null;
    this.backgroundedAt = null;
    this.controller.abort();
    this.controller = new AbortController();
    if (wasUnlocked) this.onEvent('locked', reason);
  }

  /** Something other than this person may see the screen: drop shown secrets. */
  conceal(reason) {
    if (reason === 'blur' && this.quiet()) return;
    this.concealed += 1;
    this.grant = null;
    this.concealController.abort();
    this.concealController = new AbortController();
    this.onEvent('conceal', reason);
  }

  background(reason = 'blur') {
    if (this.quiet()) return;
    this.conceal(reason);
    this.backgroundedAt ??= this.now();
  }

  foreground() {
    if (this.prompting) return;
    const since = this.backgroundedAt;
    this.backgroundedAt = null;
    if (since !== null && this.now() - since > this.graceMs) this.relock('grace');
  }

  /** Admits a renderer request for a wallet route, or refuses it while locked. */
  admit(pathname) {
    if (!WALLET_ROUTE.test(pathname)) return { ok: true, ticket: null };
    if (this.required()) return { ok: false };
    const secret = this.enabled && SECRET_ROUTES.some(route => route.test(pathname));
    if (secret) {
      const grant = this.grant;
      this.grant = null;
      if (!grant || grant.expires < this.now() || grant.generation !== this.generation || grant.concealed !== this.concealed)
        return { ok: false };
    }
    const signals = [this.controller.signal, ...(secret ? [this.concealController.signal] : [])];
    return { ok: true, ticket: { generation: this.generation, concealed: secret ? this.concealed : null,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } };
  }

  /** Whether a response may still be delivered for a ticket admitted earlier. */
  current(ticket) {
    if (!ticket) return true;
    return !this.required() && ticket.generation === this.generation &&
      (ticket.concealed === null || ticket.concealed === this.concealed);
  }
}

/**
 * Lock IPC for the main window's top frame only. Arguments from the renderer
 * never decide the outcome: unlock and authorize always go through the system
 * prompt, and the setting accepts nothing but a literal boolean.
 */
function installLockIpc({ ipcMain, appLock, trusted, ensureManager }) {
  const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { ok: false, reason: 'refused', error: 'Refused.' };
    return action(...args);
  });
  handle('lock:state', () => appLock.state());
  handle('lock:unlock', async () => {
    const result = await appLock.unlock();
    if (!result.ok) return result;
    try { await ensureManager(); } catch { return { ok: false, reason: 'failed', error: 'The local wallet could not start.' }; }
    return appLock.required() ? { ok: false, reason: 'failed', error: 'Chicory locked again before it opened.' } : result;
  });
  handle('lock:set-enabled', (enabled) => appLock.setEnabled(enabled));
  handle('lock:authorize', () => appLock.authorizeSecret());
}

module.exports = { AppLock, installLockIpc, LOCK_FILE, BACKGROUND_GRACE_MS, REVEAL_GRANT_MS, MESSAGES, readMetadata };
