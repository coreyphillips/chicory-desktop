import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_VERSION = '24.22.1';
const DRIVER_VERSION = '13.0.3';
const DEFINES_SHA256 = '9139d3ce20fb5cd848e95da2fd20d4c4fd3d8d33b512d2781d70cb2a3de7c5bb';
// Official release checksums: https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
const HEADERS_SHA256 = '322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267';
const WINDOWS_LIB_SHA256 = {
  x64: 'a0a84aa03917b578d286010b7521837e9ff1136ffb2e4a406c14316c33fd06f7',
  arm64: '2c0c3215d59c09d7c136da4949696dae121a299e9bdfc64cd9130a58610af63d',
};
const ORIGINAL_BINDING = "const binding = require('better-sqlite3');";
const ENCRYPTED_BINDING = "const binding = require('./engine-storage.cjs').EncryptedDatabase; // chicory-desktop-encrypted-storage-v1";
const ORIGINAL_RESTORE_CHECK = `function isSqliteFile(filePath) {
    const fs = (0, node_builtins_1.nodeFs)();
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
    }
    catch {
        return false;
    }
    try {
        const header = Buffer.alloc(exports.SQLITE_HEADER.length);
        const read = fs.readSync(fd, header, 0, header.length, 0);
        return read === exports.SQLITE_HEADER.length && header.equals(exports.SQLITE_HEADER);
    }
    finally {
        fs.closeSync(fd);
    }
}`;
const ENCRYPTED_RESTORE_CHECK = `function isSqliteFile(filePath) {
    // chicory-desktop-encrypted-restore-v1: authenticate the encrypted pages.
    return require('../lightning/storage/engine-storage.cjs').isUnlockedDatabase(filePath);
}`;
const ORIGINAL_RESTORE_ERROR = "Not a SQLite database (missing 'SQLite format 3' header):";
const ENCRYPTED_RESTORE_ERROR = 'Not an unlocked encrypted wallet database:';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const once = (text, needle) => text.split(needle).length === 2;

function buildEnvironment(node) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(target|runtime|disturl|dist_url|arch|target_arch|nodedir)$/i.test(key)) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODEJS_ORG_MIRROR;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = `${path.dirname(node)}${path.delimiter}${env[pathKey] || ''}`;
  return env;
}

async function downloadChecked(url, checksum, filename) {
  let data;
  if (fs.existsSync(filename)) data = fs.readFileSync(filename);
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Encrypted storage build download failed: HTTP ${response.status}.`);
    data = Buffer.from(await response.arrayBuffer());
  }
  if (sha256(data) !== checksum) throw new Error('Encrypted storage build input failed its pinned SHA256 check.');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, data);
}

async function headerDirectory(node, env) {
  const nodeRoot = process.platform === 'win32' ? path.dirname(node) : path.dirname(path.dirname(node));
  if (process.platform !== 'win32') {
    if (!fs.existsSync(path.join(nodeRoot, 'include/node/node.h'))) throw new Error('Pinned Node headers are missing from the runtime.');
    return nodeRoot;
  }
  // The Windows Node archive omits the development headers and import library.
  // Pin both inputs and use --nodedir so node-gyp cannot fetch unpinned inputs.
  const cache = path.resolve(nodeRoot, '../downloads');
  const archive = path.join(cache, `node-v${NODE_VERSION}-headers.tar.gz`);
  const lib = path.join(cache, `node-v${NODE_VERSION}-win-${process.arch}.lib`);
  if (!WINDOWS_LIB_SHA256[process.arch]) throw new Error('Unsupported Windows architecture.');
  await downloadChecked(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-headers.tar.gz`, HEADERS_SHA256, archive);
  await downloadChecked(`https://nodejs.org/dist/v${NODE_VERSION}/win-${process.arch}/node.lib`, WINDOWS_LIB_SHA256[process.arch], lib);
  const unpack = fs.mkdtempSync(path.join(cache, 'cipher-headers-'));
  execFileSync('tar.exe', ['-xzf', archive, '-C', unpack], { env, stdio: 'inherit' });
  const headers = path.join(unpack, `node-v${NODE_VERSION}`);
  fs.mkdirSync(path.join(headers, 'Release'), { recursive: true });
  fs.copyFileSync(lib, path.join(headers, 'Release/node.lib'));
  return headers;
}

