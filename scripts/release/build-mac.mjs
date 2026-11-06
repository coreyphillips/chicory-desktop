// Builds this Mac's release package the way .github/workflows/release.yml does:
// check, package, sign, notarize and verify. See docs/releases.md.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { missingMacCredentials } = require(path.join(root, 'build/release.cjs'));

if (process.platform !== 'darwin') throw new Error('A macOS release must be built on macOS.');
const missing = missingMacCredentials(process.env);
if (missing.length) {
  throw new Error(`Set ${missing.join('; ')}. See "Building a macOS release locally" in docs/releases.md.`);
}

function run(command, ...args) {
  const { status, error } = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

run('npm', 'run', 'check');
run('npx', 'electron-builder', '--config', 'build/electron-builder.release.yml',
  '--mac', `--${process.arch}`, '--publish', 'never');
run('bash', 'scripts/release/verify-mac.sh');
console.log(`Signed, notarized and verified the macOS ${process.arch} package in release/.`);
