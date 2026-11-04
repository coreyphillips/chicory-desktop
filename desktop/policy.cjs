'use strict';

const path = require('node:path');

const APP_URL = 'chicory-app://wallet/';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";

function isAppURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'chicory-app:' && url.hostname === 'wallet' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function isPaymentLink(value) {
  return typeof value === 'string' && value.length <= 16384 && /^(bitcoin|lightning):\S+$/i.test(value) && !/[\x00-\x20\x7f]/.test(value);
}

/** The payment link in a second instance's command line, if any: the first one, never a flag. */
function linkFromArgv(argv) {
  return Array.isArray(argv) ? argv.find(isPaymentLink) ?? null : null;
}

/**
 * Whether a payment link may fill Send now. It is dropped, never queued, while
 * there is no window, the page is still loading, the app lock is closed or the
 * profile is being erased, so it can never land in a wallet opened later. The
 * same link delivered twice in a moment, as an OS may do, fills Send once.
 */
function createLinkGate({ now = Date.now, repeatMs = 2000 } = {}) {
  let last = null;
  return function accept(url, { window = false, loading = false, locked = false, erasing = false } = {}) {
    if (!isPaymentLink(url) || !window || loading || locked || erasing) return false;
    const at = now();
    if (last && last.url === url && at - last.at < repeatMs) return false;
    last = { url, at };
    return true;
  };
}

function isExternalURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['github.com', 'mempool.space', 'blockstream.info'].includes(url.hostname);
  } catch { return false; }
}

function staticPath(directory, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const root = path.resolve(directory);
  const resolved = path.resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

function managerHeaders(requestHeaders, token, origin) {
  const headers = new Headers();
  for (const key of ['accept', 'content-type']) {
    const value = requestHeaders.get(key);
    if (value) headers.set(key, value);
  }
  headers.set('X-Chicory-Session', token);
  headers.set('Origin', origin);
  return headers;
}

function windowBounds(saved, displays) {
  const defaults = { width: 1320, height: 860 };
  const available = displays.filter(({ workArea: area }) => area &&
    [area.x, area.y, area.width, area.height].every(Number.isFinite) && area.width > 0 && area.height > 0);
  if (!available.length) return defaults;
  const fallback = {
    width: Math.min(defaults.width, available[0].workArea.width),
    height: Math.min(defaults.height, available[0].workArea.height),
  };
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) ||
      saved.width <= 0 || saved.height <= 0) return fallback;
  const display = available.find(({ workArea: area }) =>
    saved.x < area.x + area.width - 100 && saved.x + saved.width > area.x + 100 &&
    saved.y >= area.y && saved.y < area.y + area.height - 80);
  if (!display) return fallback;
  const area = display.workArea;
  const width = Math.min(area.width, Math.max(900, Math.round(saved.width)));
  const height = Math.min(area.height, Math.max(640, Math.round(saved.height)));
  return { width, height, x: Math.max(area.x, Math.min(Math.round(saved.x), area.x + area.width - width)),
    y: Math.max(area.y, Math.min(Math.round(saved.y), area.y + area.height - height)) };
}

module.exports = { APP_URL, CSP, isAppURL, isPaymentLink, linkFromArgv, createLinkGate, isExternalURL, staticPath, managerHeaders, windowBounds };
