import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';

export function offlineDesktop(profile, digest, port) {
  let app;
  let starts = 0;
  const exits = [];
  return {
    exits,
    async start() {
      const root = fileURLToPath(new URL('../../', import.meta.url));
      app = await _electron.launch({ cwd: root, executablePath: electronPath, args: [
        '--use-mock-keychain', '--disable-background-networking', '--disable-component-update',
        fileURLToPath(new URL('./floresta-offline-desktop.cjs', import.meta.url)),
      ], env: { ...process.env, CHICORY_PROFILE_DIR: profile, CHICORY_MANUAL_SETUP: '1',
        CHICORY_FLORESTA_CANDIDATE_SHA256: digest, CHICORY_QUALIFY_OFFLINE_PORT: String(port) } });
      const page = await app.firstWindow({ timeout: 30000 });
      await page.waitForURL('chicory-app://wallet/?setup', { timeout: 30000 });
      assert.deepEqual(await page.evaluate(async () => (await fetch('/api/wallets')).json()), { ok: true, result: [] });
      const status = () => page.evaluate(() => window.chicoryDesktop.floresta.status('regtest'));
      if (++starts === 1) {
        assert.equal((await status()).requested, false);
        await app.evaluate(({ dialog }) => {
          const show = dialog.showMessageBox.bind(dialog);
          dialog.showMessageBox = (...args) => {
            const options = args.at(-1);
            if (options.title === 'Floresta qualification' && options.message === 'Start a regtest node?' &&
                options.detail.includes('selected Electrum server')) {
              dialog.showMessageBox = show;
              return Promise.resolve({ response: 0 });
            }
            return show(...args);
          };
        });
        await page.evaluate(() => window.chicoryDesktop.floresta.start('regtest'));
      } else {
        assert.equal((await status()).requested, true, 'Restart must preserve the original consent');
      }
      await expect.poll(async () => (await status()).phase, { timeout: 90000 }).toBe('running');
    },
    async stop() {
      if (!app) return;
      const instance = app;
      const closed = instance.waitForEvent('close', { timeout: 75000 });
      const child = instance.process();
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(75000) });
      try {
        await instance.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
        const [, [code, signal]] = await Promise.all([closed, exited]);
        assert.equal(code, 0);
        assert.equal(signal, null);
        assert(!exits.some(entry => entry.pid === child.pid));
        exits.push({ pid: child.pid, code });
      } finally {
        if (child.exitCode === null) child.kill();
        app = null;
      }
    },
    status: () => app ? app.evaluate(() => globalThis.offlineFixtureNode.status()) : { phase: 'stopped' },
    registerWatches: watches => app.evaluate((_, value) => globalThis.offlineFixtureNode.registerWatches(value), watches),
    watchCoverage: owner => app.evaluate((_, value) => globalThis.offlineFixtureNode.watchCoverage(value), owner),
    async openConfirmedWallet(owner) {
      const instance = app;
      await instance.evaluate((_, owner) => {
        globalThis.offlineFixtureSession = globalThis.offlineFixtureNode.openConfirmedWallet(owner, new AbortController().signal);
      }, owner);
      return Object.fromEntries(['history', 'unspent', 'balance', 'transaction', 'close'].map(method => [method,
        value => instance.evaluate((_, { method, value }) => globalThis.offlineFixtureSession[method](value), { method, value })]));
    },
  };
}