/** Build only the pinned installed package. Never modify an upstream checkout. */
export async function patchStorageEncryption(directory, { node } = {}) {
  const root = path.resolve(directory);
  if (!node) throw new Error('The pinned standalone Node binary is required to build encrypted storage.');
  node = path.resolve(node);
  const env = buildEnvironment(node);
  if (execFileSync(node, ['--version'], { encoding: 'utf8', env }).trim() !== `v${NODE_VERSION}`) {
    throw new Error(`Encrypted storage requires standalone Node ${NODE_VERSION}.`);
  }
  if (fs.existsSync(path.join(root, '.git'))) throw new Error('Refusing to patch a source checkout.');
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (packageInfo.name !== 'beignet' || packageInfo.version !== '0.38.0') throw new Error('Encrypted storage requires Beignet 0.38.0.');
  const driver = path.resolve(root, '../better-sqlite3-multiple-ciphers');
  const driverInfo = JSON.parse(fs.readFileSync(path.join(driver, 'package.json'), 'utf8'));
  if (driverInfo.name !== 'better-sqlite3-multiple-ciphers' || driverInfo.version !== DRIVER_VERSION || fs.existsSync(path.join(driver, '.git'))) {
    throw new Error('The encrypted storage driver does not match the pinned installed package.');
  }
  const bindingPath = path.join(root, 'dist/lightning/storage/sqlite-binding.js');
  const binding = fs.readFileSync(bindingPath, 'utf8');
  if (!once(binding, ORIGINAL_BINDING) && !once(binding, ENCRYPTED_BINDING)) throw new Error('The engine storage source shape does not match the reviewed patch.');
  const restorePath = path.join(root, 'dist/cli/restore.js');
  const restore = fs.readFileSync(restorePath, 'utf8');
  if (!(once(restore, ORIGINAL_RESTORE_CHECK) && once(restore, ORIGINAL_RESTORE_ERROR)) &&
      !(once(restore, ENCRYPTED_RESTORE_CHECK) && once(restore, ENCRYPTED_RESTORE_ERROR))) {
    throw new Error('The engine restore source shape does not match the reviewed encryption patch.');
  }
  const definesPath = path.join(driver, 'deps/defines.gypi');
  const defines = fs.readFileSync(definesPath, 'utf8');
  const original = defines.replace('SQLITE_USE_URI=1', 'SQLITE_USE_URI=0').replace("    'SQLITE_TEMP_STORE=3',\n", '');
  if (sha256(original) !== DEFINES_SHA256 || !once(original, 'SQLITE_USE_URI=0')) {
    throw new Error('The encrypted storage build flags do not match the reviewed driver.');
  }
  const patched = original.replace("    'SQLITE_USE_URI=0',", "    'SQLITE_TEMP_STORE=3',\n    'SQLITE_USE_URI=1',");
  fs.writeFileSync(definesPath, patched);
  const addon = path.join(driver, 'build/Release/better_sqlite3.node');
  const manifestPath = path.join(driver, '.chicory-native-build.json');
  const manifest = { node: NODE_VERSION, driver: DRIVER_VERSION, platform: process.platform, arch: process.arch, definesSha256: sha256(patched) };
  let current;
  try { current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  const reusable = current && Object.entries(manifest).every(([key, value]) => current[key] === value) && fs.existsSync(addon) && current.addonSha256 === sha256(fs.readFileSync(addon));
  if (!reusable) {
    const nodeRoot = process.platform === 'win32' ? path.dirname(node) : path.dirname(path.dirname(node));
    const gyp = path.join(nodeRoot, process.platform === 'win32' ? 'node_modules/npm/node_modules/node-gyp/bin/node-gyp.js' : 'lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js');
    const headers = await headerDirectory(node, env);
    try {
      execFileSync(node, [gyp, 'rebuild', '--release', '--force_build=1', `--nodedir=${headers}`], { cwd: driver, env, stdio: 'inherit' });
    } finally {
      if (process.platform === 'win32') fs.rmSync(path.dirname(headers), { recursive: true, force: true });
    }
    if (!fs.existsSync(addon)) throw new Error('The encrypted SQLite native build produced no binding.');
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, addonSha256: sha256(fs.readFileSync(addon)) }, null, 2) + '\n');
  }
  fs.copyFileSync(fileURLToPath(new URL('../server/engine-storage.cjs', import.meta.url)), path.join(root, 'dist/lightning/storage/engine-storage.cjs'));
  fs.writeFileSync(bindingPath, binding.replace(ORIGINAL_BINDING, ENCRYPTED_BINDING));
  fs.writeFileSync(restorePath, restore.replace(ORIGINAL_RESTORE_CHECK, ENCRYPTED_RESTORE_CHECK).replace(ORIGINAL_RESTORE_ERROR, ENCRYPTED_RESTORE_ERROR));
  return { version: packageInfo.version, driver: DRIVER_VERSION, built: !reusable };
}

/** A real file proves that the packaged driver encrypts persistent pages. */
export function verifyDriver(node, directory) {
  execFileSync(node, ['-e', `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { openEncryptedDatabase, verifyDatabase } = require(path.join(process.argv[1], 'dist/lightning/storage/engine-storage.cjs'));
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-storage-verify-'));
    let database;
    try {
      const file = path.join(folder, 'wallet.db');
      const key = crypto.randomBytes(32).toString('hex');
      const marker = 'chicory-encrypted-storage-build-probe';
      database = openEncryptedDatabase(file, key);
      database.exec('CREATE TABLE probe(value TEXT)');
      database.prepare('INSERT INTO probe VALUES (?)').run(marker);
      database.close(); database = undefined;
      const bytes = fs.readFileSync(file);
      if (bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\\0')) || bytes.includes(Buffer.from(marker))) throw new Error();
      verifyDatabase(file, key);
      let refused = false;
      try { verifyDatabase(file, crypto.randomBytes(32).toString('hex')); } catch { refused = true; }
      if (!refused) throw new Error();
      console.log('Encrypted SQLite file creation, reopen and wrong-key refusal verified.');
    } catch { throw new Error('Encrypted SQLite file verification failed.'); }
    finally { if (database?.open) database.close(); fs.rmSync(folder, { recursive: true, force: true }); }
  `, path.resolve(directory)], { env: buildEnvironment(node), stdio: 'inherit' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node scripts/apply-storage-encryption.mjs /path/to/installed/beignet /path/to/node');
  const result = await patchStorageEncryption(process.argv[2], { node: process.argv[3] });
  verifyDriver(process.argv[3], process.argv[2]);
  console.log(`Encrypted storage ready: Beignet ${result.version}, driver ${result.driver}.`);
}
