'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyIroh, irohAddonsFor } = require('../build/verify-runtime.cjs');

const root = path.resolve(__dirname, '..');
const reviewed = JSON.parse(fs.readFileSync(path.join(root, 'build/runtime/package-lock.json'), 'utf8'));

// A lock as npm writes one: the loader package and an addon per target.
const lockWith = (...targets) => ({
  packages: {
    'node_modules/beignet': { version: '0.38.1' },
    'node_modules/@number0/iroh': { version: '1.1.0', optional: true },
    ...Object.fromEntries(targets.map(([platform, arch, suffix = '']) => [
      `node_modules/@number0/iroh-${platform}-${arch}${suffix}`, { version: '1.1.0', optional: true, os: [platform], cpu: [arch] },
    ])),
  },
});

// An engine install as npm lays it out, with the addon package for `target`
// when one is given. Each state gets its own directory: Node remembers a
// path it has resolved.
function install(t, target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-iroh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modules = path.join(dir, 'node_modules');
  const engine = path.join(modules, 'beignet');
  fs.mkdirSync(path.join(engine, 'dist/cli'), { recursive: true });
  fs.mkdirSync(path.join(modules, '@number0/iroh'), { recursive: true });
  fs.writeFileSync(path.join(modules, '@number0/iroh/package.json'), JSON.stringify({ name: '@number0/iroh', main: 'index.js' }));
  fs.writeFileSync(path.join(modules, '@number0/iroh/index.js'), '');
  if (target) {
    const addon = path.join(modules, `@number0/iroh-${target}`);
    fs.mkdirSync(addon, { recursive: true });
    fs.writeFileSync(path.join(addon, 'package.json'), JSON.stringify({ name: `@number0/iroh-${target}`, main: `iroh.${target}.node` }));
    fs.writeFileSync(path.join(addon, `iroh.${target}.node`), '');
  }
  return engine;
}

test('the reviewed lock names an Iroh addon for the release targets that have one', () => {
  assert.deepEqual(irohAddonsFor(reviewed, 'darwin', 'arm64'), ['@number0/iroh-darwin-arm64']);
  assert.deepEqual(irohAddonsFor(reviewed, 'win32', 'x64'), ['@number0/iroh-win32-x64-msvc']);
  assert.deepEqual(irohAddonsFor(reviewed, 'linux', 'x64').sort(), ['@number0/iroh-linux-x64-gnu', '@number0/iroh-linux-x64-musl']);
  assert.deepEqual(irohAddonsFor({}, 'darwin', 'arm64'), []);
});

test('a target the lock names an addon for must carry it, and it must load under the bundled Node', t => {
  const lock = lockWith(['darwin', 'arm64'], ['linux', 'x64', '-gnu']);
  const loads = [];
  const load = (node, engine) => loads.push([node, engine]);

  const whole = install(t, 'darwin-arm64');
  assert.equal(verifyIroh('/the/node', whole, lock, 'darwin', 'arm64', load), true);
  assert.deepEqual(loads, [['/the/node', whole]]);

  // A packaging slip: the lock names the addon and it did not arrive.
  assert.throws(() => verifyIroh('/the/node', install(t), lock, 'darwin', 'arm64', load), /The Iroh module for darwin-arm64 is missing/);
  // Another platform's addon is not this one's.
  assert.throws(() => verifyIroh('/the/node', install(t, 'darwin-arm64'), lock, 'linux', 'x64', load), /The Iroh module for linux-x64 is missing/);
  assert.equal(loads.length, 1, 'nothing is loaded once the files are known to be missing');

  // An addon that is there and does not load is no module either.
  const broken = () => { throw Object.assign(new Error('Command failed'), { stderr: 'Error: dlopen failed\n' }); };
  assert.throws(() => verifyIroh('/the/node', install(t, 'darwin-arm64'), lock, 'darwin', 'arm64', broken), /does not load under the bundled Node: Error: dlopen failed/);
});

test('a target the lock names no addon for carries none: macOS on x64 (issue #80)', t => {
  const lock = lockWith(['darwin', 'arm64']);
  const load = () => assert.fail('nothing to load');
  // What an Intel Mac build has: the loader, and no addon to go with it.
  assert.equal(verifyIroh('/the/node', install(t), lock, 'darwin', 'x64', load), false);
  // An addon nobody reviewed is refused, not shipped.
  assert.throws(() => verifyIroh('/the/node', install(t, 'darwin-x64'), lock, 'darwin', 'x64', load), /the reviewed lock names none/);
});

test('the prepared runtime agrees with the reviewed lock on this computer', t => {
  const runtime = path.join(root, '.runtime');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8')); } catch { return t.skip('no prepared runtime'); }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return t.skip('the runtime is for another computer');
  const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const engine = path.join(runtime, 'engine/node_modules/beignet');
  // Where an addon is published it is there and loads; where none is, none is there.
  assert.equal(verifyIroh(node, engine, reviewed, process.platform, process.arch), irohAddonsFor(reviewed, process.platform, process.arch).length > 0);
});
