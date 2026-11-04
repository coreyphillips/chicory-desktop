'use strict';

// Electron main process for the sealed gallery. It lives outside desktop/ so
// electron-builder never packages it. It has no preload, no manager, no Tor,
// an in-memory partition and a temporary profile, and it refuses every
// request that is not for the gallery build and every permission.
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CSP, staticPath } = require('../../desktop/policy.cjs');

const ORIGIN = 'chicory-gallery://gallery';
const directory = path.resolve(process.env.CHICORY_GALLERY_DIR || path.join(__dirname, '../../dist-gallery'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-gallery-'));
app.setName('Chicory Gallery');
app.setPath('userData', profile);
app.setPath('sessionData', profile);

protocol.registerSchemesAsPrivileged([{ scheme: 'chicory-gallery', privileges: { standard: true, secure: true } }]);

const refused = [];
global.galleryRefused = refused;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function isGallery(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'chicory-gallery:' && url.hostname === 'gallery';
  } catch { return false; }
}

app.on('window-all-closed', () => app.quit());
app.on('quit', () => fs.rmSync(profile, { recursive: true, force: true }));

app.whenReady().then(async () => {
  const gallery = session.fromPartition('chicory-gallery', { cache: false });
  gallery.protocol.handle('chicory-gallery', async request => {
    const file = isGallery(request.url) && request.method === 'GET' && staticPath(directory, new URL(request.url).pathname);
    if (!file) return new Response('Forbidden', { status: 403 });
    try {
      return new Response(await fs.promises.readFile(file), { headers: {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': CSP.replace("connect-src 'self'", "connect-src 'none'"),
        'Cache-Control': 'no-store',
      } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  gallery.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isGallery(details.url) || /^(devtools|data|blob):/.test(details.url);
    if (!allowed) refused.push(details.url);
    callback({ cancel: !allowed });
  });
  gallery.setPermissionCheckHandler(() => false);
  gallery.setPermissionRequestHandler((_contents, permission, callback) => {
    refused.push(`permission:${permission}`);
    callback(false);
  });
  gallery.setDevicePermissionHandler(() => false);
  gallery.on('will-download', event => event.preventDefault());

  const window = new BrowserWindow({
    width: Number(process.env.CHICORY_GALLERY_WIDTH) || 1320,
    height: Number(process.env.CHICORY_GALLERY_HEIGHT) || 860,
    useContentSize: true, backgroundColor: '#110e0c', title: 'Chicory gallery',
    webPreferences: { session: gallery, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, spellcheck: false, backgroundThrottling: false },
  });
  window.webContents.on('will-navigate', (event, url) => { if (!isGallery(url)) { refused.push(url); event.preventDefault(); } });
  window.webContents.setWindowOpenHandler(({ url }) => { refused.push(url); return { action: 'deny' }; });
  const driven = process.argv.includes('--driven');
  await window.loadURL(`${ORIGIN}/gallery.html${driven ? '?driven' : ''}`);
});
