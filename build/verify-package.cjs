'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async function verifyPackage(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : path.join(context.appOutDir, 'resources');
  const node = path.join(resources, 'runtime/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  for (const relative of ['dist/index.html', 'server/index.js', 'runtime/node/LICENSE',
    'runtime/engine/node_modules/beignet/dist/cli/cli.js', 'app.asar']) {
    if (!fs.existsSync(path.join(resources, relative))) throw new Error(`Packaged resource is missing: ${relative}`);
  }
  execFileSync(node, ['-e', `
    require('express'); require('http-proxy-middleware'); require('bip39'); require('bitcoinjs-lib');
  `], { cwd: path.join(resources, 'server'), stdio: 'inherit' });
  execFileSync(node, ['-e', `
    if (require('beignet/package.json').version !== '0.36.1') throw new Error('Wrong packaged engine version.');
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    database.prepare('select 1').get();
    database.close();
    console.log('Packaged wallet dependencies and native SQLite verified.');
  `], { cwd: path.join(resources, 'runtime/engine'), stdio: 'inherit' });
};
