// Source Electron smoke. Use a disposable profile with no live Beignet wallets.
// The native dialog is answered by the test; the renderer uses the real IPC bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';
import settings from '../../desktop/floresta-settings.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({ options: { digest: { type: 'string' } } });
settings.candidate(root, values.digest);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-ui-'));
let electron;
async function open() {
  electron = await _electron.launch({ executablePath: electronPath, cwd: root, args: [path.join(root, 'desktop/main.cjs')],
    env: { ...process.env, CHICORY_PROFILE_DIR: profile, CHICORY_MANUAL_SETUP: '1', CHICORY_FLORESTA_CANDIDATE_SHA256: values.digest } });
  const page = await electron.firstWindow({ timeout: 30000 });
  await page.waitForURL('chicory-app://wallet/?setup');
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/wallets')).json())).toEqual({ ok: true, result: [] });
  return page;
}
async function quit() {
  if (!electron) return;
  const closed = electron.waitForEvent('close', { timeout: 40000 });
  await electron.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  electron = null;
}
try {
  let page = await open();
  // Only the view is a demo here. The main process and Floresta IPC belong to the source app.
  await page.goto('chicory-app://wallet/?demo');
  await page.locator('.browser-sidebar button[data-scene="settings"]').click();
  await page.getByText('Network & servers', { exact: true }).click();
  await page.getByText('Experimental Floresta node', { exact: true }).click();
  const start = page.getByRole('button', { name: 'Start local node', exact: true });
  await expect(start).toBeVisible();
  await electron.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_window, options) => {
      if (options.title !== 'Floresta qualification' || !options.detail.includes('public wallet and channel watches') ||
          !options.detail.includes('selected Electrum server')) throw new Error('Missing native consent disclosure');
      return { response: 1, checkboxChecked: false };
    };
  });
  await start.click();
  await expect(start).toBeEnabled();
  const startStatus = await page.evaluate(() => window.chicoryDesktop.floresta.status('mainnet'));
  assert.equal(startStatus.requested, false);
  await electron.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_window, options) => {
      if (options.title !== 'Floresta qualification' || options.message !== 'Start a regtest node?') throw new Error('Unexpected prompt');
      return { response: 0, checkboxChecked: false };
    };
  });
  await page.evaluate(() => window.chicoryDesktop.floresta.start('regtest'));
  const status = () => page.evaluate(() => window.chicoryDesktop.floresta.status('regtest'));
  await expect.poll(async () => (await status()).phase, { timeout: 30000 }).toBe('running');
  assert.equal((await status()).height, 0);
  await quit();
  page = await open();
  await expect.poll(async () => (await status()).phase, { timeout: 30000 }).toBe('running');
  const stopped = await page.evaluate(() => window.chicoryDesktop.floresta.stop('regtest'));
  assert.equal(stopped.requested, false);
  assert.equal(stopped.phase, 'stopped');
  console.log('Source Settings, native consent, isolated regtest sync, consent-bound resume and clean disable passed.');
} finally {
  await quit();
  await fs.rm(profile, { recursive: true, force: true });
}
