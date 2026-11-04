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

export function applicationDirectory(executable, platform = process.platform) {
  return platform === 'darwin' ? path.resolve(path.dirname(executable), '../..') : path.dirname(executable);
}

function walk(directory, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(path.join(directory, entry.name), relative));
    else found.push(relative);
  }
  return found;
}

/**
 * One digest over every file under a path: its relative name and content
 * hash, in sorted order, with symbolic links recorded by their target. Any
 * changed, added or removed file changes it.
 */
export function treeDigest(target) {
  if (!fs.existsSync(target)) return { missing: true };
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const stat = fs.lstatSync(target);
  const entries = stat.isDirectory() ? walk(target) : [''];
  for (const relative of entries) {
    const full = relative ? path.join(target, relative) : target;
    const item = fs.lstatSync(full);
    if (item.isSymbolicLink()) hash.update(`link ${relative} ${fs.readlinkSync(full)}\n`);
    else { hash.update(`file ${relative} ${sha256File(full)}\n`); files += 1; bytes += item.size; }
  }
  return { sha256: hash.digest('hex'), files, bytes };
}

// What the qualification exercises. Everything else under resources is Electron's own.
const COMPONENTS = ['app.asar', 'dist', 'server'];

/**
 * Identifies the exact package that was qualified: a digest of the whole
 * application, and of each part that carries code under test, including the
 * bundled engine, Node runtime and Tor. Missing parts are recorded, not guessed.
 */
export function packageEvidence(executable, platform = process.platform) {
  if (!executable) return null;
  const resources = resourcesDirectory(executable, platform);
  const components = {};
  for (const name of COMPONENTS) components[name] = treeDigest(path.join(resources, name));
  const runtime = path.join(resources, 'runtime');
  if (fs.existsSync(runtime)) for (const part of fs.readdirSync(runtime).sort()) components[`runtime/${part}`] = treeDigest(path.join(runtime, part));
  else components.runtime = { missing: true };
  const application = applicationDirectory(executable, platform);
  // Paths are relative to the application, so a report kept as public
  // evidence does not carry the local account name.
  const relative = file => path.relative(application, file).split(path.sep).join('/');
  return {
    application: treeDigest(application),
    components,
    files: packageFiles(executable, platform).map(file => fs.existsSync(file)
      ? { file: relative(file), bytes: fs.statSync(file).size, sha256: sha256File(file) }
      : { file: relative(file), missing: true }),
  };
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
