'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { extractFile } = require('@electron/asar');
const { verifyTor } = require('./verify-runtime.cjs');
const { previewCandidate } = require('../desktop/floresta-preview.cjs');

module.exports = async function verifyPackage(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : path.join(context.appOutDir, 'resources');
  const node = path.join(resources, 'runtime/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const metadata = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json'));
  const preview = metadata.chicoryChannel === 'floresta-preview';
  const hasNode = fs.existsSync(path.join(resources, 'runtime', 'floresta'));
  if (preview !== hasNode || preview !== Object.hasOwn(metadata, 'chicoryFlorestaPreview') ||
      preview && (context.packager.appInfo.id !== 'com.chicory.desktop.floresta-preview' ||
        !previewCandidate(metadata, resources, context.electronPlatformName, process.arch))) {
    throw new Error('The local node preview can only be included in its dedicated development package.');
  }
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
  if (JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8')).version !== '0.38.0') throw new Error('Wrong packaged engine version.');
  if (!fs.readFileSync(path.join(engine, 'dist/lightning/storage/sqlite-binding.js'), 'utf8').includes("require('./engine-storage.cjs').EncryptedDatabase")) throw new Error('Packaged engine is missing encrypted storage.');
  if (!fs.readFileSync(path.join(engine, 'dist/cli/restore.js'), 'utf8').includes('chicory-desktop-encrypted-restore-v1')) throw new Error('Packaged engine is missing encrypted database restore.');
  const { patchEngineEndpointPolicy } = await import(pathToFileURL(path.join(context.packager.projectDir, 'scripts/apply-engine-endpoint-policy.mjs')).href);
  patchEngineEndpointPolicy(engine, { verifyOnly: true });
  const { patchEngineWatchControl } = await import(pathToFileURL(path.join(context.packager.projectDir, 'scripts/apply-engine-watch-control.mjs')).href);
  patchEngineWatchControl(engine, { verifyOnly: true });
  const { verifyDriver } = await import(pathToFileURL(path.join(context.packager.projectDir, 'scripts/apply-storage-encryption.mjs')).href);
  verifyDriver(node, engine);
  verifyTor(path.join(resources, 'runtime/tor'), context.electronPlatformName, process.arch);
  console.log('Packaged wallet dependencies, encrypted SQLite files and bundled Tor verified.');
};
