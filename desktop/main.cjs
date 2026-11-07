'use strict';

const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, net, powerMonitor, screen, session, shell, protocol, safeStorage, systemPreferences } = require('electron');
const { execFile, fork } = require('node:child_process');
const { AppLock, installLockIpc } = require('./app-lock.cjs');
const { createAuthenticator } = require('./os-auth.cjs');
const { loadStorageKey, ENVELOPE_VERSION } = require('./storage-key.cjs');
const { BundledTor, TOR_VERSION } = require('./tor.cjs');
const { DesktopDiagnostics, INPUT_LIMIT, desktopResources, stopChild } = require('./diagnostics.cjs');
const { UpdateGate, cleanStaging, download, loadPublicKeys, verifyManifest, verifyStaged } = require('./update.cjs');
const { ProfileEraser, hasPendingErase } = require('./erase.cjs');
const { installFullBackupIpc } = require('./full-backup-ipc.cjs');
const { candidateDigest, FlorestaSettings, installFlorestaIpc } = require('./floresta-settings.cjs');
const { previewCandidate } = require('./floresta-preview.cjs');
const { setWatchCollection, reconcileQualificationWatches } = require('./floresta-wallet-sync.cjs');
const { randomBytes, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { APP_URL, CSP, isAppURL, isPaymentLink, linkFromArgv, createLinkGate, isExternalURL, staticPath, managerHeaders, windowBounds } = require('./policy.cjs');
const linkGate = createLinkGate();

protocol.registerSchemesAsPrivileged([{ scheme: 'chicory-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);

const demo = process.argv.includes('--demo');
// A first launch makes its wallet unasked. Erase all wallets, and harnesses
// that need an empty first run (CHICORY_MANUAL_SETUP=1), load the page for
// first-run setup instead, where Restore is offered.
const SETUP_URL = `${APP_URL}?setup`;
const metadata = app.isPackaged ? require('../package.json') : {};
const preview = metadata.chicoryChannel === 'floresta-preview';
const manualSetup = preview || process.env.CHICORY_MANUAL_SETUP === '1';
app.setName(preview ? 'Chicory Floresta Preview' : 'Chicory');
if (preview && process.platform === 'win32') app.setAppUserModelId('com.chicory.desktop.floresta-preview');
const profileName = (preview ? 'Chicory Floresta Preview' : 'Chicory Desktop') + (demo ? ' Demo' : '');
const profile = process.env.CHICORY_PROFILE_DIR || path.join(app.getPath('appData'), profileName);
app.setPath('userData', profile);
const locked = app.requestSingleInstanceLock();
let window;
let manager;
let managerStart;
let appLock;
let loaded = false;
let tor;
let torProxy;
const torRequests = new Set();
let origin;
let stopping = false;
// While set, the wallet service is being stopped and the profile erased, so
// no wallet route, payment link or unlock may start or reach it.
let erasing = false;
let eraser;
let stopped = false;
let quitting;
const token = randomBytes(32).toString('hex');
const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const runtime = path.join(root, app.isPackaged ? 'runtime' : '.runtime');
const bundledCandidate = demo ? null : previewCandidate(metadata, root);
const candidate = bundledCandidate?.sha256 || candidateDigest({ isPackaged: app.isPackaged, demo, digest: process.env.CHICORY_FLORESTA_CANDIDATE_SHA256 });
const floresta = candidate ? new FlorestaSettings({ root, profile, digest: candidate,
  ...(bundledCandidate ? { load: () => bundledCandidate } : {}),
  canCollect: () => !!manager?.connected && !!appLock && !appLock.required() && !stopping && !erasing,
  setCollection: (network, enabled) => setWatchCollection(manager, network, enabled),
  reconcile: (node, network, signal) => reconcileQualificationWatches({ node, network, manager, signal }),
}) : null;
const publicDirectory = path.join(root, 'dist');
const coded = (message, code) => Object.assign(new Error(message), { code });
// Redacted and bounded. Kept beside the profile so a failure before any
// wallet opens can still be read and copied on the next launch.
const diagnostics = new DesktopDiagnostics({
  file: demo ? null : path.join(profile, 'diagnostics.json'),
  versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    node: process.versions.node, tor: TOR_VERSION, storageEnvelope: ENVELOPE_VERSION, platform: `${process.platform}-${process.arch}` },
  paths: [[profile, '<profile>'], [root, '<app>'], [app.getPath('home'), '<home>']],
});
const diagnosticRequests = new Map();
const RELEASES = 'https://github.com/coreyphillips/chicory-desktop/releases';
// electron-builder writes the channel into the packaged package.json. Source
// checkouts and CI test packages are development builds and never update.
const channel = metadata.chicoryChannel === 'stable' ? 'stable' : 'development';
// An unreadable key list turns updates off. It must never stop Chicory opening.
let updateKeys = [];
if (channel === 'stable') {
  try { updateKeys = loadPublicKeys(JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build/update-keys.json'), 'utf8')).keys); }
  catch { diagnostics.record('update', 'Updates are disabled: the pinned update key list could not be read.', 'UPDATE_KEYS_INVALID'); }
}
const updatesEnabled = channel === 'stable' && updateKeys.length > 0 && !demo;
const updateDirectory = path.join(profile, 'updates');
const gate = new UpdateGate();
const holdRequests = new Map();
let updateTask;

function command(name, value) {
  if (!window || window.isDestroyed() || stopping || !isAppURL(window.webContents.getURL())) return;
  window.webContents.send('desktop:command', name, value);
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function paymentLink(url) {
  // Never queue a payment link across startup, wallet selection or the lock.
  if (!linkGate(url, { window: !!window && !window.isDestroyed(), loading: !!window?.webContents.isLoading(),
    locked: !!appLock?.required(), erasing })) return;
  showWindow();
  command('payment-link', url);
}

app.on('second-instance', (_event, argv) => {
  showWindow();
  const link = linkFromArgv(argv);
  if (link) paymentLink(link);
});
app.on('open-url', (event, url) => { event.preventDefault(); paymentLink(url); });

function managerEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NODE_ENV: 'production', DESKTOP_SESSION_TOKEN: token,
    CHICORY_ENCRYPTED_STORAGE: '1', DESKTOP_TOR_MANAGED: '1',
    TOR_PROXY_IP: torProxy.host, TOR_PROXY_PORT: String(torProxy.port),
    DATA_DIR: path.join(profile, 'wallets'), PUBLIC_DIR: publicDirectory,
    APP_VERSION: app.getVersion(), BEIGNET_BIN: path.join(runtime, 'engine/node_modules/beignet/dist/cli/cli.js') };
}

async function startManager() {
  const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const engine = path.join(runtime, 'engine/node_modules/beignet/dist/cli/cli.js');
  if (!fs.existsSync(node) || !fs.existsSync(engine)) {
    throw coded('The local wallet runtime is missing. For a source checkout, run npm run runtime:prepare.', 'RUNTIME_MISSING');
  }
  fs.mkdirSync(path.join(profile, 'wallets'), { recursive: true, mode: 0o700 });
  diagnostics.state('storage', 'opening');
  let key;
  // Opening the key may re-wrap it for the OS. An update must not interrupt that.
  try { key = await gate.run('storage-key', () => loadStorageKey({ profile, safeStorage, platform: process.platform })); }
  catch (error) { diagnostics.state('storage', 'failed', error); throw error; }
  if (stopping) { key.fill(0); return; }
  tor = new BundledTor({ bundleDirectory: path.join(runtime, 'tor'), dataDirectory: path.join(profile, 'tor'),
    onStatus: status => {
      diagnostics.torStatus(status);
      if (manager?.connected && !stopping) manager.send({ type: 'tor:status', status }, () => {});
    } });
  try { torProxy = await tor.startProxy(); } catch (error) { key.fill(0); throw error; }
  if (stopping) { key.fill(0); await tor.stop(); return; }
  try {
    manager = fork(path.join(root, 'server/desktop-bootstrap.js'), [], {
      execPath: node, env: managerEnvironment(), cwd: profile,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
  } catch (error) { key.fill(0); throw error; }
  diagnostics.state('manager', 'starting');
  manager.stderr.setEncoding('utf8');
  manager.stderr.on('data', chunk => diagnostics.managerOutput(chunk));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(coded('The local wallet did not finish starting.', 'STARTUP_TIMEOUT')), 30000);
    manager.once('error', (error) => { clearTimeout(timeout); reject(error); });
    manager.once('exit', (code, signal) => {
      clearTimeout(timeout);
      diagnostics.managerExited({ code, signal, expected: stopping || erasing });
      if (!origin) reject(coded('The local wallet could not start. Check the runtime installation.', 'MANAGER_EXITED'));
      else if (!stopping && !erasing) void failureDialog(window, 'The local wallet stopped.',
        'Quit and reopen Chicory to reconnect. Your wallet files remain on this computer.').then(() => app.quit());
    });
    manager.on('message', (message) => {
      if (message?.type === 'startup-error') {
        clearTimeout(timeout);
        const error = coded(message.code === 'STORAGE_UNAVAILABLE' ? String(message.message).slice(0, 300) : 'The local wallet could not start.',
          message.code === 'STORAGE_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'MANAGER_FAILED');
        if (error.code === 'STORAGE_UNAVAILABLE') diagnostics.state('storage', 'failed', error);
        reject(error);
        return;
      }
      if (message?.type === 'diagnostics:result') {
        diagnosticRequests.get(message.requestId)?.(message.result);
        return;
      }
      if (message?.type === 'update:hold-result' && holdRequests.has(message.requestId)) {
        holdRequests.get(message.requestId)(message.ok === true);
        return;
      }
      if (message?.type === 'tor:ensure' || message?.type === 'tor:bridge') {
        void handleTorRequest(manager, message);
        return;
      }
      if (message?.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
          message.host !== '127.0.0.1' || message.origin !== `http://127.0.0.1:${message.port}`) return;
      clearTimeout(timeout);
      origin = message.origin;
      diagnostics.state('storage', 'open');
      diagnostics.state('manager', 'ready');
      manager.send({ type: 'tor:status', status: tor.status() }, () => {});
      resolve();
    });
    try {
      manager.send({ type: 'initialize-storage', key: key.toString('hex') }, error => {
        if (error) { clearTimeout(timeout); reject(new Error('The protected wallet key could not reach the local wallet.')); }
      });
    } finally { key.fill(0); }
  });
}

async function handleTorRequest(child, message) {
  if (stopping || !child.connected || typeof message.requestId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(message.requestId) || torRequests.has(message.requestId)) return;
  const reply = payload => { if (child.connected && !stopping) child.send({ type: 'tor:result', requestId: message.requestId, ...payload }, () => {}); };
  if (torRequests.size >= 64) { reply({ error: 'The Tor service is busy. Retry shortly.' }); return; }
  torRequests.add(message.requestId);
  try {
    if (message.type === 'tor:bridge' && (!/^[a-z2-7]{56}\.onion$/.test(message.host) ||
        !Number.isInteger(message.port) || message.port < 1 || message.port > 65535)) throw new Error();
    const endpoint = message.type === 'tor:bridge' ? await tor.createBridge(message.host, message.port) : await tor.ensureReady();
    reply({ result: { host: endpoint.host, port: endpoint.port } });
  } catch { reply({ error: 'Tor could not connect. Check the network and retry.' }); }
  finally { torRequests.delete(message.requestId); }
}

// The manager gives each wallet a bounded graceful stop before terminating it.
const stopManager = () => stopChild(manager, { timeoutMs: 45000 });

/** Manager counters for one report. Null when it cannot answer in time. */
function managerDiagnostics() {
  const child = manager;
  if (!child?.connected || stopping || !origin) return Promise.resolve(null);
  const requestId = randomUUID();
  return new Promise(resolve => {
    const finish = value => { clearTimeout(timer); diagnosticRequests.delete(requestId); resolve(value && typeof value === 'object' ? value : null); };
    const timer = setTimeout(() => finish(null), 2000);
    diagnosticRequests.set(requestId, finish);
    try { child.send({ type: 'diagnostics:request', requestId }, error => { if (error) finish(null); }); }
    catch { finish(null); }
  });
}

async function reportText(input = {}) {
  return diagnostics.text({ ...input, manager: await managerDiagnostics(),
    desktop: desktopResources(app.getAppMetrics(), process.memoryUsage()) });
}

/** A failure with its redacted report one click away, before or after a wallet opens. */
async function failureDialog(parent, message, detail) {
  const options = { type: 'error', title: 'Chicory', message, detail,
    buttons: ['Quit', 'Copy Diagnostics', 'Show Diagnostics'], defaultId: 0, cancelId: 0 };
  for (;;) {
    const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response === 0) return;
    const text = await reportText();
    if (response === 1) clipboard.writeText(text);
    else await dialog.showMessageBox({ type: 'info', title: 'Chicory diagnostics', message: 'Diagnostics report',
      detail: text.length > 6000 ? `${text.slice(0, 6000)}\n...\nUse Copy Diagnostics for the full report.` : text, buttons: ['Back'] });
  }
}

async function fetchBounded(url, limit) {
  const reply = await net.fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (!reply.ok || !reply.body) throw Object.assign(new Error('The release server did not answer.'), { code: 'UPDATE_FETCH' });
  const chunks = [];
  let size = 0;
  for await (const chunk of reply.body) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('The release server sent too much data.'), { code: 'UPDATE_INVALID' });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Asks the manager to pause wallet actions. Resolves false if one is still running. */
function holdWalletActions() {
  if (!manager?.connected || !origin || stopping) return Promise.resolve(false);
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(timer); holdRequests.delete(requestId); resolve(ok); };
    const timer = setTimeout(() => done(false), 20000);
    holdRequests.set(requestId, done);
    manager.send({ type: 'update:hold', requestId }, error => { if (error) done(false); });
  });
}

