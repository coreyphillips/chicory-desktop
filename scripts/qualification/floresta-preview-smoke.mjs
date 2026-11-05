import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { acceptRegtestStart } from './floresta-preview-stage.mjs';

const [executable] = process.argv.slice(2);
if (!executable || !path.isAbsolute(executable)) throw new Error('Pass the absolute path to the packaged preview executable.');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-preview-smoke-'));
let electron;
try {
  const args = process.platform === 'linux' ? ['--password-store=gnome-libsecret'] :
    process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
  electron = await _electron.launch({ executablePath: executable, args, chromiumSandbox: true,
    env: { ...process.env, CHICORY_PROFILE_DIR: profile }, timeout: 60000 });
  const page = await electron.firstWindow();
  await page.waitForURL('chicory-app://wallet/?setup', { timeout: 60000 });
  const wallets = await page.evaluate(async () => (await fetch('/api/wallets')).json());
  assert.deepEqual(wallets, { ok: true, result: [] });
  await acceptRegtestStart(electron);
  const status = () => page.evaluate(() => window.chicoryDesktop.floresta.status('regtest'));
  assert.equal((await status()).requested, false);
  await page.evaluate(() => window.chicoryDesktop.floresta.start('regtest'));
  await expect.poll(status, { timeout: 60000 }).toMatchObject({ phase: 'running', requested: true, height: 0 });
  const stopped = await page.evaluate(() => window.chicoryDesktop.floresta.stop('regtest'));
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.requested, false);
  assert.equal(stopped.storageUsed, true);
  console.log('Packaged Settings IPC started the bundled daemon at regtest genesis and stopped it.');
} finally {
  try {
    if (electron) {
      const child = electron.process();
      await electron.close();
      await expect.poll(() => child.exitCode, { timeout: 15000 }).toBe(0);
    }
  } finally {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}
