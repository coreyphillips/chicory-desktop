'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAuthenticator, REASONS, windowHandleArgument } = require('./os-auth.cjs');

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

test('Windows raises Windows Hello through the bundled helper, owned by the Chicory window', async () => {
  const helper = 'C:\\Program Files\\Chicory\\resources\\runtime\\windows-hello\\chicory-hello.exe';
  const runs = [];
  const answers = ['Available', 'Verified', 'Canceled', 'NotConfiguredForUser', 'DisabledByPolicy', 'RetriesExhausted',
    'DeviceBusy', new Error('timeout'), '', 'DeviceNotPresent', 'InteropUnavailable', new Error('ENOENT')];
  const execFile = (file, args, options, callback) => {
    runs.push({ file, args, options });
    const answer = answers.shift();
    if (answer instanceof Error) callback(answer, '');
    else callback(null, `${answer}\r\n`);
  };
  // getNativeWindowHandle() is the HWND's bytes, little endian.
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x2_0a_4cn);
  const windows = createAuthenticator({ platform: 'win32', execFile, helper, windowHandle: () => handle });
  assert.deepEqual(await windows.availability(), { kind: 'passcode' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: true });
  assert.deepEqual(await windows.authenticate('reveal'), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await windows.authenticate('enable'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await windows.authenticate('disable'), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'failed' });
  assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'failed' }, 'a busy device is not a pass');
  assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'failed' }, 'a crashed or timed out helper fails closed');
  assert.deepEqual(await windows.authenticate('<script>'), { ok: false, reason: 'failed' }, 'an empty answer fails closed');
  assert.deepEqual(await windows.availability(), { kind: null });
  assert.deepEqual(await windows.availability(), { kind: null }, 'no toggle when the owned prompt is unavailable');
  assert.deepEqual(await windows.availability(), { kind: null }, 'no toggle when the helper is missing');

  for (const run of runs) {
    assert.equal(run.file, helper, 'always the bundled helper');
    assert.equal(run.options.windowsHide, true);
  }
  assert.deepEqual(runs[0].args, ['check']);
  assert.equal(runs[0].options.timeout, 15000);
  assert.deepEqual(runs[1].args, ['verify', String(0x2_0a_4c), `Chicory: ${REASONS.unlock}`]);
  assert.equal(runs[1].options.timeout, 120000);
  assert.deepEqual(runs.slice(1, 9).map(run => run.args[2]), [REASONS.unlock, REASONS.reveal, REASONS.enable, REASONS.disable,
    REASONS.unlock, REASONS.unlock, REASONS.unlock, REASONS.unlock].map(reason => `Chicory: ${reason}`),
  'prompt text comes from the fixed list, and unknown purposes fall back to it');
});

test('Windows needs the Chicory window to own the prompt, and refuses without it', async () => {
  const helper = 'C:\\Chicory\\resources\\runtime\\windows-hello\\chicory-hello.exe';
  const spawned = [];
  const execFile = (file, args, options, callback) => { spawned.push(args); callback(null, 'Verified'); };
  let handle = null;
  const windows = createAuthenticator({ platform: 'win32', execFile, helper, windowHandle: () => handle });
  for (const value of [null, undefined, Buffer.alloc(8), Buffer.alloc(2, 1), 'not a buffer']) {
    handle = value;
    assert.deepEqual(await windows.authenticate('unlock'), { ok: false, reason: 'failed' });
  }
  const throwing = createAuthenticator({ platform: 'win32', execFile, helper, windowHandle: () => { throw new Error('destroyed'); } });
  assert.deepEqual(await throwing.authenticate('unlock'), { ok: false, reason: 'failed' });
  assert.deepEqual(spawned, [], 'no prompt without a window to own it');

  handle = Buffer.alloc(4);
  handle.writeUInt32LE(0xfedc_ba98);
  assert.deepEqual(await windows.authenticate('unlock'), { ok: true });
  assert.equal(spawned[0][1], String(0xfedc_ba98), '32-bit handles are read unsigned');
  assert.equal(windowHandleArgument(Buffer.from('ffffffffffffffff', 'hex')), '18446744073709551615');

  for (const options of [{ helper: 'chicory-hello.exe' }, { helper: '..\\chicory-hello.exe' }, { helper: undefined },
    { helper, windowHandle: undefined }, { helper, execFile: undefined }]) {
    const auth = createAuthenticator({ platform: 'win32', execFile, windowHandle: () => handle, ...options });
    assert.deepEqual(await auth.availability(), { kind: null }, 'a helper found through PATH is never run');
    assert.deepEqual(await auth.authenticate('unlock'), { ok: false, reason: 'unavailable' });
  }
  assert.equal(spawned.length, 1);
});

test('Linux and other systems report no authentication and never pass', async () => {
  for (const platform of ['linux', 'freebsd', 'none']) {
    const auth = createAuthenticator({ platform, execFile: () => assert.fail('nothing is spawned') });
    assert.deepEqual(await auth.availability(), { kind: null });
    assert.deepEqual(await auth.authenticate('unlock'), { ok: false, reason: 'unavailable' });
  }
});
