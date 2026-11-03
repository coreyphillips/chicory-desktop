'use strict';

const { timingSafeEqual } = require('node:crypto');

const SESSION_HEADER = 'x-chicory-session';

/**
 * The desktop UI has a private Electron session. Its main process adds this
 * capability only to requests for the manager's exact loopback origin. It is
 * never exposed through preload, HTML, cookies or browser storage.
 */
function createDesktopAccessGuard(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512)
    throw new Error('A strong desktop session token is required.');
  const expected = Buffer.from(token);
  return (req, res, next) => {
    const supplied = req.headers[SESSION_HEADER];
    const value = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    const host = `127.0.0.1:${req.socket.localPort}`;
    const origin = `http://${host}`;
    const authorized = value.length === expected.length && timingSafeEqual(value, expected);
    if (!authorized || req.headers.host !== host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    next();
  };
}

module.exports = { SESSION_HEADER, createDesktopAccessGuard };
