'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { torEnvironment } = require('../desktop/tor.cjs');

function verifyTor(directory, platform, arch) {
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'tor-manifest.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8'));
  const archive = expected.platforms[`${platform}-${arch}`];
  if (!archive || manifest.platform !== platform || manifest.arch !== arch ||
      manifest.torVersion !== expected.torVersion || manifest.bundleVersion !== expected.bundleVersion ||
      manifest.archiveSha256 !== archive.sha256) {
    throw new Error('The bundled Tor resources do not match the reviewed platform manifest.');
  }
  const binary = path.join(directory, 'tor', platform === 'win32' ? 'tor.exe' : 'tor');
  for (const relative of ['data/geoip', 'data/geoip6', 'docs/GPL-3.0.txt', 'source/README.txt', `source/tor-${manifest.torVersion}.tar.gz`]) {
    if (!fs.existsSync(path.join(directory, relative))) throw new Error(`Bundled Tor resource is missing: ${relative}`);
  }
  const sources = [{ file: `tor-${expected.torVersion}.tar.gz`, sha256: expected.source.sha256 }, ...(expected.additionalSources || [])];
  for (const source of sources) {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(directory, 'source', source.file))).digest('hex');
    if (hash !== source.sha256) throw new Error('Bundled Tor source failed its pinned SHA256 check.');
  }
  const version = execFileSync(binary, ['--version'], { env: torEnvironment(directory), encoding: 'utf8' });
  if (!version.startsWith(`Tor version ${expected.torVersion} `)) throw new Error('The bundled Tor executable has the wrong version.');
}

// The app lock's Windows Hello helper must be built from the current source
// for this architecture. Its build record is written by runtime:prepare.
function verifyWindowsHello(root, arch) {
  const directory = path.join(root, '.runtime/windows-hello');
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let build;
  let binary;
  try {
    build = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8'));
    binary = hash(path.join(directory, 'chicory-hello.exe'));
  } catch { throw new Error('The Windows Hello helper is missing. Run npm run runtime:prepare.'); }
  if (build.source !== hash(path.join(root, 'desktop/windows-hello/hello.cpp')) || build.arch !== arch || build.sha256 !== binary) {
    throw new Error('The Windows Hello helper is stale. Run npm run runtime:prepare.');
  }
}

// The @number0/iroh addon packages the reviewed lock names for a target.
function irohAddonsFor(lock, platform, arch) {
  return Object.entries(lock.packages || {})
    .filter(([name, entry]) => /(^|\/)node_modules\/@number0\/iroh-[^/]+$/.test(name) &&
      (entry.os || []).includes(platform) && (entry.cpu || []).includes(arch))
    .map(([name]) => name.slice(name.lastIndexOf('@number0/')));
}

function loadIroh(node, engine) {
  execFileSync(node, ['-e', "process.exit(require('@number0/iroh/index.js').Endpoint ? 0 : 1)"], { cwd: engine, stdio: 'pipe', timeout: 60000 });
}

// The engine opens Iroh connections through a native module published per
// platform. Where the reviewed lock names one for this target, it must be
// installed and must load under the bundled Node, or the app would ship
// saying it can dial an Iroh link when it cannot. Where the lock names none
// (macOS on x64 at @number0/iroh 1.1.0) the app takes an Iroh link only with
// its onion fallback (issue #80), and a module found there anyway is one
// nobody reviewed. Returns whether this target has the module.
function verifyIroh(node, engine, lock, platform, arch, load = loadIroh) {
  const { irohModuleAvailable } = require('../server/engine');
  const expected = irohAddonsFor(lock, platform, arch);
  const found = irohModuleAvailable(path.join(engine, 'dist/cli/cli.js'), { platform, arch });
  if (!expected.length) {
    if (found) throw new Error(`An Iroh module is bundled for ${platform}-${arch}, and the reviewed lock names none.`);
    return false;
  }
  if (!found) throw new Error(`The Iroh module for ${platform}-${arch} is missing. Run npm run runtime:prepare.`);
  try { load(node, engine); } catch (error) {
    throw new Error(`The bundled Iroh module does not load under the bundled Node: ${String(error.stderr || error.message).trim().split('\n').pop()}`);
  }
  return true;
}

module.exports = async function verifyRuntime(context) {
  const root = context.packager.projectDir;
  const runtime = path.join(root, '.runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
  const arch = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch];
  if (manifest.platform !== context.electronPlatformName || manifest.arch !== arch ||
      manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('The wallet runtime must be prepared and packaged on its target OS and architecture.');
  }
  const engine = path.join(runtime, 'engine/node_modules/beignet');
  const lock = fs.readFileSync(path.join(root, 'build/runtime/package-lock.json'));
  const lockHash = createHash('sha256').update(lock).digest('hex');
  if (manifest.node !== '24.22.1' || manifest.engine !== '0.38.1' || manifest.encryptedStorage !== '13.0.3' || manifest.engineLockSha256 !== lockHash) {
    throw new Error('The bundled runtime is out of date. Run npm run runtime:prepare before packaging.');
  }
  const binding = fs.readFileSync(path.join(engine, 'dist/lightning/storage/sqlite-binding.js'), 'utf8');
  if (!binding.includes("require('./engine-storage.cjs').EncryptedDatabase")) throw new Error('The engine encrypted storage patch is missing.');
  if (!fs.readFileSync(path.join(engine, 'dist/cli/restore.js'), 'utf8').includes('chicory-desktop-encrypted-restore-v1')) throw new Error('The encrypted database restore patch is missing.');
  // A wallet that cannot accept its primary's reserve waiver keeps sats that
  // send max can never reach. An older runtime predates this patch.
  if (!fs.readFileSync(path.join(engine, 'dist/cli/beignet-node.js'), 'utf8').includes('chicory-host-zero-reserve-v1')) throw new Error('The engine zero-reserve patch is missing. Run npm run runtime:prepare.');
  if (!fs.readFileSync(path.join(engine, 'dist/lightning/storage/engine-storage.cjs')).equals(fs.readFileSync(path.join(root, 'server/engine-storage.cjs')))) throw new Error('The encrypted storage helper is stale. Run npm run runtime:prepare.');
  const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  if (execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() !== 'v24.22.1') throw new Error('Wrong bundled Node version.');
  const { verifyDriver } = await import(pathToFileURL(path.join(root, 'scripts/apply-storage-encryption.mjs')).href);
  verifyDriver(node, engine);
  verifyIroh(node, engine, JSON.parse(lock), manifest.platform, manifest.arch);
  verifyTor(path.join(runtime, 'tor'), manifest.platform, manifest.arch);
  if (manifest.platform === 'win32') verifyWindowsHello(root, manifest.arch);
};
module.exports.verifyTor = verifyTor;
module.exports.verifyIroh = verifyIroh;
module.exports.irohAddonsFor = irohAddonsFor;
