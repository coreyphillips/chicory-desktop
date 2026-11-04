'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Written before anything is deleted and removed only once everything is.
 * While it exists, startup finishes the erase before it opens any key, so an
 * interrupted erase can never come back as a half-erased wallet or a new
 * wallet beside old data.
 */
const ERASE_MARKER = 'erase-pending.json';

/**
 * What an erase removes from the profile, in this order. The storage key goes
 * first: without it every encrypted wallet file left behind is unreadable.
 * Then the wallet service's data (every wallet on every network, its seeds,
 * databases, journals, activity metadata and settings), Tor's cached state,
 * and staged updates. The app lock setting and the redacted diagnostics log
 * are kept, as are files Chicory does not own.
 */
const ERASED_ENTRIES = Object.freeze(['storage-key.json', 'wallets', 'tor', 'updates']);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function hasPendingErase(profile, io = fs) {
  try { io.lstatSync(path.join(profile, ERASE_MARKER)); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

function writeMarker(profile, io = fs, now = Date.now) {
  const file = path.join(profile, ERASE_MARKER);
  const descriptor = io.openSync(file, 'w', 0o600);
  try {
    io.writeSync(descriptor, JSON.stringify({ version: 1, startedAt: new Date(now()).toISOString() }) + '\n');
    io.fsyncSync(descriptor);
  } finally { io.closeSync(descriptor); }
}

function clearMarker(profile, io = fs) {
  io.rmSync(path.join(profile, ERASE_MARKER), { force: true });
}

/**
 * Removes the erasable entries of one profile. A symbolic link is removed as
 * a link and never followed, at the top or anywhere below, so nothing outside
 * the profile can be reached. Returns what could not be removed, so a partial
 * erase stays visible and can be retried.
 */
function eraseProfileData(profile, io = fs) {
  if (typeof profile !== 'string' || !path.isAbsolute(profile))
    throw failure('ERASE_UNSAFE', 'The profile to erase must be an absolute directory.');
  const failed = [];
  const removed = [];
  for (const name of ERASED_ENTRIES) {
    const target = path.join(profile, name);
    let stat;
    try { stat = io.lstatSync(target); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      failed.push({ entry: name, code: error.code || 'UNKNOWN' });
      continue;
    }
    try {
      // fs.rm removes a link itself rather than what it points at, and does
      // not descend through links inside a directory.
      if (stat.isSymbolicLink() || !stat.isDirectory()) io.rmSync(target, { force: true });
      else io.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      io.lstatSync(target);
      failed.push({ entry: name, code: 'STILL_PRESENT' });
    } catch (error) {
      if (error.code === 'ENOENT') removed.push(name);
      else failed.push({ entry: name, code: error.code || 'UNKNOWN' });
    }
  }
  return { removed, failed };
}

const MESSAGES = {
  busy: 'Chicory is busy protecting wallet storage or installing an update. Try again shortly.',
  locked: 'Unlock Chicory and confirm again to erase.',
  engines: 'A wallet engine did not stop cleanly, so nothing was erased. Quit Chicory, reopen it, and try again.',
  partial: 'Erasing did not finish. Some wallet files could not be removed. Your wallets cannot be opened again, but the erase must complete before Chicory can start over. Try again.',
  storage: 'Erasing did not finish because local app data could not be cleared. Try again.',
};

/**
 * One erase of every wallet in a profile, coordinated with the main process
 * through the functions it is given, in an order that never leaves old
 * wallet state readable after success is reported:
 *
 * 1. refuse unless the app lock grants it and no key or update work is under
 *    way, then hold that same gate (`exclusive`) for the rest,
 * 2. stop the wallet service and every engine, and stop if any did not exit
 *    cleanly, before anything is deleted,
 * 3. stop Tor, write the marker, delete the profile's wallet data and the
 *    renderer's stored state,
 * 4. remove the marker only when all of that succeeded, release the gate,
 *    and start over.
 *
 * Concurrent requests share one run. A failure after the marker is written
 * keeps it, so a retry or the next launch (`resume`) finishes the job.
 */
class ProfileEraser {
  constructor({ profile, io = fs, now = Date.now, authorize, busy = () => false, exclusive = task => task(),
    stopService, stopTor, clearRendererState, startOver, record = () => {} }) {
    Object.assign(this, { profile, io, now, authorize, busy, exclusive, stopService, stopTor, clearRendererState, startOver, record });
    this.running = null;
  }

  erase() {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  /** Finishes an erase the marker says was interrupted. Nothing is running yet at startup. */
  resume() {
    this.running ??= this.exclusive(() => this.remove()).finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    if (!this.authorize()) return { ok: false, code: 'ERASE_LOCKED', error: MESSAGES.locked };
    if (this.busy()) return { ok: false, code: 'ERASE_BUSY', error: MESSAGES.busy };
    const result = await this.exclusive(async () => {
      this.record('erase started');
      const service = await this.stopService();
      // A service that was killed at its deadline may have left an engine
      // writing to the files this would delete.
      if (service !== 'exited' && service !== 'not-running') {
        this.record(`erase refused: wallet service ${service}`);
        return { ok: false, code: 'ERASE_ENGINES', error: MESSAGES.engines };
      }
      await this.stopTor();
      return this.remove();
    });
    if (!result.ok) return result;
    // The erase is complete whatever happens next. Starting the fresh wallet
    // service reports its own failures.
    try { await this.startOver(); } catch { this.record('start over after erase failed'); }
    return result;
  }

  async remove() {
    writeMarker(this.profile, this.io, this.now);
    const { removed, failed } = eraseProfileData(this.profile, this.io);
    if (failed.length) {
      this.record(`erase incomplete: ${failed.map(item => `${item.entry} ${item.code}`).join(', ')}`);
      return { ok: false, code: 'ERASE_INCOMPLETE', error: MESSAGES.partial, failed };
    }
    try { await this.clearRendererState(); }
    catch {
      this.record('erase incomplete: renderer storage');
      return { ok: false, code: 'ERASE_INCOMPLETE', error: MESSAGES.storage, failed: [{ entry: 'renderer', code: 'CLEAR_FAILED' }] };
    }
    clearMarker(this.profile, this.io);
    this.record(`erase finished: ${removed.join(', ') || 'nothing stored'}`);
    return { ok: true, removed };
  }
}

module.exports = { ERASE_MARKER, ERASED_ENTRIES, MESSAGES, ProfileEraser, eraseProfileData, hasPendingErase, writeMarker, clearMarker };
