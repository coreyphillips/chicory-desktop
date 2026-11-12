'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { verifyTor, verifyIroh } = require('./verify-runtime.cjs');

module.exports = async function verifyPackage(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : path.join(context.appOutDir, 'resources');
  const node = path.join(resources, 'runtime/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  for (const relative of ['dist/index.html', 'server/index.js', 'server/engine-bootstrap.js', 'server/engine-storage.cjs',
    'runtime/node/LICENSE', 'runtime/engine/node_modules/beignet/dist/cli/cli.js',
    'runtime/engine/node_modules/beignet/dist/lightning/storage/engine-storage.cjs',
    'runtime/engine/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node',
    'runtime/tor/bundle.json', 'app.asar',
    ...(context.electronPlatformName === 'win32' ? ['runtime/windows-hello/chicory-hello.exe'] : [])]) {
    if (!fs.existsSync(path.join(resources, relative))) throw new Error(`Packaged resource is missing: ${relative}`);
  }
  execFileSync(node, ['-e', `
    require('express'); require('http-proxy-middleware'); require('bip39'); require('bitcoinjs-lib');
  `], { cwd: path.join(resources, 'server'), stdio: 'inherit' });
  const engine = path.join(resources, 'runtime/engine/node_modules/beignet');
  if (JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8')).version !== '0.38.1') throw new Error('Wrong packaged engine version.');
  if (!fs.readFileSync(path.join(engine, 'dist/lightning/storage/sqlite-binding.js'), 'utf8').includes("require('./engine-storage.cjs').EncryptedDatabase")) throw new Error('Packaged engine is missing encrypted storage.');
  if (!fs.readFileSync(path.join(engine, 'dist/cli/restore.js'), 'utf8').includes('chicory-desktop-encrypted-restore-v1')) throw new Error('Packaged engine is missing encrypted database restore.');
  const { verifyDriver } = await import(pathToFileURL(path.join(context.packager.projectDir, 'scripts/apply-storage-encryption.mjs')).href);
  verifyDriver(node, engine);
  const lock = JSON.parse(fs.readFileSync(path.join(context.packager.projectDir, 'build/runtime/package-lock.json'), 'utf8'));
  const iroh = verifyIroh(node, engine, lock, context.electronPlatformName, process.arch);
  verifyTor(path.join(resources, 'runtime/tor'), context.electronPlatformName, process.arch);
  console.log('Packaged wallet dependencies, encrypted SQLite files and bundled Tor verified.');
  console.log(iroh
    ? 'The packaged Iroh module loads under the bundled Node.'
    : `No Iroh module is published for ${context.electronPlatformName}-${process.arch}: this build takes an Iroh link only with its onion fallback.`);
};
