import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.CHICORY_ELECTRON_EXECUTABLE;
const output = path.resolve(process.env.CHICORY_SMOKE_OUTPUT || path.join(root, 'artifacts/live-smoke'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-desktop-live-'));
await fs.mkdir(output, { recursive: true });
const checks = [];
const errors = [];
const managerPids = [];
let electron;
let page;

function processTree() {
  if (process.platform === 'win32') {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'],
    { encoding: 'utf8' })).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, name: row.Name }));
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && { pid: Number(match[1]), parent: Number(match[2]), name: match[3] };
  }).filter(Boolean);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function open() {
  electron = await _electron.launch({
    executablePath: executable || electronPath,
    args: executable ? [] : [path.join(root, 'desktop/main.cjs')],
    cwd: root,
    // It checks an empty first run, so the app makes no wallet unasked.
    env: { ...process.env, CHICORY_PROFILE_DIR: profile, CHICORY_MANUAL_SETUP: '1' },
    timeout: 30000,
  });
  page = await electron.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForURL('chicory-app://wallet/?setup', { timeout: 30000 });
  await expect(page.locator('.desktop-titlebar')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/config')).status)).toBe(200);
  const children = processTree().filter(item => item.parent === electron.process().pid);
  const manager = children.find(item => /(?:^|[/\\])node(?:\.exe)?$/.test(item.name));
  assert.ok(manager, 'The packaged standalone Node manager is a child of the app');
  managerPids.push(manager.pid);
  return manager.pid;
}

async function quit() {
  if (!electron) return;
  const instance = electron;
  const process = instance.process();
  const closed = instance.waitForEvent('close', { timeout: 30000 });
  await instance.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(error => {
    if (!/closed|destroyed/i.test(String(error))) throw error;
  });
  await closed;
  await expect.poll(() => process.exitCode, { timeout: 10000 }).toBe(0);
  electron = undefined;
  page = undefined;
  for (const pid of managerPids) {
    await expect.poll(() => alive(pid), { timeout: 10000 }).toBe(false);
  }
}

try {
  const firstManager = await open();
  const configuration = await page.evaluate(async () => (await fetch('/api/config')).json());
  assert.equal(configuration.ok, true);
  assert.equal(configuration.result.engineVersion, '0.38.0');
  const wallets = await page.evaluate(async () => (await fetch('/api/wallets')).json());
  assert.deepEqual(wallets, { ok: true, result: [] });
  const state = await electron.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    profile: app.getPath('userData'),
    preferences: (() => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration };
    })(),
  }));
  assert.equal(state.profile, profile);
  assert.equal(state.preferences.sandbox, true);
  assert.equal(state.preferences.contextIsolation, true);
  assert.equal(state.preferences.nodeIntegration, false);
  if (executable) assert.equal(state.packaged, true);
  const isolation = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
  assert.deepEqual(isolation, { require: 'undefined', process: 'undefined' });
  const envelope = JSON.parse(await fs.readFile(path.join(profile, 'storage-key.json'), 'utf8'));
  assert.equal(envelope.provider, 'electron.safeStorage');
  assert.equal(envelope.version, 1);
  assert.ok(envelope.ciphertext.length > 32);
  const marker = await fs.readFile(path.join(profile, 'wallets/.vault-v1'));
  assert.equal(marker.subarray(0, Buffer.byteLength('CHICORYVAULT1')).toString(), 'CHICORYVAULT1');
  assert.equal(marker.includes(Buffer.from('version')), false);
  checks.push('OS-protected storage key, authenticated encrypted vault marker and restart continuity');
  checks.push('Isolated real profile, live manager API, Beignet 0.38.0, zero wallets, sandboxed renderer');

  if (process.env.CHICORY_SMOKE_TOR === '1') {
    // Tor Project's published Onion-Location address, used only to exercise
    // the app's private manager/main bridge. It is not an Electrum server.
    await page.evaluate(async () => {
      const response = await fetch('/api/electrum/test', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion', port: 80, tls: false }),
        signal: AbortSignal.timeout(140000) });
      if (!response.ok) throw new Error('Desktop Tor bridge request failed.');
    });
    const torStatus = await page.evaluate(async () => (await (await fetch('/api/config')).json()).result.torStatus);
    assert.equal(torStatus.phase, 'ready');
    assert.equal(torStatus.progress, 100);
    const torProcess = processTree().find(item => item.parent === electron.process().pid && /(?:^|[/\\])tor(?:\.exe)?$/.test(item.name));
    assert.ok(torProcess, 'The bundled Tor process is owned by the app');
    managerPids.push(torProcess.pid);
    checks.push('Real bundled Tor reaches 100% through private manager IPC and an onion bridge');
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const listeners = execFileSync('lsof', ['-nP', '-a', '-p', String(firstManager), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    const addresses = listeners.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    assert.equal(addresses.length, 1);
    assert.match(addresses[0], /^127\.0\.0\.1:\d+$/);
    const forbidden = await fetch(`http://${addresses[0]}/api/wallets`);
    assert.equal(forbidden.status, 403);
    checks.push('Manager listens only on loopback and rejects unauthenticated local API access');
  }

  await page.evaluate(() => localStorage.setItem('chicory-desktop-smoke-preference', 'persisted'));
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(output, 'desktop-first-run.png') });
  await quit();
  checks.push('Explicit quit exits cleanly and stops the local manager');

  const secondManager = await open();
  assert.notEqual(secondManager, firstManager);
  assert.equal(await page.evaluate(() => localStorage.getItem('chicory-desktop-smoke-preference')), 'persisted');
  assert.deepEqual(await page.evaluate(async () => (await fetch('/api/wallets')).json()), { ok: true, result: [] });
  checks.push('Public local preference persists across a real app restart at its stable origin');
  await quit();
  assert.deepEqual(errors, [], 'No renderer exceptions');
  const report = { passed: true, packaged: state.packaged, checks, security: state.preferences, errors };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, output }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2) + '\n');
  throw error;
} finally {
  if (electron) await quit().catch(async () => { await electron?.close().catch(() => {}); });
  // Only delete this test's disposable profile, and never while its manager lives.
  if (managerPids.every(pid => !alive(pid))) await fs.rm(profile, { recursive: true, force: true });
}
