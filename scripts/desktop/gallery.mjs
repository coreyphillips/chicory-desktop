// Desktop gallery runner: draws the mobile gallery's states in the desktop
// renderer, captures each one and audits the DOM. See docs/gallery.md.
//
//   node scripts/desktop/gallery.mjs           deterministic CI subset
//   node scripts/desktop/gallery.mjs --full    every state, every configuration
//   node scripts/desktop/gallery.mjs --only "send review"   states matching a name
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect } from '@playwright/test';
import electronPath from 'electron';

const root = fileURLToPath(new URL('../..', import.meta.url));
const full = process.argv.includes('--full') || process.env.CHICORY_GALLERY_FULL === '1';
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] : '';
const output = path.resolve(process.env.CHICORY_GALLERY_OUTPUT || path.join(root, 'artifacts/gallery'));
const REACH_MS = 20_000;

const FULL_SIZE = { name: 'full', width: 1320, height: 860 };
const COMPACT_SIZE = { name: 'compact', width: 960, height: 720 };
// Text scale is the window's zoom factor on desktop; Chromium has no separate
// font scale for a renderer.
const CONFIGS = full
  ? [FULL_SIZE, COMPACT_SIZE].flatMap(size => ['no-preference', 'reduce'].flatMap(motion =>
    [1, 1.3].map(zoom => ({ size, motion, zoom }))))
  : [
    { size: FULL_SIZE, motion: 'no-preference', zoom: 1 },
    { size: COMPACT_SIZE, motion: 'reduce', zoom: 1.3 },
  ];

// The CI subset: one or more states from each area of the mobile inventory,
// chosen for stable steps. --full runs everything.
const SUBSET = [
  /^(bloom, still in live|bloom, burst|odometer, hero|odometer, hero in ₿, hidden|vessel, money arriving|pulse dot, failed)$/,
  /^(ring, sent (completed|failed)|hold|hold, held|hold, let go early|copy chip|expiry ring, run out|code, revealed|code, paid)$/,
  /^home/, /^activity/, /^detail, (sent|received) (completed|failed|uncertain)$/, /^detail, hidden$/,
  /^send, (empty|an amount keyed in|more than the wallet holds|review|review, over Bitcoin|review, with warnings|review, held down)$/,
  /^send, (sending|sent|sent, with amounts hidden|failed|unknown|no route|the quote ran out as it was sent)$/,
  /^receive, (any amount|the quote|the quote, run out|the request|the request, running out|the request, expiring|received|received, hidden|part of it here)$/,
  /^settings(, (on mainnet|a backup to save|showing the phrase|with the network editor open|reviewing a wallet drain|confirming an erase|auto-pay switched on))?$/,
  /^(lock, (waiting|refused)|offline|offline, setup failed|welcome, first run|saved|picker|picker, restoring a wallet|loading)$/,
];

// Findings this gallery made that are tracked as product bugs rather than
// fixed here. They are still audited and reported on every run, and a run
// fails if one stops reproducing, so the list cannot go stale.
const KNOWN = [{
  name: 'settings, reviewing a wallet drain',
  config: /^compact-.*-x1\.3$/,
  problem: /^offscreen confirmation button\[Send everything\]/,
  reason: 'Below 900 CSS px the Settings layer is wider than the window, so the drain hold is cut off to the right.',
}];
const known = [];

const configName = config => `${config.size.name}-${config.motion === 'reduce' ? 'reduced' : 'motion'}-x${config.zoom}`;
const slug = name => name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 80);

let electron;
let page;
const failures = [];
const pageErrors = [];
const consoleErrors = [];
const checks = [];
const breachLog = [];

async function resize({ width, height }) {
  await electron.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
  }, { width, height });
}

async function configure(config) {
  await resize(config.size);
  await page.emulateMedia({ reducedMotion: config.motion });
  // Reanimated reads Reduce Motion once, as it loads, so each configuration
  // starts from a fresh load. The breach log does not survive one.
  breachLog.push(...await page.evaluate(() => window.chicoryGallery.breaches()));
  await page.reload();
  await page.waitForFunction(() => !!window.chicoryGallery, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), config.motion === 'reduce');
  await electron.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), config.zoom);
  await page.waitForTimeout(150);
}

