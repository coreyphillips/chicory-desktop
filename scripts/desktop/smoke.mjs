import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';
import { bech32Encode, convertBits } from '../../node_modules/@beignet/wallet-core/src/payment-uri.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = path.resolve(process.env.CHICORY_SMOKE_OUTPUT || path.join(root, 'artifacts/smoke'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-desktop-demo-'));
await fs.mkdir(output, { recursive: true });
const errors = [];
const consoleErrors = [];
const checks = [];
let electron;
let page;

async function nativeMenu(label) {
  await electron.evaluate(({ Menu, BrowserWindow }, wanted) => {
    const find = menu => {
      for (const item of menu?.items || []) {
        if (item.label === wanted) return item;
        const nested = find(item.submenu);
        if (nested) return nested;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu());
    if (!item?.click) throw new Error(`Native menu item not found: ${wanted}`);
    item.click(item, BrowserWindow.getAllWindows()[0], {});
  }, label);
  const active = label === 'Overview' ? 'home' : label.toLowerCase();
  await expect(page.locator(`.browser-sidebar button[data-scene="${active}"]`)).toHaveAttribute('aria-current', 'page');
  await page.waitForTimeout(1000);
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'allow' });
}

try {
  electron = await _electron.launch({
    executablePath: process.env.CHICORY_ELECTRON_EXECUTABLE || electronPath,
    args: [path.join(root, 'desktop/main.cjs'), '--demo'],
    cwd: root,
    env: { ...process.env, CHICORY_PROFILE_DIR: profile },
    timeout: 30000,
  });
  page = await electron.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await expect(page.locator('.browser-sidebar button[data-scene="send"]')).toBeEnabled({ timeout: 20000 });
  await page.waitForTimeout(1600);
  const security = await page.evaluate(() => ({
    origin: location.origin, require: typeof window.require, process: typeof window.process,
    bridge: Object.keys(window.chicoryDesktop || {}).sort(),
  }));
  assert.equal(security.origin, 'chicory-app://wallet');
  assert.equal(security.require, 'undefined');
  assert.equal(security.process, 'undefined');
  assert.deepEqual(security.bridge, ['close', 'minimize', 'onCommand', 'platform', 'toggleMaximize', 'version']);
  const preferences = await electron.evaluate(({ BrowserWindow }) => {
    const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  checks.push('Stable custom origin, sandbox, context isolation, no Node globals, narrow preload bridge');

  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
  await page.waitForTimeout(600);
  await screenshot('desktop-home');
  const sizes = await page.locator('[data-chicory-canvas]').evaluate(element => ({
    width: element.clientWidth, desktop: element.dataset.desktop,
  }));
  assert.equal(sizes.desktop, 'true');
  assert.ok(sizes.width > 1000);
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720));
  await page.waitForTimeout(700);
  await screenshot('desktop-compact');
  await expect(page.locator('[data-chicory-canvas]')).toHaveAttribute('data-desktop', 'true');
  assert.equal(await page.locator('.browser-nav-label').first().isVisible(), false);
  checks.push('Full navigation at 1320px and compact desktop rail at 960px');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));

  await nativeMenu('Send');
  const address = bech32Encode('bc', [0, ...convertBits(new Array(20).fill(7), 8, 5, true)]);
  await page.getByRole('textbox', { name: 'Payment request or address', exact: true }).fill(address);
  const amount = page.locator('[data-amount-entry]').first();
  await amount.focus();
  await page.keyboard.type('1251');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('0');
  await expect.poll(async () => (await amount.textContent()).replace(/\s/g, '')).toContain('1,250');
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  const hold = page.locator('[data-hold-confirmation]');
  await expect(hold).toBeVisible();
  await page.waitForTimeout(1000);
  await screenshot('desktop-send');
  await hold.focus();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(120);
  await page.keyboard.up('Enter');
  await page.waitForTimeout(1100);
  await expect(hold).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit payment', exact: true })).toBeVisible();
  checks.push('Physical amount entry and backspace, payment review, short hold cancels');

  await nativeMenu('Receive');
  const receiveAmount = page.locator('[data-amount-entry]').first();
  await receiveAmount.focus();
  await page.keyboard.type('2500');
  await expect.poll(async () => (await receiveAmount.textContent()).replace(/\s/g, '')).toContain('2,500');
  await screenshot('desktop-receive');
  await nativeMenu('Settings');
  await expect(page.getByText('This computer', { exact: true })).toBeVisible();
  await screenshot('desktop-settings');
  await nativeMenu('Activity');
  checks.push('Native Send, Receive, Settings, Activity and Overview menus');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await nativeMenu('Overview');
  await nativeMenu('Receive');
  await screenshot('desktop-reduced-motion');
  checks.push('Reduced-motion navigation remains responsive');

  // No daemon is started for the sample wallet, and its transport refuses APIs.
  const apiStatus = await page.evaluate(async () => (await fetch('/api/config')).status);
  assert.equal(apiStatus, 403);
  await assert.rejects(fs.stat(path.join(profile, 'wallets')), { code: 'ENOENT' });
  checks.push('Demo mode denies wallet APIs and creates no wallet data directory');
  assert.deepEqual(errors, [], 'No renderer exceptions');
  const unexpectedConsole = consoleErrors.filter(line => !/Failed to load resource:.*403/.test(line));
  assert.deepEqual(unexpectedConsole, [], 'No unexpected renderer console errors');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, security, preferences, errors, consoleErrors }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) {
    await screenshot('failure').catch(() => {});
    await fs.writeFile(path.join(output, 'failure.html'), await page.content()).catch(() => {});
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, error: String(error), errors, consoleErrors }, null, 2) + '\n');
  throw error;
} finally {
  if (electron) {
    await electron.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    await electron.close().catch(() => {});
  }
  await fs.rm(profile, { recursive: true, force: true });
}
