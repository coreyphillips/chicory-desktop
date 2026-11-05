// Build a qualification candidate. The app's release packaging has its own
// allowlist. Running this tool must never enable a build to serve wallets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const recipe = path.join(root, 'build', 'floresta');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const name = process.platform === 'win32' ? 'florestad.exe' : 'florestad';

async function build({ archive, debug, test }) {
  const pin = JSON.parse(await fs.readFile(path.join(recipe, 'source.json'), 'utf8'));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-floresta-build-'));
  try {
    const sourceUrl = `https://codeload.github.com/getfloresta/Floresta/tar.gz/${pin.commit}`;
    let bytes;
    if (archive) bytes = await fs.readFile(archive);
    else {
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Floresta source download failed (HTTP ${response.status}).`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (sha256(bytes) !== pin.archiveSha256) throw new Error('Floresta source archive checksum mismatch.');
    const tarball = path.join(work, 'source.tar.gz');
    await fs.writeFile(tarball, bytes);
    execFileSync('tar', ['-xzf', tarball], { cwd: work, stdio: 'inherit' });
    const source = path.join(work, 'Floresta-' + pin.commit);
    if (sha256(await fs.readFile(path.join(source, 'Cargo.lock'))) !== pin.upstreamLockSha256) {
      throw new Error('Floresta source lockfile checksum mismatch.');
    }
    const patches = {};
    for (const file of pin.patches) {
      const patch = await fs.readFile(path.join(recipe, file));
      execFileSync('git', ['apply', '--whitespace=error-all', '-'], { cwd: source, input: patch });
      patches[file] = sha256(patch);
    }
    const profile = debug ? 'debug' : 'release';
    const target = path.join(work, 'target');
    execFileSync('cargo', ['build', '--locked', '--bin', 'florestad', '--no-default-features',
      '--features', 'compact-filters', '--target-dir', target, ...(debug ? [] : ['--release'])],
      { cwd: source, stdio: 'inherit' });
    if (test) {
      // Exercise the patched storage, consensus, wire, Electrum and managed
      // control crates against the same source, features and build profile.
      execFileSync('cargo', ['test', '--locked', '--lib', '--no-default-features',
        '-p', 'floresta-chain', '-p', 'floresta-wire', '-p', 'floresta-electrum', '-p', 'floresta-node',
        '--features', 'floresta-node/compact-filters,floresta-chain/flat-chainstore,floresta-chain/bitcoinkernel',
        '--target-dir', target, ...(debug ? [] : ['--release'])], { cwd: source, stdio: 'inherit' });
    }
    const built = path.join(target, profile, name);
    const digest = sha256(await fs.readFile(built));
    const parent = path.join(root, '.runtime', 'floresta-candidates', process.platform + '-' + process.arch);
    await fs.mkdir(parent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(parent, 'install-'));
    const destination = path.join(parent, digest);
    try {
      for (const license of ['LICENSE.md', 'LICENSE-APACHE', 'LICENSE-MIT']) {
        await fs.copyFile(path.join(source, license), path.join(staging, license));
      }
      await fs.copyFile(built, path.join(staging, name));
      const manifest = { release: pin.release, commit: pin.commit, sourceUrl, archiveSha256: pin.archiveSha256, patches,
        cargoLockSha256: sha256(await fs.readFile(path.join(source, 'Cargo.lock'))), profile,
        platform: process.platform, arch: process.arch, sha256: digest };
      await fs.writeFile(path.join(staging, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
      try { await fs.rename(staging, destination); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        if (sha256(await fs.readFile(path.join(destination, name))) !== digest) throw new Error('Existing candidate was modified.');
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    return path.join(destination, name);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: { archive: { type: 'string' }, debug: { type: 'boolean' }, test: { type: 'boolean' } } });
console.log(await build(values));
