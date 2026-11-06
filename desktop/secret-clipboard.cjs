'use strict';

const { createHash } = require('node:crypto');

// Long enough to paste once, short enough not to be left lying there.
const CLEAR_AFTER_MS = 60_000;
const MAX_SECRET_LENGTH = 1024;
const fingerprint = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Puts a secret on the system clipboard for a short while. It lives here rather
 * than in the page because a page cannot touch the clipboard once it loses
 * focus, which is when this has to act. Only a fingerprint is kept, and the
 * clipboard is cleared only while it still holds the secret, so whatever the
 * owner copied since is left alone.
 */
function secretClipboard(clipboard, { after = CLEAR_AFTER_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let held = null;
  let timer = null;
  function clear() {
    if (timer !== null) cancel(timer);
    timer = null;
    if (held !== null && fingerprint(clipboard.readText()) === held) clipboard.clear();
    held = null;
  }
  function copy(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_SECRET_LENGTH) return false;
    clipboard.writeText(text);
    held = fingerprint(text);
    if (timer !== null) cancel(timer);
    timer = schedule(clear, after);
    return true;
  }
  return { copy, clear };
}

module.exports = { CLEAR_AFTER_MS, MAX_SECRET_LENGTH, secretClipboard };
