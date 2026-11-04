'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { installFullBackupIpc, MAX_ARCHIVE_BYTES } = require('./full-backup-ipc.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-full-ipc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function harness(t, overrides = {}) {
  const directory = temporary(t);
  const handlers = new Map();
  const calls = [];
  const prompts = [];
  let grant = true;
  let locked = false;
  const options = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    trusted: event => event.trusted === true,
    appLock: { takeGrant: () => grant, required: () => locked, duringPrompt: async raise => { prompts.push('prompt'); return raise(); } },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(directory, 'backup.chicory') }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [path.join(directory, 'in.chicory')] }),
    },
    window: () => ({}),
    documents: () => directory,
    fs,
    call: async (route, body, options = {}) => { calls.push([route, body, options]); return options.raw ? Buffer.from('CHICORYFULL1 sealed bytes') : { restored: [{ id: 'w1' }], failed: [] }; },
    now: () => new Date('2026-11-04T12:00:00Z'),
    ...overrides,
  };
  installFullBackupIpc(options);
  const invoke = (channel, value, event = { trusted: true }) => handlers.get(channel)(event, value);
  return { invoke, calls, prompts, directory, setGrant: value => { grant = value; }, setLocked: value => { locked = value; } };
}

test('only the app window, with a real passphrase, can ask', async t => {
  const { invoke, calls } = harness(t);
  for (const [value, event] of [['a passphrase', { trusted: false }], [undefined, undefined], [{ passphrase: 'x' }, undefined], ['', undefined], ['x'.repeat(1025), undefined]]) {
    for (const channel of ['backup:export-full', 'backup:restore-full'])
      assert.equal((await invoke(channel, value, event)).code, 'REFUSED');
  }
  assert.deepEqual(calls, []);
});

test('export needs the lock grant, saves through a partial file and leaves only the finished backup', async t => {
  const { invoke, calls, prompts, directory, setGrant } = harness(t);
  setGrant(false);
  assert.equal((await invoke('backup:export-full', 'a long passphrase here')).code, 'LOCKED');
  assert.deepEqual(calls, []);
  setGrant(true);
  const result = await invoke('backup:export-full', 'a long passphrase here');
  assert.deepEqual(result, { ok: true, file: 'backup.chicory', bytes: 25 });
  assert.deepEqual(calls, [['/api/backup/full/export', { passphrase: 'a long passphrase here' }, { raw: true }]]);
  assert.deepEqual(fs.readdirSync(directory), ['backup.chicory']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'backup.chicory')).mode & 0o777, 0o600);
  assert.equal(prompts.length, 1, 'the save dialog is one of Chicory\'s own prompts, so it does not relock or conceal');
});

test('a cancelled save asks the wallet service for nothing', async t => {
  const { invoke, calls } = harness(t, { dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.deepEqual(await invoke('backup:export-full', 'a long passphrase here'), { ok: false, cancelled: true });
  assert.deepEqual(calls, []);
});

test('a full disk leaves no partial or finished file behind', async t => {
  const failing = { ...fs, writeSync: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); } };
  const { invoke, directory } = harness(t, { fs: failing });
  const result = await invoke('backup:export-full', 'a long passphrase here');
  assert.equal(result.code, 'NO_SPACE');
  assert.match(result.error, /disk is full/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a refusal from the wallet service reaches the page with its code', async t => {
  const { invoke } = harness(t, { call: async () => { throw Object.assign(new Error('Use a passphrase of at least 12 characters for a full backup.'), { code: 'PASSPHRASE_TOO_SHORT' }); } });
  assert.deepEqual(await invoke('backup:export-full', 'short'), { ok: false, code: 'PASSPHRASE_TOO_SHORT', error: 'Use a passphrase of at least 12 characters for a full backup.' });
});

test('restore reads the chosen file in the main process and refuses what cannot be a backup', async t => {
  const { invoke, calls, directory, setLocked } = harness(t);
  setLocked(true);
  assert.equal((await invoke('backup:restore-full', 'a long passphrase here')).code, 'LOCKED');
  setLocked(false);
  assert.equal((await invoke('backup:restore-full', 'a long passphrase here')).code, 'BAD_ARCHIVE', 'a missing file');
  fs.writeFileSync(path.join(directory, 'in.chicory'), 'CHICORYFULL1 sealed bytes');
  const result = await invoke('backup:restore-full', 'a long passphrase here');
  assert.deepEqual(result, { ok: true, restored: [{ id: 'w1' }], failed: [] });
  assert.deepEqual(calls.at(-1), ['/api/backup/full/restore', { passphrase: 'a long passphrase here', archive: Buffer.from('CHICORYFULL1 sealed bytes').toString('base64') }, {}]);
  const huge = { ...fs, statSync: () => ({ isFile: () => true, size: MAX_ARCHIVE_BYTES + 1 }) };
  const large = harness(t, { fs: huge });
  assert.equal((await large.invoke('backup:restore-full', 'a long passphrase here')).code, 'BAD_ARCHIVE');
  assert.deepEqual(large.calls, [], 'an oversized file is never sent');
  const cancelled = harness(t, { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.deepEqual(await cancelled.invoke('backup:restore-full', 'a long passphrase here'), { ok: false, cancelled: true });
});
