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
// face or fingerprint, so a changed enrollment still has a way in.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
} | Select-Object -First 1
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$availability = Await ($verifier::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ('__MODE__' -eq 'check' -or [string]$availability -ne 'Available') { [Console]::Out.Write([string]$availability); exit 0 }
$result = Await ($verifier::RequestVerificationAsync('Chicory: __REASON__')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
[Console]::Out.Write([string]$result)
`;

const WINDOWS_UNAVAILABLE = new Set(['DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy']);

function windowsCommand(mode, reason) {
  const script = WINDOWS_SCRIPT.replace('__MODE__', mode).replace('__REASON__', reason);
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function windowsAuthenticator({ execFile, env }) {
  const shell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (mode, reason, timeout) => new Promise(resolve => {
    execFile(shell, windowsCommand(mode, reason), { windowsHide: true, timeout, maxBuffer: 4096 },
      (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
  return {
    async availability() {
      return { kind: (await run('check', REASONS.unlock, 15000)) === 'Available' ? 'passcode' : null };
    },
    async authenticate(purpose) {
      const answer = await run('verify', REASONS[purpose] || REASONS.unlock, 120000);
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
 * Windows Hello. Linux has no user-presence API Chicory can rely on, so it
 * reports none and Settings shows no toggle there.
 */
function createAuthenticator({ platform = process.platform, systemPreferences, execFile, env = process.env } = {}) {
  if (platform === 'darwin') return macAuthenticator({ systemPreferences });
  if (platform === 'win32' && typeof execFile === 'function') return windowsAuthenticator({ execFile, env });
  return unavailable;
}

module.exports = { createAuthenticator, REASONS, windowsCommand };