function releaseWalletActions() {
  if (manager?.connected && !stopping) manager.send({ type: 'update:release' }, () => {});
}

async function installUpdate(file, offer, signal) {
  await gate.tryRun('update', async () => {
    // A launch the app lock kept closed has no wallet running, so there is
    // nothing to pause. A wallet still starting cannot be paused yet.
    if (managerStart && !origin)
      throw Object.assign(new Error('Chicory is still starting the wallet. Try the update again shortly.'), { code: 'UPDATE_BUSY' });
    if (origin && !await holdWalletActions()) {
      releaseWalletActions();
      throw Object.assign(new Error('A wallet action is still running. Wait for it to finish, then install the update.'), { code: 'UPDATE_BUSY' });
    }
    try {
      await verifyStaged(file, offer.artifact);
      if (signal.aborted) throw Object.assign(new Error('The update was cancelled.'), { code: 'UPDATE_CANCELLED' });
    } catch (error) { releaseWalletActions(); throw error; }
    // The same graceful stop as quitting: wallets drain, then Tor exits. The
    // encrypted profile and its OS-protected key are left exactly in place.
    stopping = true;
    diagnostics.shutdownBegan();
    await floresta?.stopAll();
    const managerOutcome = await stopManager().catch(() => 'failed');
    const torOutcome = await Promise.resolve(tor?.stop()).then(() => 'stopped', () => 'failed');
    diagnostics.shutdownEnded({ manager: managerOutcome, tor: tor ? torOutcome : 'not-started' });
    stopped = true;
    if (process.platform === 'linux') shell.showItemInFolder(file);
    else {
      const problem = await shell.openPath(file);
      if (problem) shell.showItemInFolder(file);
    }
    app.quit();
  });
}

