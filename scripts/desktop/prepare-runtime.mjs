import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchEngine } from '../apply-engine-patches.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.join(root, '.runtime');
const version = '24.22.1';
// Official release checksums from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
// Pin these with the version so replacing an archive at its URL cannot change a build.
const archives = {
  'darwin-arm64': ['tar.gz', '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7'],
  'darwin-x64': ['tar.gz', 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035'],
  'linux-arm64': ['tar.gz', '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'],
  'linux-x64': ['tar.gz', 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'],
  'win32-arm64': ['zip', 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171'],
  'win32-x64': ['zip', 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'],
};
const target = `${process.platform}-${process.arch}`;
const selected = archives[target];
if (!selected) throw new Error(`Unsupported build host ${target}. Build on the target OS and architecture.`);
const windows = process.platform === 'win32';
const distribution = `node-v${version}-${windows ? 'win' : process.platform}-${process.arch}`;
const archiveName = `${distribution}.${selected[0]}`;
const cache = path.join(runtime, 'downloads');
const archivePath = path.join(cache, archiveName);
await fs.mkdir(cache, { recursive: true });

let archive;
try { archive = await fs.readFile(archivePath); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log(`Downloading the official Node ${version} runtime for ${target}.`);
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archiveName}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}.`);
  archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== selected[1]) {
    throw new Error('The downloaded Node archive failed its pinned SHA256 check.');
  }
  await fs.writeFile(archivePath, archive);
}
if (createHash('sha256').update(archive).digest('hex') !== selected[1]) {
  throw new Error(`The cached Node archive failed its pinned SHA256 check. Remove ${archivePath} and retry.`);
}

const unpack = await fs.mkdtemp(path.join(runtime, 'node-unpack-'));
try {
  if (windows) {
    const literal = (value) => `'${value.replaceAll("'", "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${literal(archivePath)} -DestinationPath ${literal(unpack)}`], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', unpack], { stdio: 'inherit' });
  }
  await fs.rm(path.join(runtime, 'node'), { recursive: true, force: true });
  await fs.rename(path.join(unpack, distribution), path.join(runtime, 'node'));
} finally {
  await fs.rm(unpack, { recursive: true, force: true });
}

const node = path.join(runtime, 'node', windows ? 'node.exe' : 'bin/node');
const npm = path.join(runtime, 'node', windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
const actual = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
if (actual !== `v${version}`) throw new Error(`Expected Node ${version}, found ${actual}.`);
const engine = path.join(runtime, 'engine');
await fs.mkdir(engine, { recursive: true });
for (const name of ['package.json', 'package-lock.json']) {
  await fs.copyFile(path.join(root, 'build/runtime', name), path.join(engine, name));
}
const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${path.dirname(node)}${path.delimiter}${env[pathKey] || ''}`;
// Never inherit Electron's native-module target when provisioning standalone Node.
for (const key of Object.keys(env)) {
  if (/^npm_config_(target|runtime|disturl|arch|target_arch)$/i.test(key)) delete env[key];
}
delete env.ELECTRON_RUN_AS_NODE;
execFileSync(node, [npm, 'ci', '--include=optional', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: engine, env, stdio: 'inherit',
});
patchEngine(path.join(engine, 'node_modules/beignet'));
// Optional dependencies must not silently omit the wallet's durable storage.
execFileSync(node, ['-e', `
  const Database = require('better-sqlite3');
  const database = new Database(':memory:');
  const result = database.prepare('select 1 as value').get();
  database.close();
  if (result.value !== 1) throw new Error('SQLite runtime verification failed.');
  console.log('Standalone Node and native SQLite verified.');
`], { cwd: engine, env, stdio: 'inherit' });
await fs.writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({
  node: version, engine: '0.36.1', platform: process.platform, arch: process.arch,
  nodeArchive: archiveName, nodeArchiveSha256: selected[1],
  engineLockSha256: createHash('sha256').update(await fs.readFile(path.join(engine, 'package-lock.json'))).digest('hex'),
}, null, 2) + '\n');
console.log(`Desktop runtime ready: Node ${version}, Beignet 0.36.1, ${target}.`);
