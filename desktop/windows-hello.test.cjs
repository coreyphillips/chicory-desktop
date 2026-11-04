'use strict';

// Runs the built Windows Hello helper on Windows. It never raises a real
// prompt: verification only runs where this computer reports Windows Hello
// unavailable, so a developer's own Windows Hello is never asked.
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { REASONS } = require('./os-auth.cjs');

const skip = process.platform !== 'win32' && 'the helper is Windows only';
const directory = path.join(__dirname, '..', '.runtime', 'windows-hello');
const helper = path.join(directory, 'chicory-hello.exe');
const UNAVAILABLE = ['DeviceNotPresent', 'NotConfiguredForUser', 'DisabledByPolicy', 'DeviceBusy'];
const message = `Chicory: ${REASONS.unlock}`;

function run(args) {
  return new Promise(resolve => {
    execFile(helper, args, { windowsHide: true, timeout: 30000, maxBuffer: 4096 }, (error, stdout, stderr) => resolve({
      code: error ? (typeof error.code === 'number' ? error.code : `killed ${error.code ?? error.signal}`) : 0,
      stdout: String(stdout), stderr: String(stderr),
    }));
  });
}

// A top-level window that is never shown, owned by another process, as
// Chicory's window is to the helper.
async function withWindow(use) {
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$form = New-Object System.Windows.Forms.Form',
    '[Console]::Out.WriteLine($form.Handle.ToInt64())',
    '[Console]::Out.Flush()',
    '[void][Console]::In.ReadLine()',
  ].join('; ')], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    const handle = await new Promise((resolve, reject) => {
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        const line = output.match(/^(\d+)\r?\n/);
        if (line) resolve(line[1]);
      });
      child.once('error', reject);
      exited.then(code => reject(new Error(`The window process exited with ${code} before giving a handle.`)));
      setTimeout(() => reject(new Error('The window process gave no handle.')), 60000).unref();
    });
    return await use(handle);
  } finally {
    child.stdin.end();
    await exited;
  }
}

let checked;
const availability = () => (checked ??= run(['check']));

test('the helper is built from the current source for this computer', { skip }, () => {
  assert.ok(fs.existsSync(helper), 'Run npm run runtime:prepare, or node scripts/desktop/build-windows-hello.mjs.');
  const build = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8'));
  assert.equal(build.arch, process.arch);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(build.source, hash(path.join(__dirname, 'windows-hello', 'hello.cpp')), 'stale helper');
  assert.equal(build.sha256, hash(helper));
});

test('check answers with one availability name', { skip }, async () => {
  const result = await availability();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(['Available', 'InteropUnavailable', ...UNAVAILABLE].includes(result.stdout), `unexpected answer ${JSON.stringify(result.stdout)}`);
  console.log(`Windows Hello on this computer: ${result.stdout}`);
});

test('verify refuses anything but a top-level window and fixed text, before any prompt', { skip }, async () => {
  const refused = async (args, why) => {
    const result = await run(args);
    assert.equal(result.code, 2, `${why}: ${JSON.stringify(result)}`);
    assert.equal(result.stdout, '', `${why}: no answer is printed`);
  };
  await refused([], 'no mode');
  await refused(['check', 'extra'], 'extra arguments');
  await refused(['verify'], 'no window');
  await refused(['prompt', '1', message], 'unknown mode');
  for (const handle of ['', 'abc', '0', '-1', '+5', '0x10', ' 12', '18446744073709551616', '1']) {
    await refused(['verify', handle, message], `window handle ${JSON.stringify(handle)}`);
  }
  await withWindow(async handle => {
    await refused(['verify', handle, ''], 'empty message');
    await refused(['verify', handle, 'x'.repeat(257)], 'oversized message');
    await refused(['verify', handle, 'Chicory:\nunlock'], 'control characters');
    await refused(['verify', handle], 'no message');
  });
});

test('verify answers unavailable for a real window where Windows Hello is not set up', { skip }, async (t) => {
  const answer = (await availability()).stdout;
  if (!UNAVAILABLE.includes(answer)) return t.skip(`Windows Hello reports ${answer} here, so this would raise a real prompt.`);
  await withWindow(async handle => {
    const result = await run(['verify', handle, message]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, answer);
  });
});