/** Exit clones seen while the last state was drawn. */
let exitClones = 0;

/** Draws state `index` from nothing and waits until its steps are done. */
async function reach(index) {
  // Exit clones are gone once a state settles, so focusable controls in
  // hidden panes are looked for on every frame while it is drawn.
  await page.evaluate(at => {
    const watch = { clones: 0, problems: new Set() };
    window.chicoryExits = watch;
    const frame = () => {
      if (window.chicoryExits !== watch) return;
      watch.clones += document.querySelectorAll('[data-chicory-motion-exit]').length;
      for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [tabindex]')) {
        if (el.disabled || el.tabIndex < 0 || !el.closest('[aria-hidden="true"]') || el.closest('[inert]')) continue;
        if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
        watch.problems.add(`focusable control in a hidden pane ${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') || ''}]`);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.chicoryGallery.go(at);
  }, index);
  await page.waitForFunction(at => window.chicoryGallery.index === at && window.chicoryGallery.status === 'reached', index, { timeout: REACH_MS });
  // Let the last step's motion land; reduced motion lands at once.
  await page.waitForTimeout(700);
  const { lines, clones } = await page.evaluate(() => {
    const watch = window.chicoryExits;
    window.chicoryExits = null;
    return {
      lines: [...window.chicoryGallery.reports.filter(line => /^GALLERY (MISS|ERROR)/.test(line)), ...watch.problems],
      clones: watch.clones,
    };
  });
  exitClones = clones;
  return lines;
}

/**
 * The renderer audit. Everything is read from the live DOM after a state has
 * settled, so it covers the browser motion, layout, focus and SVG adapters
 * rather than the mobile renderer.
 */
function audit() {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const describe = el => `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} "${(el.textContent || '').trim().slice(0, 40)}"`;
  const hiddenTree = el => !!el.closest('[inert], [aria-hidden="true"]');
  const opacityOf = el => {
    let value = 1;
    for (let at = el; at && at.nodeType === 1; at = at.parentElement) value *= Number(getComputedStyle(at).opacity);
    return value;
  };
  const shown = el => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && opacityOf(el) > 0.05;
  };
  const live = el => shown(el) && !hiddenTree(el);

  // Payment figures: a figure that runs past the window or is cut off
  // horizontally by a clipping ancestor. Rolling digits stack vertically
  // inside their clip by design, so only the horizontal edge is checked.
  const figure = /(₿|\bsats?\b|\bBTC\b)/;
  const ownDigits = el => [...el.childNodes].some(node => node.nodeType === 3 && /\d/.test(node.textContent));
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') || !live(el)) continue;
    const own = ownDigits(el);
    const text = el.textContent || '';
    // An odometer names its amount on a wrapper, and a keyed amount marks its
    // entry. Both draw each digit in its own cell, so they are measured by the
    // span of those cells.
    const label = el.getAttribute('aria-label') || '';
    const digits = el.matches('[data-amount-entry]') || (!own && /\d/.test(label) && figure.test(label))
      ? [...el.querySelectorAll('*')].filter(d => shown(d) && ownDigits(d)).map(d => d.getBoundingClientRect())
      : [];
    if (!digits.length && (!own || !figure.test(text) || text.length > 80)) continue;
    const rect = digits.length
      ? { left: Math.min(...digits.map(r => r.left)), right: Math.max(...digits.map(r => r.right)) }
      : el.getBoundingClientRect();
    if (rect.left < -1 || rect.right > vw + 1) problems.push(`clipped figure (window) ${describe(el)}`);
    for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.overflowX === 'visible') continue;
      const clip = at.getBoundingClientRect();
      if (rect.left < clip.left - 1 || rect.right > clip.right + 1) {
        problems.push(`clipped figure ${describe(el)}`);
        break;
      }
    }
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') problems.push(`truncated figure ${describe(el)}`);
  }

  // The desktop heading shares the status row with the tile of a phrase still
  // to save, so it has to start where the tile ends.
  const heading = document.querySelector('[data-desktop-heading]');
  const tile = document.querySelector('[data-backup-tile]');
  if (heading && tile && live(heading) && live(tile) &&
      heading.getBoundingClientRect().left < tile.getBoundingClientRect().right) {
    problems.push(`overlapping heading ${describe(heading)}`);
  }

  // Confirmation controls the user has to reach: on screen, or brought fully
  // on screen by scrolling, as focusing the control does.
  const outside = rect => rect.left < 0 || rect.top < 0 || rect.right > vw || rect.bottom > vh;
  for (const el of document.querySelectorAll('[data-hold-confirmation]')) {
    if (!live(el) || !outside(el.getBoundingClientRect())) continue;
    const scrolled = [];
    for (let at = el.parentElement; at; at = at.parentElement) scrolled.push([at, at.scrollTop, at.scrollLeft]);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (outside(el.getBoundingClientRect())) problems.push(`offscreen confirmation ${describe(el)}`);
    for (const [at, top, left] of scrolled) { at.scrollTop = top; at.scrollLeft = left; }
  }

  // An icon-only control must paint its glyph. Glyphs waiting to draw, such
  // as a copy chip's check, are transparent by design and are not controls.
  const painted = shape => {
    const style = getComputedStyle(shape);
    if (style.display === 'none' || style.visibility === 'hidden' || opacityOf(shape) <= 0.01) return false;
    const fill = style.fill !== 'none' && Number(style.fillOpacity) > 0.01 && !/rgba\(.*, 0\)$/.test(style.fill);
    let stroke = style.stroke !== 'none' && Number(style.strokeOpacity) > 0.01 && parseFloat(style.strokeWidth) > 0;
    if (stroke && style.strokeDasharray !== 'none' && typeof shape.getTotalLength === 'function') {
      const dash = parseFloat(style.strokeDasharray);
      const offset = Math.abs(parseFloat(style.strokeDashoffset) || 0);
      if (dash <= 0 || (dash >= shape.getTotalLength() - 0.5 && offset >= dash - 0.5)) stroke = false;
    }
    return fill || stroke;
  };
  // Painted is not seen. A later sibling on top of a glyph is deliberate, as it
  // is on the phone, but one drawn before it should be beneath it, so a disc
  // that covers its own glyph is a bug. Hit testing skips layers that ignore
  // pointers, so for this they all answer.
  const solid = el => opacityOf(el) > 0.05 && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)';
  const hits = document.createElement('style');
  hits.textContent = '* { pointer-events: auto !important; }';
  document.head.append(hits);
  for (const svg of document.querySelectorAll('svg')) {
    // A glyph is hidden from screen readers, not from sight, so its parent says
    // whether it is in use.
    if (svg.ownerSVGElement || !shown(svg) || hiddenTree(svg.parentElement)) continue;
    // The middle of a line glyph is empty, so test a point on its stroke.
    const shape = [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')].find(painted);
    if (!shape) continue;
    const { x, y } = shape.getPointAtLength(0).matrixTransform(shape.getScreenCTM());
    const stack = document.elementsFromPoint(x, y);
    const at = stack.findIndex(el => svg.contains(el));
    const before = el => el.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING;
    const cover = stack.slice(0, Math.max(at, 0)).find(el => !el.contains(svg) && before(el) && solid(el));
    if (cover) problems.push(`covered glyph in ${describe(svg.closest('[aria-label]') ?? svg)} under ${describe(cover)}`);
  }
  hits.remove();
  if (document.querySelector('[accessibilitystate]')) problems.push('accessibilityState left on the page as an attribute');
  for (const control of document.querySelectorAll('button, [role="button"], a[href]')) {
    if (!live(control) || control.disabled || control.getAttribute('aria-disabled') === 'true') continue;
    // Laid out, whatever its opacity: a control whose only glyph is
    // transparent still has to fail below.
    const svgs = [...control.querySelectorAll('svg')].filter(svg => svg.getClientRects().length > 0);
    if (!svgs.length || (control.innerText || '').trim()) continue;
    const shapes = svgs.flatMap(svg => [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse, text')]);
    if (!shapes.some(painted)) problems.push(`invisible glyph in ${describe(control)}`);
  }

  // Panes out of use, and the clones motion leaves behind, keep focus out.
  const focusable = 'a[href], button, input, textarea, select, [tabindex]';
  for (const el of document.querySelectorAll(focusable)) {
    if (el.disabled || el.tabIndex < 0 || !shown(el)) continue;
    const hidden = el.closest('[aria-hidden="true"]');
    if (hidden && !el.closest('[inert]')) problems.push(`focusable hidden control ${describe(el)}`);
  }
  const active = document.activeElement;
  if (active && active !== document.body && hiddenTree(active)) problems.push(`focus inside a hidden pane ${describe(active)}`);
  return problems;
}

async function capture(config, index, name) {
  const directory = path.join(output, configName(config));
  await fs.mkdir(directory, { recursive: true });
  // page.screenshot crops a zoomed window to its CSS viewport, so the whole
  // window is captured from the main process.
  const png = await electron.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  assert.ok(png, 'Window capture is empty');
  await fs.writeFile(path.join(directory, `${String(index).padStart(3, '0')}-${slug(name)}.png`), Buffer.from(png, 'base64'));
}

async function sweep(config, indices, names) {
  await configure(config);
  for (const index of indices) {
    const name = names[index];
    let problems;
    try {
      problems = await reach(index);
      if (REAL_HOLD.has(name)) {
        problems = problems.filter(line => !/: hold (down|complete|up) "/.test(line));
        // Past the 700 ms hold, so the committing state seals.
        await holdDown(name === 'hold, let go early', name === 'hold, committing' ? 900 : 250);
      }
      problems.push(...await page.evaluate(audit));
    } catch (error) {
      problems = [`not reached: ${String(error.message || error).split('\n')[0]}`];
    }
    await capture(config, index, name).catch(error => problems.push(`not captured: ${String(error.message || error).split('\n')[0]}`));
    if (REAL_HOLD.has(name)) await page.mouse.up().catch(() => {});
    const where = configName(config);
    for (const entry of KNOWN.filter(item => item.name === name && item.config.test(where))) {
      const before = problems.length;
      problems = problems.filter(line => !entry.problem.test(line));
      if (before === problems.length) failures.push({ config: where, index, name, problems: [`known finding no longer reproduces: ${entry.reason}`] });
      else known.push({ config: where, name, reason: entry.reason });
    }
    if (problems.length) failures.push({ config: where, index, name, problems });
    process.stdout.write(problems.length ? 'x' : '.');
  }
  process.stdout.write('\n');
  checks.push(`${indices.length} states at ${configName(config)}`);
}

// The browser hold reads real pointer and key events, not the gesture
// handler the mobile gallery's hold steps call, so these states are pressed
// with the pointer here.
const REAL_HOLD = new Set(['send, review, held down', 'hold, held', 'hold, let go early', 'hold, committing']);

async function holdDown(release = false, ms = 250) {
  const hold = page.locator('[data-hold-confirmation]').first();
  const box = await hold.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  if (release) {
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
}

const indexOf = (names, name) => {
  const at = names.indexOf(name);
  assert.ok(at >= 0, `Gallery state missing: ${name}`);
  return at;
};

async function interactions(names) {
  await configure(CONFIGS[0]);
  const review = indexOf(names, 'send, review');
  const hold = page.locator('[data-hold-confirmation]');

  // Screen-reader name and keyboard hint of the hold, and a short key hold cancels.
  assert.deepEqual(await reach(review), []);
  await expect(hold).toBeVisible();
  const label = await hold.getAttribute('aria-label');
  assert.ok(label, 'Hold confirmation has an accessible name');
  await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  await hold.focus();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(150);
  await page.keyboard.up('Enter');
  await page.waitForTimeout(900);
  await expect(hold).toBeVisible();
  assert.ok(await hold.evaluate(el => el === document.activeElement || el.contains(document.activeElement)), 'Focus stays on the hold after a cancelled key hold');
  checks.push('Short keyboard hold cancels and keeps focus on the confirmation');

  // A pointer that leaves before the hold completes cancels it.
  const box = await hold.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + box.width / 2, box.y - 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  await expect(hold).toBeVisible();
  // A short press and release cancels too.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(900);
  await expect(hold).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.chicoryGallery.reports.filter(line => /ERROR/.test(line))), []);
  checks.push('Pointer hold cancels on early release and on leaving the control');

  // Focus moves into the newly opened scene and never stays on an exiting pane.
  const focusTarget = names.indexOf('send, sent');
  if (focusTarget >= 0) {
    assert.deepEqual(await reach(focusTarget), []);
    assert.ok(exitClones > 0, 'Send\'s exiting panes were checked for focusable controls while they left');
    const where = await page.evaluate(() => {
      const el = document.activeElement;
      return { body: !el || el === document.body, hidden: !!el?.closest('[inert], [aria-hidden="true"]') };
    });
    assert.equal(where.body, false, 'Focus moves into the payment outcome');
    assert.equal(where.hidden, false, 'Focus is not left inside an exiting pane');
    checks.push('Focus transfer after the payment outcome stays out of exiting panes');
  }

  // Hidden balance: no figure is exposed, visibly or to a screen reader.
  const hidden = names.findIndex(name => /^home.*hidden/.test(name));
  assert.ok(hidden >= 0, 'A hidden-balance state is in the inventory');
  assert.deepEqual(await reach(hidden), []);
  const exposed = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      const name = el.getAttribute('aria-label') || '';
      if (/\d[\d,.\s]*\s*(sats?|BTC)\b|₿\s*\d/.test(name)) out.push(name);
    }
    return out;
  });
  assert.deepEqual(exposed, [], 'Hidden balance exposes no amount through accessible names');
  const balanceText = await page.locator('body').innerText();
  assert.doesNotMatch(balanceText, /₿\s?\d[\d,]*\b(?!.*(fee|sent|received))/i, 'Hidden balance draws no amount');
  checks.push('Hidden balance exposes no amount visibly or by accessible name');

  // The disc shows which filter is on, so a screen reader has to hear it too.
  assert.deepEqual(await reach(indexOf(names, 'activity, filtered to requests')), []);
  await expect(page.getByRole('button', { name: 'Requests', exact: true, pressed: true })).toBeAttached();
  await expect(page.getByRole('button', { name: 'Sent', exact: true, pressed: false })).toBeAttached();
  checks.push('A screen reader hears which Activity filter is on');

  // The same goes for a row that is open, a choice that is made and a control
  // waiting for something. One announced as disabled stays a real button: going
  // native would take it out of the tab order and end a hold under way.
  assert.deepEqual(await reach(indexOf(names, 'settings, showing the phrase')), []);
  await expect(page.getByRole('button', { name: 'Recovery phrase', exact: true, expanded: true })).toBeAttached();
  assert.deepEqual(await reach(indexOf(names, 'settings, proposing another network')), []);
  await expect(page.getByRole('radio', { name: 'mainnet', exact: true, checked: true })).toBeAttached();
  await reach(indexOf(names, 'hold, disabled'));
  const unready = page.getByRole('button', { name: 'Send 4,200 sats', exact: true, disabled: true });
  await expect(unready).toBeAttached();
  await expect(unready).toHaveJSProperty('disabled', false);
  await reach(indexOf(names, 'hold, sending'));
  await expect(page.locator('button[aria-busy="true"]').first()).toBeAttached();
  checks.push('A screen reader hears what is open, chosen, busy or unavailable');

  // Leaving raises the privacy cover. Coming back, nothing of it may stay over
  // the wallet: exits skipped on the phone still run in a browser. Playwright
  // keeps a hidden window awake, so the page is told it is hidden instead.
  assert.deepEqual(await reach(indexOf(names, 'home')), []);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('[data-testid="privacy-cover"]', { state: 'attached' });
  const left = await page.evaluate(async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    delete document.visibilityState;
    return {
      cover: document.querySelectorAll('[data-testid="privacy-cover"]').length,
      fading: document.getAnimations().filter(motion => motion.animationName === 'FadeOut').length,
    };
  });
  assert.deepEqual(left, { cover: 0, fading: 0 }, 'Coming back leaves nothing of the privacy cover over the wallet');
  checks.push('The privacy cover leaves nothing over the wallet on the way back');

  // Resize in the middle of a transition: the review lands in the new window
  // with its confirmation reachable.
  await page.evaluate(at => window.chicoryGallery.go(at), review);
  await page.waitForTimeout(400);
  await resize(COMPACT_SIZE);
  await page.waitForTimeout(120);
  await resize(FULL_SIZE);
  await page.waitForTimeout(120);
  await resize(COMPACT_SIZE);
  await page.waitForFunction(at => window.chicoryGallery.index === at && window.chicoryGallery.status === 'reached', review, { timeout: REACH_MS });
  await page.waitForTimeout(800);
  const afterResize = await page.evaluate(audit);
  assert.deepEqual(afterResize, [], 'Review audits clean after resizing during its transition');
  await capture({ size: COMPACT_SIZE, motion: 'no-preference', zoom: 1 }, review, 'resized during transition');
  checks.push('Resize during a transition lands with the confirmation on screen');
}

