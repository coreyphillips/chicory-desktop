import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';
import QRCode from 'qrcode';
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

/** Drags across the open form and triple-clicks inside it; nothing outside a field may end up selected. */
async function assertNothingSelects() {
  const form = await page.getByTestId('slot-top').boundingBox();
  assert.ok(form, 'The open form has a box');
  // Down the middle, across the figures and keys, which is where a stray
  // drag used to paint the selection.
  await page.mouse.move(form.x + form.width / 2, form.y + form.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(form.x + form.width / 2, form.y + form.height * 0.95, { steps: 20 });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'A drag selects nothing');
  await page.mouse.click(form.x + 12, form.y + 12, { clickCount: 3 });
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'A triple click selects nothing');
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'allow' });
}

/** Opens the demo on the smoke profile, so a second launch finds what the first one saved. */
async function launchDemo() {
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
}

/** Quits the app the way the menu does, and waits for it to be gone. */
async function quitDemo() {
  await electron.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
  await electron.close().catch(() => {});
  electron = undefined;
}

try {
  await launchDemo();
  await expect(page.locator('.browser-sidebar button[data-scene="send"]')).toBeEnabled({ timeout: 20000 });
  await page.waitForTimeout(1600);
  const security = await page.evaluate(() => ({
    origin: location.origin, require: typeof window.require, process: typeof window.process,
    bridge: Object.keys(window.chicoryDesktop || {}).sort(),
  }));
  assert.equal(security.origin, 'chicory-app://wallet');
  assert.equal(security.require, 'undefined');
  assert.equal(security.process, 'undefined');
  assert.deepEqual(security.bridge, ['close', 'diagnostics', 'erase', 'fullBackup', 'lock', 'minimize', 'onCommand', 'platform', 'toggleMaximize']);
  const preferences = await electron.evaluate(({ BrowserWindow }) => {
    const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
  });
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  checks.push('Stable custom origin, sandbox, context isolation, no Node globals, narrow preload bridge');

  // As the app opens it lands focus on the balance for a screen reader. With
  // nothing pressed yet it must not wear a focus ring until the next click.
  const focusNow = () => page.evaluate(() => ({
    onBalance: !!document.activeElement?.closest('[data-testid="home-hero"]'),
    ring: document.activeElement?.matches(':focus-visible') ?? false,
  }));
  assert.deepEqual(await focusNow(), { onBalance: true, ring: false }, 'The balance takes focus on launch without a ring');
  await screenshot('desktop-launch');
  await page.keyboard.press('Tab');
  assert.equal((await focusNow()).ring, true, 'The keyboard still shows where focus is');
  await page.evaluate(() => document.activeElement?.blur());
  checks.push('The balance takes focus on launch without a focus ring, and the keyboard still shows one');

  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
  await page.waitForTimeout(600);
  await screenshot('desktop-home');
  const sizes = await page.locator('[data-chicory-canvas]').evaluate(element => ({
    width: element.clientWidth, desktop: element.dataset.desktop,
  }));
  assert.equal(sizes.desktop, 'true');
  assert.ok(sizes.width > 1000);
  // The sidebar says which network is open; it offers no wallet drop-down.
  await expect(page.locator('.browser-sidebar select')).toHaveCount(0);
  await expect(page.locator('.browser-wallet-identity')).toHaveAttribute('data-wallet', /.+/);
  await expect(page.locator('.browser-network')).toBeVisible();
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 720));
  await page.waitForTimeout(700);
  await screenshot('desktop-compact');
  await expect(page.locator('[data-chicory-canvas]')).toHaveAttribute('data-desktop', 'true');
  assert.equal(await page.locator('.browser-nav-label').first().isVisible(), false);
  checks.push('Full navigation at 1320px and compact desktop rail at 960px');
  await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860));
  await page.waitForTimeout(700);

  // Overview's own controls answer a pointer, not only the rail and menus.
  const hero = page.getByTestId('home-hero').getByRole('button').first();
  const shownIn = await hero.getAttribute('aria-label');
  await hero.click();
  await expect.poll(() => hero.getAttribute('aria-label')).not.toBe(shownIn);
  const homeAction = name => page.getByTestId('home-slot').getByRole('button', { name, exact: true });
  for (const [name, scene] of [['Send', 'send'], ['Receive', 'receive']]) {
    await homeAction(name).click();
    await expect(page.locator(`.browser-sidebar button[data-scene="${scene}"]`)).toHaveAttribute('aria-current', 'page');
    await page.waitForTimeout(800);
    await nativeMenu('Overview');
  }
  await homeAction('Scan a payment request').click();
  await expect(page.getByTestId('scan-disc')).toBeVisible();
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scan-disc')).toHaveCount(0);
  await page.waitForTimeout(800);
  checks.push('Overview balance, Send, Receive and Scan answer a click');

  await homeAction('Scan a payment request').click();
  const chooseImage = page.getByRole('button', { name: 'Choose QR image', exact: true });
  await expect(chooseImage).toBeVisible();
  await page.waitForTimeout(900);
  await screenshot('desktop-scan-image');
  const photoRequest = bech32Encode('bc', [0, ...convertBits(new Array(20).fill(9), 8, 5, true)]);
  async function chooseScreenshot(buffer) {
    const chooserOpen = page.waitForEvent('filechooser');
    await chooseImage.focus();
    await page.keyboard.press('Enter');
    await (await chooserOpen).setFiles({ name: 'payment.png', mimeType: 'image/png', buffer });
  }
  const otherRequest = bech32Encode('bc', [0, ...convertBits(new Array(20).fill(10), 8, 5, true)]);
  const images = await Promise.all([photoRequest, otherRequest].map(request => QRCode.toDataURL(request)));
  const pair = await page.evaluate(async urls => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    for (const [index, url] of urls.entries()) {
      const image = new Image();
      image.src = url;
      await image.decode();
      context.drawImage(image, index * 256, 0, 256, 256);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, images);
  await chooseScreenshot(Buffer.from(pair, 'base64'));
  await expect(chooseImage).toHaveAccessibleDescription('Choose an image with only one payment code.');
  await expect(chooseImage).toBeFocused();
  await chooseScreenshot(await QRCode.toBuffer(photoRequest));
  await expect(page.getByRole('button', { name: 'Payment request or address', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Payment request or address', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Payment request or address', exact: true })).toHaveValue(photoRequest);
  await nativeMenu('Overview');
  checks.push('Screenshot scan rejects two payment codes, restores keyboard focus, and fills Send from one code');

  // Between Send and Receive there is one control, whole, that stays where it
  // is, however the switch is asked for and at any window size. Every frame is
  // checked, since what went wrong here only ever lasted a frame or two: a
  // circle stood in for the control, swapped for another, dimmed as the two
  // crossed, and after a resize flew hundreds of points to where the control
  // had been.
  await page.evaluate(() => {
    const shown = element => {
      let opacity = 1;
      for (let at = element; at; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.display === 'none' || style.visibility === 'hidden') return 0;
        opacity *= Number(style.opacity);
      }
      return opacity;
    };
    window.chicorySwitch = ms => new Promise(done => {
      const frames = [];
      const began = performance.now();
      const frame = () => {
        const controls = [];
        for (const el of document.querySelectorAll('button, [role="button"]')) {
          const box = el.getBoundingClientRect();
          if (Math.abs(box.width - 88) > 1.5 || Math.abs(box.height - 88) > 1.5) continue;
          const opacity = shown(el);
          if (opacity > 0.02) controls.push({ x: box.left + 44, y: box.top + 44, opacity });
        }
        const [only] = controls;
        const hit = only && document.elementFromPoint(only.x, only.y);
        const nav = document.querySelector('.browser-sidebar nav').getBoundingClientRect();
        frames.push({
          controls,
          reached: !!hit?.closest('[data-big-control]'),
          navigable: !!document.elementFromPoint(nav.left + nav.width / 2, nav.top + 20)?.closest('.browser-sidebar'),
          swapping: !!document.documentElement.dataset.swapping,
          clones: [...document.querySelectorAll('[data-chicory-motion-exit]')].filter(el => shown(el) > 0.02).length,
          scenes: document.querySelectorAll('[data-testid="send-entry"], [data-testid="receive-slot"]').length,
        });
        if (performance.now() - began < ms) requestAnimationFrame(frame); else done(frames);
      };
      requestAnimationFrame(frame);
    });
  });
  assert.equal(await page.evaluate(() => typeof document.startViewTransition), 'function', 'The renderer has view transitions');
  const scene = name => page.locator(`.browser-sidebar button[data-scene="${name}"]`);
  const menuItem = label => electron.evaluate(({ Menu, BrowserWindow }, wanted) => {
    const find = menu => {
      for (const item of menu?.items || []) {
        if (item.label === wanted) return item;
        const nested = find(item.submenu);
        if (nested) return nested;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu());
    item.click(item, BrowserWindow.getAllWindows()[0], {});
  }, label);
  const steady = async (name, ask, ms = 900) => {
    const frames = page.evaluate(wait => window.chicorySwitch(wait), ms);
    await page.waitForTimeout(40);
    await ask();
    const seen = await frames;
    assert.ok(seen.length > 20, `${name}: frames were seen`);
    const [{ controls: [rest] }] = seen;
    // The browser leaves a layer it has captured out of hit testing, so the
    // form takes no press for the moment it dissolves. The page around it
    // never stops, but for the one frame that captures the layers.
    const swapping = seen.filter(frame => frame.swapping).length;
    assert.ok(swapping <= 26 * (name === 'Back and forth' ? 4 : 1), `${name}: the swap ends, after ${swapping} frames`);
    const unnavigable = seen.filter(frame => !frame.navigable).length;
    assert.ok(unnavigable <= 2 * (name === 'Back and forth' ? 4 : 1), `${name}: the sidebar stays in use, but for ${unnavigable} frames`);
    for (const [at, frame] of seen.entries()) {
      const where = `${name}, frame ${at}`;
      assert.equal(frame.controls.length, 1, `${where}: one control is drawn`);
      const [control] = frame.controls;
      assert.ok(control.opacity >= 0.99, `${where}: it is whole, not ${control.opacity}`);
      assert.ok(Math.hypot(control.x - rest.x, control.y - rest.y) <= 0.5, `${where}: it stays put, at ${control.x},${control.y} from ${rest.x},${rest.y}`);
      assert.ok(frame.reached || frame.swapping, `${where}: a press reaches it`);
      assert.equal(frame.clones, 0, `${where}: nothing that left is drawn again`);
      assert.ok(frame.scenes <= 1, `${where}: one scene is drawn`);
    }
  };
  await scene('send').click();
  await page.waitForTimeout(1000);
  await steady('Receive from the sidebar', () => scene('receive').click());
  await steady('Send from the sidebar', () => scene('send').click());
  await steady('Receive from the menu', () => menuItem('Receive'));
  await steady('Send from the menu', () => menuItem('Send'));
  await steady('Back and forth', async () => {
    for (const name of ['receive', 'send', 'receive', 'send']) {
      await scene(name).click();
      await page.waitForTimeout(40);
    }
  }, 1200);
  for (const [width, height] of [[1600, 1000], [900, 640], [1320, 860]]) {
    await electron.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height]);
    await page.waitForTimeout(700);
    await steady(`Receive at ${width}x${height}`, () => scene('receive').click());
    await steady(`Send at ${width}x${height}`, () => scene('send').click());
  }

  // The flight from Home and back, at a size the window was not opened at. The
  // circle never dims against the control, one fading over the other whole,
  // and it sets off from where it is, however the window has changed since.
  const flies = async name => {
    const frames = page.evaluate(wait => window.chicorySwitch(wait), 1200);
    await page.waitForTimeout(40);
    await scene(name).click();
    const seen = await frames;
    const drawn = seen.filter(frame => frame.controls.length);
    assert.ok(drawn.length > 5, `To ${name}: the control was seen`);
    for (const [at, frame] of drawn.entries()) {
      const coverage = 1 - frame.controls.reduce((rest, control) => rest * (1 - control.opacity), 1);
      assert.ok(coverage >= 0.99, `To ${name}, frame ${at}: it never dims, at ${coverage}`);
      // While both are drawn the circle is on the control, not where it was.
      if (frame.controls.length < 2) continue;
      const [one, other] = frame.controls;
      assert.ok(Math.hypot(one.x - other.x, one.y - other.y) <= 3, `To ${name}, frame ${at}: the two are drawn as one, at ${one.x},${one.y} and ${other.x},${other.y}`);
    }
    assert.ok(drawn.some(frame => frame.controls.length === 2), `To ${name}: the two handed over`);
    for (const [at, frame] of seen.entries())
      assert.equal(frame.clones, 0, `To ${name}, frame ${at}: nothing that left is drawn again`);
    await page.waitForTimeout(300);
  };
  const size = (width, height) => electron.evaluate(({ BrowserWindow }, wanted) => BrowserWindow.getAllWindows()[0].setSize(...wanted), [width, height]);
  const balanceTop = async () => (await page.getByTestId('home-hero').boundingBox()).y;
  await scene('home').click();
  await page.waitForTimeout(1000);
  await flies('send');
  await flies('home');
  await size(1600, 1000);
  await page.waitForTimeout(700);
  await flies('send');
  await flies('home');
  // The balance rests above the form however the window changes under it.
  await scene('send').click();
  await page.waitForTimeout(1000);
  const restsAt = await balanceTop();
  await size(1320, 760);
  await page.waitForTimeout(800);
  assert.ok(Math.abs(await balanceTop() - restsAt) <= 1, 'The balance stays in its band as the window changes with a scene open');
  await flies('home');
  await size(1320, 860);
  await page.waitForTimeout(700);
  await scene('send').click();
  await page.waitForTimeout(1000);
  checks.push('The flight from Home and back never dims and starts from the right place after a resize');

  // The Activity column slides open beside Overview in one move, rather than
  // jumping a third of its width in a frame, and leaves the page as it was.
  const column = () => page.locator('[data-pane="activity"]').evaluate(el => Math.round(el.getBoundingClientRect().width));
  await scene('home').click();
  await page.waitForTimeout(1000);
  const narrow = await column();
  for (const [name, wide] of [['activity', true], ['home', false]]) {
    const frames = page.evaluate(wait => window.chicorySwitch(wait), 700);
    await page.waitForTimeout(40);
    await scene(name).click();
    const seen = await frames;
    const moving = seen.filter(frame => frame.swapping).length;
    assert.ok(moving > 3 && moving < 30, `To ${name}: the column moved for a moment, ${moving} frames`);
    assert.equal(seen.at(-1).swapping, false, `To ${name}: nothing is left named`);
    assert.equal(await column() > narrow, wide, `To ${name}: the column ended at its width`);
  }
  await scene('send').click();
  await page.waitForTimeout(1000);
  checks.push('The Activity column slides open and closed beside Overview');

  // The dissolve is drawn over the page, out of a frame callback's sight, so
  // this reads what reached the screen. Beside the arrow the disc only ever
  // goes between its two looks: never darker or brighter than both, as a disc
  // that blinked or was crossed with another would.
  const disc = async name => {
    await page.waitForTimeout(500);
    const box = await page.locator('[data-big-control]').boundingBox();
    return { x: box.x + 16, y: box.y + box.height / 2, shot: (await page.screenshot({ type: 'png' })).toString('base64') };
  };
  const luminance = (images, x, y) => page.evaluate(async ({ images, x, y }) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const { type, data } of images) {
      const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: `image/${type}` }));
      const scale = bitmap.width / innerWidth;
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      context.drawImage(bitmap, 0, 0);
      const [r, g, b] = context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      out.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
    return out;
  }, { images, x, y });
  const atSend = await disc();
  await scene('receive').click();
  const atReceive = await disc();
  const looks = [
    ...await luminance([{ type: 'png', data: atSend.shot }], atSend.x, atSend.y),
    ...await luminance([{ type: 'png', data: atReceive.shot }], atSend.x, atSend.y),
  ];
  const cast = await page.context().newCDPSession(page);
  const painted = [];
  cast.on('Page.screencastFrame', ({ data, sessionId }) => {
    painted.push({ type: 'jpeg', data });
    cast.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cast.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
  await page.waitForTimeout(100);
  await scene('send').click();
  await page.waitForTimeout(450);
  await cast.send('Page.stopScreencast');
  await cast.detach();
  assert.ok(painted.length > 5, `The screen was seen as it changed: ${painted.length} frames`);
  const [low, high] = [Math.min(...looks) - 8, Math.max(...looks) + 8];
  for (const [at, level] of (await luminance(painted, atSend.x, atSend.y)).entries())
    assert.ok(level >= low && level <= high, `Painted frame ${at}: the disc stays between its looks, ${level} in ${low} to ${high}`);
  checks.push('One big control, whole and in place, every frame, by sidebar, menu and back and forth, at any window size');

  await nativeMenu('Send');
  await assertNothingSelects();
  const address = bech32Encode('bc', [0, ...convertBits(new Array(20).fill(7), 8, 5, true)]);
  const request = page.getByRole('textbox', { name: 'Payment request or address', exact: true });
  await request.fill(address);
  await request.click({ clickCount: 3 });
  assert.deepEqual(await request.evaluate(field => [field.selectionStart, field.selectionEnd]), [0, address.length],
    'A field still selects its text');
  checks.push('A drag or triple click selects nothing on Send, and its field still selects');
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
  await assertNothingSelects();
  checks.push('A drag or triple click selects nothing on Receive');
  const receiveAmount = page.locator('[data-amount-entry]').first();
  await receiveAmount.focus();
  await page.keyboard.type('2500');
  await expect.poll(async () => (await receiveAmount.textContent()).replace(/\s/g, '')).toContain('2,500');
  await screenshot('desktop-receive');
  await nativeMenu('Settings');
  await expect(page.getByText('This computer', { exact: true })).toBeVisible();
  // The page is drawn through to Help, below Funds and exits, which no longer offers Stop wallet.
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop wallet', exact: true })).toHaveCount(0);
  await screenshot('desktop-settings');
  // A network that ships without a server opens its servers and says what is missing.
  await page.getByRole('button', { name: 'Change network or Bitcoin server', exact: true }).click();
  await page.getByRole('radio', { name: 'regtest', exact: true }).click();
  await page.getByRole('button', { name: 'Switch to regtest', exact: true }).click();
  await expect(page.getByText('Add an Electrum server for regtest.', { exact: true })).toBeVisible();
  const useRegtest = page.getByRole('button', { name: 'Use regtest', exact: true });
  await expect(useRegtest).toBeDisabled();
  await page.getByRole('textbox', { name: 'Default Electrum server', exact: true }).fill('127.0.0.1');
  await expect(useRegtest).toBeEnabled();
  await expect(page.getByText('Add an Electrum server for regtest.', { exact: true })).toHaveCount(0);
  checks.push('Switching to regtest without a server opens its servers and says what is missing');
  await nativeMenu('Activity');
  checks.push('Native Send, Receive, Settings, Activity and Overview menus');

  // A payment's detail opens over Overview as it stands. The phone's compact
  // stop used to shrink the balance to a strip cut off at the top edge.
  await nativeMenu('Overview');
  const balance = page.getByTestId('home-hero');
  await page.waitForTimeout(700);
  const resting = await balance.boundingBox();
  await page.getByText('Friday funds', { exact: true }).first().click();
  await expect(page.getByText('Payment details', { exact: true })).toBeVisible();
  const placed = async () => {
    const box = await balance.boundingBox();
    return box && Math.abs(box.y - resting.y) < 1 && Math.abs(box.height - resting.height) < 1;
  };
  await page.waitForTimeout(900);
  assert.equal(await placed(), true, 'The balance keeps its Overview place and size under a payment detail');
  await screenshot('desktop-payment-detail');
  checks.push("A payment detail leaves Overview's balance in place");

  const detail = page.getByTestId('slot-detail');
  const addNote = detail.getByRole('button', { name: 'Add a private note' });
  const editNote = detail.getByRole('button', { name: 'Edit private note' });
  const saveNote = detail.getByRole('button', { name: 'Save private note' });
  const noteField = detail.getByRole('textbox', { name: 'Private note' });
  const memo = detail.getByLabel('Note, Friday funds', { exact: true });
  const date = detail.locator('[aria-label^="Date, "]');
  const [target, pencil, clock, memoBox] = await Promise.all([
    addNote.boundingBox(), addNote.locator('svg').boundingBox(),
    date.locator('svg').boundingBox(), memo.boundingBox(),
  ]);
  assert.ok(target.width >= 48 && target.height >= 48, 'The pencil has a full pointer target');
  assert.ok(Math.abs(pencil.x - clock.x) < 1, 'The empty pencil aligns with the date glyph');
  assert.ok(Math.abs(memoBox.x - (clock.x + clock.width + 12)) < 1, 'The original memo starts in the value column');
  await addNote.focus();
  await page.keyboard.press('Enter');
  await expect(noteField).toBeFocused();
  await noteField.fill('Unfinished edit');
  await page.keyboard.press('Escape');
  await expect(addNote).toBeFocused();
  await page.keyboard.press('Space');
  await noteField.fill('  Sample lunch  ');
  await saveNote.click();
  await expect(editNote).toBeFocused();
  await expect(memo).toBeVisible();
  await expect(detail.getByLabel('Private note, Sample lunch', { exact: true })).toBeVisible();
  await expect(page.locator('[data-pane="activity"]').getByText('Sample lunch', { exact: true })).toBeVisible();
  await screenshot('desktop-private-note');

  const history = page.locator('[data-pane="activity"]');
  await history.getByRole('button', { name: 'Search activity' }).click();
  const search = history.getByRole('textbox', { name: 'Search activity' });
  for (const term of ['sample LUNCH', 'Friday funds']) {
    await search.fill(term);
    await expect(history.getByText('Sample lunch', { exact: true })).toBeVisible();
    await expect(history.getByText('Morning coffee', { exact: true })).toHaveCount(0);
  }
  await history.getByRole('button', { name: 'Clear search' }).click();

  await editNote.click();
  await noteField.fill(' ');
  await saveNote.click();
  await expect(addNote).toBeFocused();
  await expect(page.locator('[data-pane="activity"]').getByText('Friday funds', { exact: true })).toBeVisible();
  checks.push('Private notes align with the detail glyphs, support keyboard editing and update Activity');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await size(960, 720);
  const zoom = factor => electron.evaluate(({ BrowserWindow }, scale) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(scale), factor);
  await zoom(1.3);
  await expect(page.locator('[data-chicory-canvas]')).toHaveAttribute('data-desktop', 'false');
  const longNote = 'Sample reservation reference\n' + 'AB0123456789'.repeat(32) + '\nTable for four.';
  await addNote.click();
  await noteField.fill(longNote);
  await saveNote.click();
  const saved = detail.getByLabel('Private note, ' + longNote, { exact: true });
  assert.ok(await saved.evaluate(row => row.scrollWidth <= row.clientWidth + 1),
    'An unbroken reference wraps inside the note column');
  assert.ok(Math.abs((await saved.locator('svg').boundingBox()).width - 20) < 1,
    'A long private note preserves its lock glyph');
  await editNote.click();
  await expect(noteField).toHaveValue(longNote);
  await noteField.fill('');
  await saveNote.click();
  await expect(addNote).toBeFocused();
  checks.push('At 130 percent zoom a long private note wraps and can be reopened in the compact window');
  await zoom(1);
  await size(1320, 860);
  await nativeMenu('Overview');
  await nativeMenu('Receive');
  await screenshot('desktop-reduced-motion');
  checks.push('Reduced-motion navigation remains responsive');

  // No daemon is started for the sample wallet, and its transport refuses APIs.
  const apiStatus = await page.evaluate(async () => (await fetch('/api/config')).status);
  assert.equal(apiStatus, 403);
  await assert.rejects(fs.stat(path.join(profile, 'wallets')), { code: 'ENOENT' });
  checks.push('Demo mode denies wallet APIs and creates no wallet data directory');

  // A hidden balance is still hidden after quitting and opening the app again,
  // from its first frame, and it can be shown again from there.
  await nativeMenu('Overview');
  const heroBalance = () => page.getByTestId('home-hero').getByRole('button').first();
  await page.getByRole('button', { name: 'Hide balances', exact: true }).click();
  await expect(heroBalance()).toHaveAttribute('aria-label', 'Balance hidden');
  await quitDemo();
  await launchDemo();
  await expect(heroBalance()).toHaveAttribute('aria-label', 'Balance hidden', { timeout: 20000 });
  await expect(page.locator('.browser-sidebar button[data-scene="send"]')).toBeEnabled({ timeout: 20000 });
  assert.equal(await heroBalance().getAttribute('aria-label'), 'Balance hidden', 'Hidden once the wallet is up');
  await page.waitForTimeout(1600);
  await screenshot('desktop-relaunched-hidden');
  const showBalances = page.getByRole('button', { name: 'Show balances', exact: true });
  await expect(showBalances).toBeVisible();
  await showBalances.click();
  await expect(heroBalance()).not.toHaveAttribute('aria-label', 'Balance hidden');
  await expect(page.getByRole('button', { name: 'Hide balances', exact: true })).toBeVisible();
  checks.push('A hidden balance stays hidden after quitting and reopening, and can be shown again');
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
  if (electron) await quitDemo();
  await fs.rm(profile, { recursive: true, force: true });
}
