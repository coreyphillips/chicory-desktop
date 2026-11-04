import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Recovery phrases, session tokens and daemon credentials must never reach a
// report that is kept as public release evidence.
const SECRET_KEY = /mnemonic|phrase|seed|secret|token|password|credential|macaroon|private|xprv|cookie|capsule/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item)]));
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function lockVersion(lock, name) {
  return lock?.packages?.[`node_modules/${name}`]?.version ?? null;
}

/** Exact versions from the lockfiles and manifests a package is built from. */
export function dependencyVersions(root) {
  const app = readJson(path.join(root, 'package-lock.json'));
  const runtime = readJson(path.join(root, 'build/runtime/package-lock.json'));
  const tor = readJson(path.join(root, 'build/tor-manifest.json'));
  const wanted = readJson(path.join(root, 'package.json'));
  return {
    app: wanted?.version ?? null,
    electron: lockVersion(app, 'electron'),
    walletCore: app?.packages?.['node_modules/@beignet/wallet-core']?.resolved ?? null,
    beignet: lockVersion(runtime, 'beignet'),
    sqlcipher: lockVersion(runtime, 'better-sqlite3-multiple-ciphers'),
    tor: tor?.torVersion ?? null,
    torBundle: tor?.bundleVersion ?? null,
  };
}

export function resourcesDirectory(executable, platform = process.platform) {
  return platform === 'darwin' ? path.resolve(path.dirname(executable), '../Resources') : path.join(path.dirname(executable), 'resources');
}

/** Files that identify a packaged build. Missing entries are recorded, not guessed. */
export function packageFiles(executable, platform = process.platform) {
  if (!executable) return [];
  const resources = resourcesDirectory(executable, platform);
  const node = path.join(resources, 'runtime/node', platform === 'win32' ? 'node.exe' : 'bin/node');
  return [executable, path.join(resources, 'app.asar'), node,
    path.join(resources, 'runtime/engine/node_modules/beignet/package.json')];
}

export function packageEvidence(executable, platform = process.platform) {
  return packageFiles(executable, platform).map(file => fs.existsSync(file)
    ? { file, bytes: fs.statSync(file).size, sha256: sha256File(file) }
    : { file, missing: true });
}

export function hostEvidence() {
  return { platform: process.platform, arch: process.arch, release: os.release(), version: os.version?.() ?? null,
    node: process.version, cpus: os.cpus()[0]?.model ?? null };
}

/**
 * Every check lands as passed, unsupported or skipped with its reason. An
 * unsupported or skipped entry is a recorded gap, never an implicit pass.
 */
export class Recorder {
  entries = [];
  constructor({ log = console.log } = {}) { this.log = log; }

  #add(status, check, details) {
    const entry = { status, check, at: new Date().toISOString(), ...(details === undefined ? {} : { details: redact(details) }) };
    this.entries.push(entry);
    this.log(`${status.toUpperCase()} ${check}${details === undefined ? '' : ` ${JSON.stringify(entry.details)}`}`);
    return entry;
  }

  pass(check, details) { return this.#add('pass', check, details); }
  unsupported(check, reason, details) { return this.#add('unsupported', check, { reason, ...details }); }
  skip(check, reason) { return this.#add('skipped', check, { reason }); }

  summary() {
    const count = status => this.entries.filter(entry => entry.status === status).length;
    return { passed: count('pass'), unsupported: count('unsupported'), skipped: count('skipped') };
  }

  report(extra) { return redact({ ...extra, summary: this.summary(), entries: this.entries }); }
}