async function checkForUpdates() {
  if (updateTask) {
    updateTask.abort();
    return;
  }
  const controller = new AbortController();
  updateTask = controller;
  installMenu();
  try {
    const [bytes, signature] = await Promise.all([
      fetchBounded(`${RELEASES}/latest/download/update-manifest.json`, 256 * 1024),
      fetchBounded(`${RELEASES}/latest/download/update-manifest.json.sig`, 4096),
    ]);
    const offer = verifyManifest(bytes, signature, { keys: updateKeys, version: app.getVersion(),
      platform: process.platform, arch: process.arch, channel });
    const { manifest } = offer;
    const detail = [`Version ${manifest.version} from source revision ${manifest.revision.slice(0, 12)}.`,
      `Bundled Tor ${manifest.components?.tor}, wallet engine ${manifest.components?.engine}.`,
      offer.required ? 'This build is no longer supported. Install the update before making payments.' : '',
      'The download is checked against the signed release before anything is installed.'].filter(Boolean).join('\n');
    const answer = await dialog.showMessageBox(window, { type: 'info', title: 'Chicory', message: `Chicory ${manifest.version} is available.`,
      detail, buttons: ['Download', 'Not Now'], defaultId: 0, cancelId: 1 });
    if (answer.response !== 0 || controller.signal.aborted) return;
    const reply = await net.fetch(`${RELEASES}/download/v${manifest.version}/${offer.artifact.file}`, { signal: controller.signal, redirect: 'follow' });
    if (!reply.ok || !reply.body) throw Object.assign(new Error('The release server did not answer.'), { code: 'UPDATE_FETCH' });
    const file = await download({ body: Readable.fromWeb(reply.body), artifact: offer.artifact, directory: updateDirectory,
      signal: controller.signal, onProgress: value => window?.setProgressBar(value) });
    window?.setProgressBar(-1);
    const install = await dialog.showMessageBox(window, { type: 'question', title: 'Chicory', message: `Install Chicory ${manifest.version}?`,
      detail: process.platform === 'linux'
        ? 'Chicory will stop the wallet and Tor, quit, and show the verified AppImage. Replace your current AppImage with it.'
        : 'Chicory will pause wallet actions, stop the wallet and Tor, quit, and open the verified installer. Wallet files and the protected key stay in place.',
      buttons: ['Install and Quit', 'Later'], defaultId: 0, cancelId: 1 });
    if (install.response === 0) await installUpdate(file, offer, controller.signal);
  } catch (error) {
    window?.setProgressBar(-1);
    if (error.code === 'UPDATE_CANCELLED' || controller.signal.aborted) {
      cleanStaging(updateDirectory);
      return;
    }
    const current = error.code === 'UPDATE_DOWNGRADE';
    await dialog.showMessageBox(window, { type: current ? 'info' : 'warning', title: 'Chicory',
      message: current ? 'Chicory is up to date.' : 'The update was not installed.',
      detail: current ? `Version ${app.getVersion()} is the latest release.` :
        `${error.code?.startsWith('UPDATE_') ? error.message : 'The update could not be checked.'} Your wallet was not changed. Verified installers are also listed at ${RELEASES}.` });
  } finally {
    updateTask = undefined;
    if (!stopping) installMenu();
  }
}

