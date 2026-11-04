'use strict';

const path = require('node:path');

/** The format's own archive cap. A larger file is not a full backup. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PASSPHRASE = 1024;
const FILTERS = [{ name: 'Chicory full backup', extensions: ['chicory'] }];

const MESSAGES = {
  refused: 'Full backup is unavailable.',
  locked: 'Confirm with your system authentication, then try again.',
  unlock: 'Unlock Chicory first.',
  tooLarge: 'That file is too large to be a Chicory full backup.',
  unreadable: 'That file could not be read.',
  space: 'The disk is full, so the backup was not saved. Nothing was left behind.',
  write: 'The backup could not be saved there. Nothing was left behind.',
};

/**
 * The full backup's file handling, in the main process: the archive goes
 * between the wallet service and a file the owner picks, and never through
 * the page. The page supplies only the passphrase. Exporting needs the app
 * lock's fresh grant, like a recovery phrase, since the file holds every key.
 * A save is written to a `.partial` file and renamed only once complete, so
 * a cancelled or failed save never leaves something that looks finished.
 */
function installFullBackupIpc({ ipcMain, trusted, appLock, dialog, window, documents, fs, call, now = () => new Date() }) {
  const passphraseOf = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_PASSPHRASE ? value : null;
  const prompt = raise => appLock.duringPrompt(raise);

  async function exportFull(passphrase) {
    if (!appLock.takeGrant()) return { ok: false, code: 'LOCKED', error: MESSAGES.locked };
    const stamp = now().toISOString().slice(0, 10);
    const { canceled, filePath } = await prompt(() => dialog.showSaveDialog(window(), { title: 'Save a full backup',
      defaultPath: path.join(documents(), `chicory-full-backup-${stamp}.chicory`), filters: FILTERS }));
    if (canceled || !filePath) return { ok: false, cancelled: true };
    const archive = await call('/api/backup/full/export', { passphrase }, { raw: true });
    const partial = `${filePath}.partial`;
    let descriptor;
    try {
      descriptor = fs.openSync(partial, 'wx', 0o600);
      for (let offset = 0; offset < archive.length;) offset += fs.writeSync(descriptor, archive, offset);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(partial, filePath);
      return { ok: true, file: path.basename(filePath), bytes: archive.length };
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      try { fs.rmSync(partial, { force: true }); } catch {}
      return { ok: false, code: error.code === 'ENOSPC' ? 'NO_SPACE' : 'WRITE_FAILED', error: error.code === 'ENOSPC' ? MESSAGES.space : MESSAGES.write };
    } finally { archive.fill(0); }
  }

  async function restoreFull(passphrase) {
    if (appLock.required()) return { ok: false, code: 'LOCKED', error: MESSAGES.unlock };
    const { canceled, filePaths } = await prompt(() => dialog.showOpenDialog(window(), { title: 'Choose a full backup',
      properties: ['openFile'], filters: FILTERS }));
    if (canceled || !filePaths?.[0]) return { ok: false, cancelled: true };
    let archive;
    try {
      const stat = fs.statSync(filePaths[0]);
      if (!stat.isFile()) return { ok: false, code: 'BAD_ARCHIVE', error: MESSAGES.unreadable };
      if (stat.size > MAX_ARCHIVE_BYTES) return { ok: false, code: 'BAD_ARCHIVE', error: MESSAGES.tooLarge };
      archive = fs.readFileSync(filePaths[0]);
    } catch { return { ok: false, code: 'BAD_ARCHIVE', error: MESSAGES.unreadable }; }
    try {
      return { ok: true, ...(await call('/api/backup/full/restore', { passphrase, archive: archive.toString('base64') })) };
    } finally { archive.fill(0); }
  }

  const handle = (channel, action) => ipcMain.handle(channel, async (event, value) => {
    const passphrase = passphraseOf(value);
    if (!trusted(event) || !passphrase) return { ok: false, code: 'REFUSED', error: MESSAGES.refused };
    try { return await action(passphrase); }
    catch (error) { return { ok: false, code: error.code || 'FAILED', error: error.message || MESSAGES.refused }; }
  });
  handle('backup:export-full', exportFull);
  handle('backup:restore-full', restoreFull);
}

module.exports = { installFullBackupIpc, MAX_ARCHIVE_BYTES, MESSAGES };
