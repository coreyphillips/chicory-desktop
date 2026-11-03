'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

module.exports = async function verifyRuntime(context) {
  const root = context.packager.projectDir;
  const runtime = path.join(root, '.runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
  const arch = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'][context.arch];
  if (manifest.platform !== context.electronPlatformName || manifest.arch !== arch ||
      manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('The wallet runtime must be prepared and packaged on its target OS and architecture.');
  }
  const engine = path.join(runtime, 'engine');
  const lockHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'build/runtime/package-lock.json'))).digest('hex');
  if (manifest.node !== '24.22.1' || manifest.engine !== '0.36.1' || manifest.engineLockSha256 !== lockHash) {
    throw new Error('The bundled runtime is out of date. Run npm run runtime:prepare before packaging.');
  }
  const node = path.join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  execFileSync(node, ['-e', `
    if (process.version !== 'v24.22.1') throw new Error('Wrong bundled Node version.');
    if (require('beignet/package.json').version !== '0.36.1') throw new Error('Wrong wallet engine version.');
    const Database = require('better-sqlite3');
    const database = new Database(':memory:');
    database.prepare('select 1').get();
    database.close();
  `], { cwd: engine, stdio: 'inherit' });
};
