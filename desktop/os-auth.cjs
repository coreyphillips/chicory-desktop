'use strict';

const path = require('node:path');

/** Prompt text is chosen here. Renderer text never reaches a system prompt. */
const REASONS = {
  unlock: 'unlock Chicory',
  enable: 'require authentication to open Chicory',
  disable: 'turn off the Chicory app lock',
  reveal: 'show your recovery phrase',
};

// Windows Hello through UserConsentVerifier. It accepts the PIN as well as
// face or fingerprint, so a changed enrollment still has a way in. The helper
// (desktop/windows-hello/hello.cpp) raises it for the Chicory window's handle,
// so the prompt is owned by that window and opens in front of it, on the same
// monitor.
const WINDOWS_UNAVAILABLE = new Set(['DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy']);
// The helper cancels its own prompt at 110 seconds, before this kills it.
const WINDOWS_VERIFY_TIMEOUT_MS = 120000;
const WINDOWS_CHECK_TIMEOUT_MS = 15000;

/** BrowserWindow.getNativeWindowHandle() as the helper's decimal HWND argument. */
function windowHandleArgument(handle) {
  if (!Buffer.isBuffer(handle)) return null;
  const value = handle.length === 8 ? handle.readBigUInt64LE() : handle.length === 4 ? BigInt(handle.readUInt32LE()) : 0n;
  return value > 0n ? value.toString() : null;
}

function windowsAuthenticator({ execFile, helper, windowHandle }) {
  const run = (args, timeout) => new Promise(resolve => {
    execFile(helper, args, { windowsHide: true, timeout, maxBuffer: 4096 },
      (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
  return {
    async availability() {
      return { kind: (await run(['check'], WINDOWS_CHECK_TIMEOUT_MS)) === 'Available' ? 'passcode' : null };
    },
    async authenticate(purpose) {
      let handle = null;
      try { handle = windowHandleArgument(windowHandle()); } catch {}
      // Without Chicory's window there is nothing to own the prompt.
      if (!handle) return { ok: false, reason: 'failed' };
      const answer = await run(['verify', handle, `Chicory: ${REASONS[purpose] || REASONS.unlock}`], WINDOWS_VERIFY_TIMEOUT_MS);
      if (answer === 'Verified') return { ok: true };
      if (answer === 'Canceled') return { ok: false, reason: 'cancelled' };
      if (WINDOWS_UNAVAILABLE.has(answer)) return { ok: false, reason: 'unavailable' };
      return { ok: false, reason: 'failed' };
    },
  };
}

function macAuthenticator({ systemPreferences }) {
  return {
    async availability() {
      let available = false;
      try { available = systemPreferences?.canPromptTouchID?.() === true; } catch {}
      return { kind: available ? 'fingerprint' : null };
    },
    async authenticate(purpose) {
      if (typeof systemPreferences?.promptTouchID !== 'function') return { ok: false, reason: 'unavailable' };
      // Electron asks for user presence, so the account password stands in
      // when Touch ID is unavailable, closed in clamshell or re-enrolled.
      try { await systemPreferences.promptTouchID(REASONS[purpose] || REASONS.unlock); return { ok: true }; }
      catch (error) {
        return { ok: false, reason: /cancel/i.test(String(error?.message ?? error)) ? 'cancelled' : 'failed' };
      }
    },
  };
}

const unavailable = {
  async availability() { return { kind: null }; },
  async authenticate() { return { ok: false, reason: 'unavailable' }; },
};

/**
 * macOS uses Touch ID with the account password as fallback, and Windows uses
 * Windows Hello through the bundled helper, given by its absolute path so it
 * is never resolved through PATH. Linux has no user-presence API Chicory can
 * rely on, so it reports none and Settings shows no toggle there.
 */
function createAuthenticator({ platform = process.platform, systemPreferences, execFile, helper, windowHandle } = {}) {
  if (platform === 'darwin') return macAuthenticator({ systemPreferences });
  if (platform === 'win32' && typeof execFile === 'function' && typeof windowHandle === 'function' &&
      typeof helper === 'string' && path.win32.isAbsolute(helper)) {
    return windowsAuthenticator({ execFile, helper, windowHandle });
  }
  return unavailable;
}

module.exports = { createAuthenticator, REASONS, windowHandleArgument };