try {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.access(path.join(root, 'dist-gallery/gallery.html')).catch(() => {
    throw new Error('Build the gallery first: npm run gallery:build');
  });
  // Keep gallery modules out of the production bundle when one has been built.
  const assets = await fs.readdir(path.join(root, 'dist/assets')).catch(() => []);
  for (const file of assets) {
    const text = await fs.readFile(path.join(root, 'dist/assets', file), 'utf8');
    assert.ok(!text.includes('chicoryGallery'), `Gallery code found in the production bundle: ${file}`);
  }
  if (assets.length) checks.push('Production bundle contains no gallery modules');
  electron = await _electron.launch({
    executablePath: process.env.CHICORY_ELECTRON_EXECUTABLE || electronPath,
    args: [path.join(root, 'scripts/desktop/gallery-window.cjs'), '--driven'],
    cwd: root,
    timeout: 30000,
  });
  page = await electron.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(`${error.message}`));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.waitForFunction(() => !!window.chicoryGallery, null, { timeout: 20000 });

  const isolation = await page.evaluate(() => ({
    origin: location.origin, bridge: typeof window.chicoryDesktop, require: typeof window.require,
    process: typeof window.process, gallery: document.documentElement.dataset.gallery,
  }));
  assert.deepEqual(isolation, { origin: 'chicory-gallery://gallery', bridge: 'undefined', require: 'undefined', process: 'undefined', gallery: 'true' });
  const sealed = await page.evaluate(async () => {
    const tries = [];
    for (const attempt of [
      () => fetch('chicory-app://wallet/api/config'),
      () => navigator.clipboard.readText(),
      () => navigator.mediaDevices.getUserMedia({ video: true }),
      () => new WebSocket('ws://127.0.0.1:1'),
    ]) {
      try { await attempt(); tries.push('allowed'); } catch { tries.push('refused'); }
    }
    return tries;
  });
  assert.deepEqual(sealed, ['refused', 'refused', 'refused', 'refused']);
  checks.push('Gallery window has no desktop bridge, Node globals, network, clipboard or camera');

  const names = await page.evaluate(() => window.chicoryGallery.names);
  const all = names.map((_, index) => index);
  const picked = all.filter(index => only ? new RegExp(only).test(names[index]) : full || SUBSET.some(pattern => pattern.test(names[index])));
  assert.ok(picked.length > 0, 'At least one state selected');
  console.log(`${names.length} states in the inventory, ${picked.length} selected`);

  for (const config of CONFIGS) await sweep(config, picked, names);
  if (!only) await interactions(names);

  // The breaches the seal check above provoked on purpose are the only ones.
  const breaches = [...breachLog, ...await page.evaluate(() => window.chicoryGallery.breaches())].slice(4);
  const refused = await electron.evaluate(() => global.galleryRefused);
  assert.deepEqual(breaches, [], 'No state reached the network, clipboard or camera');
  assert.deepEqual(refused.filter(url => !url.startsWith('chicory-app://wallet/api/config')), [], 'No request left the gallery');
  checks.push('No state reached the network, clipboard, camera or a permission');
  assert.deepEqual(pageErrors, [], 'No renderer exceptions');
  const unexpected = consoleErrors.filter(line => !/GALLERY BREACH|Failed to load resource/.test(line));
  assert.deepEqual(unexpected, [], 'No unexpected renderer console errors');
  assert.deepEqual(failures, [], 'Every state reached and audited clean');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, full, states: picked.length, inventory: names.length, checks, known }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks, known, output }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({
    passed: false, error: String(error), failures, pageErrors, consoleErrors, checks,
  }, null, 2) + '\n').catch(() => {});
  console.error(JSON.stringify({ failures, pageErrors, consoleErrors: consoleErrors.slice(0, 20) }, null, 2));
  throw error;
} finally {
  if (electron) await electron.close().catch(() => {});
}