function response(body, status = 200, type = 'text/plain') {
  return new Response(body, { status, headers: {
    'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  } });
}

async function handleRequest(request) {
  if (!isAppURL(request.url)) return response('Forbidden', 403);
  const suppliedOrigin = request.headers.get('origin');
  if (suppliedOrigin && !isAppURL(suppliedOrigin)) return response('Forbidden', 403);
  const url = new URL(request.url);
  const walletRoute = /^\/(api|wallets)(\/|$)/.test(url.pathname);
  // The interface is served here so a locked launch can draw without the manager.
  if (demo || !walletRoute) {
    if (!['GET', 'HEAD'].includes(request.method) || walletRoute) return response(demo ? 'Demo mode has no wallet service.' : 'Forbidden', 403);
    const file = staticPath(publicDirectory, url.pathname);
    if (!file) return response('Not found', 404);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try { return response(request.method === 'HEAD' ? null : await fs.promises.readFile(file), 200, types[path.extname(file)] || 'application/octet-stream'); }
    catch { return response('Not found', 404); }
  }
  const admitted = appLock.admit(url.pathname);
  if (!admitted.ok) return admitted.status === 403 ? response('Forbidden', 403) : response('Chicory is locked.', 423);
  if (erasing) return response('Chicory is erasing this profile.', 503);
  if (!origin || stopping) return response('The local wallet is unavailable.', 503);
  try {
    const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method, headers: managerHeaders(request.headers, token, origin),
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
      signal: admitted.ticket ? AbortSignal.any([request.signal, admitted.ticket.signal]) : request.signal, redirect: 'error',
    });
    // A payment or recovery answer that lands after a relock is not delivered.
    if (!appLock.current(admitted.ticket)) {
      void upstream.body?.cancel().catch(() => {});
      return response('Chicory is locked.', 423);
    }
    const headers = new Headers(upstream.headers);
    // fetch has already decoded content. Do not forward stale compression lengths.
    for (const key of ['content-encoding', 'content-length', 'set-cookie', 'x-chicory-session']) headers.delete(key);
    headers.set('Content-Security-Policy', CSP);
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch {
    if (!appLock.current(admitted.ticket)) return response('Chicory is locked.', 423);
    return response('The local wallet is unavailable. Reopen Chicory to reconnect.', 503);
  }
}

function installMenu() {
  const go = (label, accelerator, scene) => ({ label, accelerator, click: () => command(scene) });
  const update = updatesEnabled
    ? { label: updateTask ? 'Cancel Update' : 'Check for Updates…', click: () => void checkForUpdates() }
    : { label: 'Development Build: Updates Disabled', enabled: false };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Chicory', submenu: [
      { role: 'about' }, update, { type: 'separator' }, go('Settings', 'CommandOrControl+,', 'settings'),
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'Wallet', submenu: [go('Overview', 'CommandOrControl+1', 'home'), go('Send', 'CommandOrControl+2', 'send'),
      go('Receive', 'CommandOrControl+3', 'receive'), go('Activity', 'CommandOrControl+4', 'activity'),
      ...(process.platform !== 'darwin' ? [go('Settings', 'CommandOrControl+,', 'settings'), { type: 'separator' }, { role: 'quit' }] : [])] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [...(process.platform !== 'darwin' ? [update, { type: 'separator' }] : []),
      { label: 'Chicory Desktop on GitHub', click: () => shell.openExternal('https://github.com/coreyphillips/chicory-desktop') }] },
  ]));
  app.setAboutPanelOptions({ applicationName: 'Chicory',
    applicationVersion: channel === 'stable' ? app.getVersion() : `${app.getVersion()} (development build)`,
    copyright: 'Copyright © 2026 Corey Phillips', iconPath: path.join(__dirname, '../build/icon.png') });
}

