'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, screen, session, shell, protocol, safeStorage } = require('electron');
const { fork } = require('node:child_process');
const { loadStorageKey } = require('./storage-key.cjs');
const { BundledTor } = require('./tor.cjs');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { APP_URL, CSP, isAppURL, isPaymentLink, isExternalURL, staticPath, managerHeaders, windowBounds } = require('./policy.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'chicory-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);

const demo = process.argv.includes('--demo');
app.setName('Chicory');
const profile = process.env.CHICORY_PROFILE_DIR || path.join(app.getPath('appData'), demo ? 'Chicory Desktop Demo' : 'Chicory Desktop');
app.setPath('userData', profile);
const locked = app.requestSingleInstanceLock();
let window;
let manager;
let tor;
let torProxy;
const torRequests = new Set();
let origin;
let stopping = false;
let stopped = false;
let quitting;
const token = randomBytes(32).toString('hex');
const root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const runtime = path.join(root, app.isPackaged ? 'runtime' : '.runtime');
const publicDirectory = path.join(root, 'dist');

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
  // Never queue a payment link across startup or wallet selection.
  if (!isPaymentLink(url) || !window || window.webContents.isLoading()) return;
  showWindow();
  command('payment-link', url);
}

app.on('second-instance', (_event, argv) => {
  showWindow();
  const link = argv.find(isPaymentLink);
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
    throw new Error('The local wallet runtime is missing. For a source checkout, run npm run runtime:prepare.');
  }
  fs.mkdirSync(path.join(profile, 'wallets'), { recursive: true, mode: 0o700 });
  const key = await loadStorageKey({ profile, safeStorage, platform: process.platform });
  if (stopping) { key.fill(0); return; }
  tor = new BundledTor({ bundleDirectory: path.join(runtime, 'tor'), dataDirectory: path.join(profile, 'tor'),
    onStatus: status => {
      if (manager?.connected && !stopping) manager.send({ type: 'tor:status', status }, () => {});
    } });
  try { torProxy = await tor.startProxy(); } catch (error) { key.fill(0); throw error; }
  if (stopping) { key.fill(0); await tor.stop(); return; }
  try {
    manager = fork(path.join(root, 'server/desktop-bootstrap.js'), [], {
      execPath: node, env: managerEnvironment(), cwd: profile,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
  } catch (error) { key.fill(0); throw error; }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The local wallet did not finish starting.')), 30000);
    manager.once('error', (error) => { clearTimeout(timeout); reject(error); });
    manager.once('exit', () => {
      clearTimeout(timeout);
      if (!origin) reject(new Error('The local wallet could not start. Check the runtime installation.'));
      else if (!stopping) {
        void dialog.showMessageBox(window, { type: 'error', title: 'Chicory', message: 'The local wallet stopped.',
          detail: 'Quit and reopen Chicory to reconnect. Your wallet files remain on this computer.', buttons: ['Quit'] }).then(() => app.quit());
      }
    });
    manager.on('message', (message) => {
      if (message?.type === 'startup-error') {
        clearTimeout(timeout);
        reject(new Error(message.code === 'STORAGE_UNAVAILABLE' ? String(message.message).slice(0, 300) : 'The local wallet could not start.'));
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

async function stopManager() {
  if (!manager || manager.exitCode !== null || manager.signalCode !== null) return;
  const child = manager;
  await new Promise((resolve) => {
    // The manager gives each wallet a bounded graceful stop before terminating it.
    const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 45000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }, () => {});
    else child.kill('SIGTERM');
  });
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
  if (demo) {
    if (!['GET', 'HEAD'].includes(request.method) || /^\/(api|wallets)(\/|$)/.test(url.pathname)) return response('Demo mode has no wallet service.', 403);
    const file = staticPath(publicDirectory, url.pathname);
    if (!file) return response('Not found', 404);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try { return response(request.method === 'HEAD' ? null : await fs.promises.readFile(file), 200, types[path.extname(file)] || 'application/octet-stream'); }
    catch { return response('Not found', 404); }
  }
  if (!origin || stopping) return response('The local wallet is unavailable.', 503);
  try {
    const upstream = await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method, headers: managerHeaders(request.headers, token, origin),
      ...(!['GET', 'HEAD'].includes(request.method) ? { body: await request.arrayBuffer() } : {}),
      signal: request.signal, redirect: 'error',
    });
    const headers = new Headers(upstream.headers);
    // fetch has already decoded content. Do not forward stale compression lengths.
    for (const key of ['content-encoding', 'content-length', 'set-cookie', 'x-chicory-session']) headers.delete(key);
    headers.set('Content-Security-Policy', CSP);
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch { return response('The local wallet is unavailable. Reopen Chicory to reconnect.', 503); }
}

function installMenu() {
  const go = (label, accelerator, scene) => ({ label, accelerator, click: () => command(scene) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Chicory', submenu: [
      { role: 'about' }, { type: 'separator' }, go('Settings', 'CommandOrControl+,', 'settings'),
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'Wallet', submenu: [go('Overview', 'CommandOrControl+1', 'home'), go('Send', 'CommandOrControl+2', 'send'),
      go('Receive', 'CommandOrControl+3', 'receive'), go('Activity', 'CommandOrControl+4', 'activity'),
      ...(process.platform !== 'darwin' ? [go('Settings', 'CommandOrControl+,', 'settings'), { type: 'separator' }, { role: 'quit' }] : [])] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : [])] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Chicory Desktop on GitHub', click: () => shell.openExternal('https://github.com/coreyphillips/chicory-desktop') }] },
  ]));
  app.setAboutPanelOptions({ applicationName: 'Chicory', applicationVersion: app.getVersion(),
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
    const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Chicory',
      message: camera ? 'Allow Chicory to use the camera?' : 'Allow Chicory to read the clipboard?',
      detail: camera ? 'QR codes are decoded on this computer. No video is saved or uploaded.' : 'The copied payment request will fill the Send form for review.',
      buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1 });
    callback(answer.response === 0);
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
  ]) ipcMain.on(channel, (event) => {
    if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppURL(event.senderFrame.url)) action();
  });
}

app.on('before-quit', (event) => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  stopping = true;
  quitting = stopManager().finally(() => tor?.stop()).finally(() => { stopped = true; app.quit(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', showWindow);

if (!locked) app.quit();
else app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const desktopSession = session.fromPartition(demo ? 'persist:chicory-demo' : 'persist:chicory');
  desktopSession.protocol.handle('chicory-app', handleRequest);
  createWindow(desktopSession);
  installPermissions(desktopSession);
  installMenu();
  if (!demo) await startManager();
  if (stopping) return;
  await window.loadURL(`${APP_URL}${demo ? '?demo' : ''}`);
}).catch(async (error) => {
  if (stopping) return;
  await dialog.showMessageBox({ type: 'error', title: 'Chicory could not open', message: 'Chicory could not open.',
    detail: error.message, buttons: ['Quit'] });
  app.quit();
});
