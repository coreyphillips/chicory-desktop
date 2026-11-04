import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { exportFullBackup, fullBackupAvailable, restoreFullBackup } from './fullBackup.ts';

afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
function bridge(answers: { export?: unknown; restore?: unknown }) {
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: { fullBackup: {
    export: async (passphrase: string) => { calls.push(`export:${passphrase}`); return answers.export; },
    restore: async (passphrase: string) => { calls.push(`restore:${passphrase}`); return answers.restore; },
  } } } });
  return calls;
}

test('a plain browser offers no full backup', async () => {
  assert.equal(fullBackupAvailable(), false);
  await assert.rejects(exportFullBackup('a long passphrase'), /only available in the desktop app/);
  await assert.rejects(restoreFullBackup('a long passphrase'), /only available in the desktop app/);
});

test('the desktop bridge saves and restores by passphrase, and a cancelled dialog is not an error', async () => {
  const calls = bridge({ export: { ok: true, file: 'backup.chicory' }, restore: { ok: true, restored: [{ id: 'w1', name: 'Everyday', network: 'regtest' }] } });
  assert.equal(fullBackupAvailable(), true);
  assert.deepEqual(await exportFullBackup('a long passphrase'), { file: 'backup.chicory' });
  assert.deepEqual(await restoreFullBackup('a long passphrase'), { restored: [{ id: 'w1', name: 'Everyday', network: 'regtest' }], failed: [], skipped: [] });
  assert.deepEqual(calls, ['export:a long passphrase', 'restore:a long passphrase']);
  bridge({ export: { ok: false, cancelled: true }, restore: { ok: false, cancelled: true } });
  assert.equal(await exportFullBackup('a long passphrase'), null);
  assert.equal(await restoreFullBackup('a long passphrase'), null);
});

test('a refusal keeps its message and code', async () => {
  bridge({ restore: { ok: false, code: 'BAD_PASSPHRASE', error: 'That passphrase does not open this full backup. Nothing was changed.' } });
  await assert.rejects(restoreFullBackup('a wrong passphrase'), (error: Error & { code?: string }) =>
    error.code === 'BAD_PASSPHRASE' && /does not open/.test(error.message));
});
