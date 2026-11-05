import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

async function openPanel(subject) {
  await subject.electron.evaluate(({ Menu, BrowserWindow }) => {
    const find = menu => {
      for (const item of menu?.items || []) {
        if (item.label === 'Settings') return item;
        const nested = find(item.submenu);
        if (nested) return nested;
      }
    };
    const item = find(Menu.getApplicationMenu());
    item.click(item, BrowserWindow.getAllWindows()[0], {});
  });
  const button = name => subject.page.getByRole('button', { name, exact: true });
  const node = button('Experimental Floresta node');
  if (!await node.isVisible()) await button('Change network or Bitcoin server').click();
  if (!await subject.page.getByText('Local node', { exact: true }).isVisible()) await node.click();
  await expect(subject.page.getByText('Your regtest wallet and Lightning channels use the selected Electrum server.', { exact: false })).toBeVisible();
  return button;
}

// The native consent prompt is answered only for this disposable regtest.
// The screen, IPC, signed child, storage, and wallet engine are real.
export async function startPreviewMonitor(subject) {
  const build = await subject.electron.evaluate(({ app, dialog }) => {
    if (!app.isPackaged || app.getName() !== 'Chicory Floresta Preview') throw new Error('Select the packaged Floresta preview.');
    const show = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = (...args) => {
      const options = args.at(-1);
      if (options.title === 'Floresta qualification' && options.message === 'Start a regtest node?' &&
          options.detail.includes('selected Electrum server') && options.buttons[0] === 'Start node') {
        dialog.showMessageBox = show;
        return Promise.resolve({ response: 0 });
      }
      return show(...args);
    };
    return app.getVersion();
  });
  const status = () => subject.page.evaluate(() => window.chicoryDesktop.floresta.status('regtest'));
  assert.equal((await status()).requested, false, 'The fresh preview must start with the monitor disabled');
  const button = await openPanel(subject);
  await button('Start local node').click();
  await expect.poll(async () => (await status()).phase, { timeout: 60000 }).toBe('running');
  return async () => {
    const running = await status();
    assert.equal(running.phase, 'running');
    const stopButton = await openPanel(subject);
    await stopButton('Stop and disable local node').click();
    await expect.poll(async () => (await status()).phase, { timeout: 80000 }).toBe('stopped');
    const stopped = await status();
    assert.equal(stopped.requested, false);
    assert.equal(stopped.storageUsed, true);
    return { appVersion: build, monitorHeight: running.height, stopped: stopped.phase, storageRetained: stopped.storageUsed };
  };
}