function installPermissions(desktopSession) {
  desktopSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (contents !== window?.webContents || !isAppURL(requestingOrigin) || !window.isFocused()) return false;
    return permission === 'clipboard-sanitized-write';
  });
  desktopSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (contents !== window?.webContents || !isAppURL(details.requestingUrl || contents.getURL()) || !window.isFocused()) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    const camera = permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'video';
    const clipboard = permission === 'clipboard-read';
    if (!camera && !clipboard) return callback(false);
    const answer = await appLock.duringPrompt(() => dialog.showMessageBox(window, { type: 'question', title: 'Chicory',
      message: camera ? 'Allow Chicory to use the camera?' : 'Allow Chicory to read the clipboard?',
      detail: camera ? 'QR codes are decoded on this computer. No video is saved or uploaded.' : 'The copied payment request will fill the Send form for review.',
      buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 }));
    callback(answer.response === 0 && !appLock.required());
  });
  desktopSession.setDevicePermissionHandler(() => false);
  desktopSession.on('will-download', (event) => event.preventDefault());
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAppURL(details.url) && !/^(devtools|data|blob):/.test(details.url) });
  });
}

function createWindow(desktopSession) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(profile, 'window.json'), 'utf8')); } catch {}
  const bounds = windowBounds(saved, screen.getAllDisplays());
  window = new BrowserWindow({
    ...bounds, minWidth: Math.min(900, bounds.width), minHeight: Math.min(640, bounds.height),
    title: 'Chicory', backgroundColor: '#110e0c', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, '../build/icon.png'),
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 12 } } : { frame: false }),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: desktopSession,
      additionalArguments: candidate ? ['--chicory-floresta-qualification'] : [],
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
      webviewTag: false, spellcheck: false, devTools: !app.isPackaged, backgroundThrottling: true },
  });
  window.on('ready-to-show', () => { if (stopping) return; if (saved?.maximized) window.maximize(); window.show(); });
  const saveBounds = () => {
    if (!window || window.isDestroyed() || window.isMinimized()) return;
    try { fs.writeFileSync(path.join(profile, 'window.json'), JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }), { mode: 0o600 }); } catch {}
  };
  window.on('close', (event) => {
    saveBounds();
    if (!stopped) {
      event.preventDefault();
      if (process.platform === 'darwin' && !stopping) window.hide();
      else app.quit();
    }
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppURL(url)) return;
    event.preventDefault();
    if (isPaymentLink(url)) paymentLink(url);
    else if (isExternalURL(url)) void shell.openExternal(url);
  });
  window.webContents.on('will-redirect', (event, url) => { if (!isAppURL(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalURL(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  for (const [channel, action] of [
    ['window:minimize', () => window.minimize()],
    ['window:maximize', () => window.isMaximized() ? window.unmaximize() : window.maximize()],
    ['window:close', () => window.close()],
  ]) ipcMain.on(channel, (event) => { if (trustedSender(event)) action(); });
  // Read-only and redacted here, so the renderer never sees unredacted host state.
  // Erases every wallet in this profile. It takes no arguments: the app lock's
  // one-shot grant, the engines' clean stop and the fixed list of profile
  // entries decide everything.
  ipcMain.handle('desktop:erase', async (event) => {
    if (!trustedSender(event) || demo || !eraser) return { ok: false, code: 'ERASE_REFUSED', error: 'Erase is unavailable.' };
    return eraser.erase();
  });
  ipcMain.handle('desktop:diagnostics', async (event, input) => {
    if (!trustedSender(event)) throw new Error('Diagnostics are unavailable.');
    let size = Infinity;
    try { size = JSON.stringify(input ?? null).length; } catch {}
    const { wallet, walletError, events } = size <= INPUT_LIMIT && input && typeof input === 'object' ? input : {};
    return reportText({ wallet, walletError: typeof walletError === 'string' ? walletError : undefined, events });
  });
  for (const name of ['blur', 'hide', 'minimize']) window.on(name, () => appLock.background(name === 'blur' ? 'blur' : 'hidden'));
  for (const name of ['focus', 'show', 'restore']) window.on(name, () => appLock.foreground());
}

function trustedSender(event) {
  return !!window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && isAppURL(event.senderFrame.url);
}

function lockEvent(name, value) {
  if (name === 'locked' || name === 'unlocked') floresta?.refreshCollection();
  if (!window || window.isDestroyed() || !isAppURL(window.webContents.getURL())) return;
  if (['locked', 'conceal', 'changed', 'unlocked'].includes(name))
    window.webContents.send('desktop:lock', name, typeof value === 'string' || typeof value === 'boolean' ? value : undefined);
}

/** The storage key and wallet engines are released only after the gate opens. */
function ensureManager() {
  if (demo) return Promise.resolve();
  if (erasing) return Promise.reject(coded('Chicory is erasing this profile.', 'ERASING'));
  // A start the lock deferred is timed from the unlock, not from launch.
  if (!managerStart && loaded) diagnostics.startupBegan();
  managerStart ??= startManager().then(() => {
    if (loaded && !stopping) diagnostics.startupEnded('ready');
    if (!stopping && !erasing && !appLock.required()) floresta?.resume();
  }, async (error) => {
    // A wallet service stopped by an erase did not fail to open.
    if (!stopping && !erasing) {
      diagnostics.startupEnded('failed', error);
      await failureDialog(null, 'Chicory could not open.', error.message);
      app.quit();
    }
    throw Object.assign(error, { reported: true });
  });
  return managerStart;
}

/** A request from this process to the wallet service, authenticated as the window's own requests are. */
async function managerCall(route, body, { raw = false } = {}) {
  if (!origin || stopping || erasing) throw coded('The local wallet is unavailable.', 'UNAVAILABLE');
  const reply = await fetch(`${origin}${route}`, { method: 'POST', redirect: 'error', body: JSON.stringify(body),
    headers: managerHeaders(new Headers({ 'content-type': 'application/json' }), token, origin) });
  if (raw && reply.ok) return Buffer.from(await reply.arrayBuffer());
  const packet = await reply.json().catch(() => null);
  if (!reply.ok || packet?.ok !== true) throw coded(packet?.error?.message || 'The wallet service refused this.', packet?.error?.code || 'FAILED');
  return packet.result;
}

/** The erase of this profile, wired to the wallet service, Tor and this window's stored state. */
function createEraser(desktopSession) {
  return new ProfileEraser({
    profile,
    authorize: () => appLock.takeGrant(),
    busy: () => !!gate.active,
    exclusive: task => gate.run('erase', task),
    prepareNodeErase: () => {
      const generation = appLock.generation;
      const settings = floresta || new FlorestaSettings({ root, profile, digest: null });
      return settings.prepareErase(async paths => {
        const { response } = await appLock.duringPrompt(() => dialog.showMessageBox(window, {
          type: 'warning', title: 'Local node data remains', message: 'Erase wallet keys and accessible data now?',
          detail: 'Some node records could not be removed. Accessible node data was cleared where possible. Public wallet or channel history may remain in these locations:\n\n' +
            paths.join('\n') + '\n\nReconnect the original volume and use Remove local node data in the experimental node Settings on a local macOS APFS volume. Other volumes and platforms require manual cleanup of the listed node store with every node stopped. Chicory remembers only the unresolved storage locations.',
          buttons: ['Erase wallet keys and accessible data', 'Cancel wallet erase'], defaultId: 1, cancelId: 1
        }));
        return response === 0 && !stopping && !appLock.required() && generation === appLock.generation;
      });
    },
    stopService: async () => {
      erasing = true;
      // The manager stops every engine and waits for each to exit before it
      // does. A kill at the deadline is reported, and nothing is deleted.
      const outcome = await stopManager().catch(() => 'failed');
      manager = undefined; origin = undefined; managerStart = undefined;
      return outcome;
    },
    stopTor: async () => {
      await Promise.resolve(tor?.stop()).catch(() => {});
      tor = undefined; torProxy = undefined; torRequests.clear();
    },
    // Saved selections, pending-backup flags, offline drafts, preferences and
    // any cached view live in this partition's storage.
    clearRendererState: () => desktopSession.clearStorageData(),
    startOver: async () => {
      erasing = false;
      floresta?.afterErase();
      // A new storage key and an empty wallet service, then first-run setup,
      // which creates nothing until asked.
      await ensureManager();
      if (window && !window.isDestroyed()) await window.loadURL(SETUP_URL);
    },
    record: message => diagnostics.record('erase', message),
  });
}

/** Finishes an erase that was interrupted, before any key is opened. False when the owner quits instead. */
async function finishPendingErase() {
  diagnostics.record('erase', 'resuming an interrupted erase');
  for (;;) {
    const result = await eraser.resume();
    if (result.ok) return true;
    const { response } = await dialog.showMessageBox({ type: 'error', title: 'Chicory', message: 'Chicory could not finish erasing this profile.',
      detail: `${result.error} Chicory will not open a wallet until the erase is complete.`, buttons: ['Retry', 'Quit'], defaultId: 0, cancelId: 1 });
    if (response !== 0) { app.quit(); return false; }
  }
}

function installLock() {
  installLockIpc({ ipcMain, appLock, trusted: trustedSender, ensureManager });
  const relock = (reason) => () => { appLock.conceal(reason); appLock.relock(reason); };
  powerMonitor.on('lock-screen', relock('lock-screen'));
  powerMonitor.on('suspend', relock('suspend'));
  if (process.platform === 'darwin') powerMonitor.on('user-did-resign-active', relock('switch-user'));
}

app.on('before-quit', (event) => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  stopping = true;
  diagnostics.shutdownBegan();
  const stopNode = Promise.resolve(floresta?.stopAll()).catch(() => {});
  quitting = stopManager().catch(() => 'failed')
    .then(managerOutcome => Promise.resolve(tor?.stop()).then(() => 'stopped', () => 'failed')
      .then(torOutcome => diagnostics.shutdownEnded({ manager: managerOutcome, tor: tor ? torOutcome : 'not-started' })))
    .finally(async () => { await stopNode; stopped = true; app.quit(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', showWindow);

if (!locked) app.quit();
else app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  appLock = new AppLock({ profile, onEvent: lockEvent,
    authenticator: demo ? createAuthenticator({ platform: 'none' }) : createAuthenticator({ systemPreferences, execFile,
      helper: path.join(runtime, 'windows-hello', 'chicory-hello.exe'),
      windowHandle: () => (window && !window.isDestroyed() ? window.getNativeWindowHandle() : null) }),
    isForeground: () => !!window && !window.isDestroyed() && window.isFocused() });
  diagnostics.startupBegan();
  powerMonitor.on('suspend', () => diagnostics.suspend());
  powerMonitor.on('resume', () => diagnostics.resume());
  // A download interrupted by a crash, cancellation or a full disk leaves
  // nothing worth keeping. Installed or skipped installers are not reused.
  try { cleanStaging(updateDirectory); } catch {}
  const desktopSession = session.fromPartition(demo ? 'persist:chicory-demo' : 'persist:chicory');
  desktopSession.protocol.handle('chicory-app', handleRequest);
  if (!demo) {
    eraser = createEraser(desktopSession);
    // An erase that was interrupted finishes before any key or wallet opens.
    if (hasPendingErase(profile) && !(await finishPendingErase())) return;
  }
  createWindow(desktopSession);
  installPermissions(desktopSession);
  installMenu();
  installLock();
  if (floresta) installFlorestaIpc({ ipcMain, settings: floresta, appLock, dialog, window: () => window,
    trusted: trustedSender, allowed: () => !stopping && !erasing && !gate.active });
  if (!demo) installFullBackupIpc({ ipcMain, trusted: trustedSender, appLock, dialog, fs, call: managerCall,
    window: () => window, documents: () => app.getPath('documents') });
  // With the lock on, no key is loaded and no wallet engine starts until it opens.
  const deferred = appLock.required();
  if (!deferred) await ensureManager();
  if (stopping) return diagnostics.startupEnded('cancelled');
  await window.loadURL(demo ? `${APP_URL}?demo` : manualSetup ? SETUP_URL : APP_URL);
  loaded = true;
  // A locked launch records its startup once the lock opens and the wallet starts.
  if (deferred) diagnostics.state('app', 'locked');
  else diagnostics.startupEnded('ready');
}).catch(async (error) => {
  if (stopping || error.reported) return;
  diagnostics.startupEnded('failed', error);
  await failureDialog(null, 'Chicory could not open.', error.message);
  app.quit();
});
