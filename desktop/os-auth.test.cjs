'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAuthenticator, REASONS } = require('./os-auth.cjs');

test('macOS offers Touch ID only where it can prompt and reports cancellation explicitly', async () => {
  const prompts = [];
  const answers = [undefined, new Error('Canceled by user.'), new Error('Biometry is locked out.')];
  const systemPreferences = {
    canPromptTouchID: () => true,
    promptTouchID: async (reason) => { prompts.push(reason); const answer = answers.shift(); if (answer) throw answer; },
  };
  const mac = createAuthenticator({ platform: 'darwin', systemPreferences });
  assert.deepEqual(await mac.availability(), { kind: 'fingerprint' });
  assert.deepEqual(await mac.authenticate('unlock'), { ok: true });
  assert.deepEqual(await mac.authenticate('reveal'), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await mac.authenticate('enable'), { ok: false, reason: 'failed' });
  assert.deepEqual(prompts, [REASONS.unlock, REASONS.reveal, REASONS.enable]);
  assert.deepEqual(await mac.authenticate('<script>'), { ok: true }, 'unknown purposes fall back to fixed text');
  assert.equal(prompts.at(-1), REASONS.unlock);

  const noSensor = createAuthenticator({ platform: 'darwin', systemPreferences: { ...systemPreferences, canPromptTouchID: () => false } });
  assert.deepEqual(await noSensor.availability(), { kind: null }, 'no toggle without Touch ID');
  const throwing = createAuthenticator({ platform: 'darwin', systemPreferences: { canPromptTouchID: () => { throw new Error(); } } });
  assert.deepEqual(await throwing.availability(), { kind: null });
  assert.deepEqual(await throwing.authenticate('unlock'), { ok: false, reason: 'unavailable' });
});

test('Windows uses Windows Hello through the system PowerShell with fixed prompt text', async () => {
  const runs = [];
  const answers = ['Available', 'Verified', 'Canceled', 'NotConfiguredForUser', 'RetriesExhausted', new Error('timeout'), 'DeviceNotPresent'];
  const execFile = (file, args, options, callback) => {
    runs.push({ file, args, options });
    const answer = answers.shift();
    if (answer instanceof Error) callback(answer, '');
    else callback(null, `${answer}\r\n`);
  };
  const windows = createAuthenticator({ platform: 'win32', execFile, env: { SystemRoot: 'C:\\Windows' } });
  assert.deepEqual(await windows.availability(), { kind: 'passcode' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: true });
  assert.deepEqual(await windows.authenticate('reveal'), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'failed' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'failed' }, 'a crashed or timed out helper fails closed');
  assert.deepEqual(await windows.availability(), { kind: null });
  for (const run of runs) {
    assert.equal(run.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'never resolved through PATH');
    assert.equal(run.options.windowsHide, true);
    const script = Buffer.from(run.args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /UserConsentVerifier/);
    assert.ok(Object.values(REASONS).some(reason => script.includes(`Chicory: ${reason}`)));
  }
  assert.match(Buffer.from(runs[2].args.at(-1), 'base64').toString('utf16le'), /'verify' -eq 'check'/);
});

test('Linux and other systems report no authentication and never pass', async () => {
  for (const platform of ['linux', 'freebsd', 'none']) {
    const auth = createAuthenticator({ platform, execFile: () => assert.fail('nothing is spawned') });
    assert.deepEqual(await auth.availability(), { kind: null });
    assert.deepEqual(await auth.authenticate('unlock'), { ok: false, reason: 'unavailable' });
  }
});
