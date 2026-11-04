'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPublicKey, verify } = require('node:crypto');

const PRODUCT = 'chicory-desktop';
const MANIFEST_SCHEMA = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
// Leave room for the installer to unpack next to the staged download.
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const ARTIFACT_NAME = /^Chicory-[0-9A-Za-z.-]+\.(dmg|zip|exe|AppImage)$/;
const PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function parseVersion(value) {
  const match = typeof value === 'string' && VERSION.exec(value);
  if (!match) throw failure('UPDATE_INVALID', 'The update has an invalid version.');
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split('.') : [] };
}

/** Semantic version precedence. A prerelease sorts below its release. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function loadPublicKeys(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.publicKey !== 'string')
      throw failure('UPDATE_KEYS_INVALID', 'The pinned update key list is invalid.');
    const key = createPublicKey(entry.publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw failure('UPDATE_KEYS_INVALID', 'Update keys must be Ed25519.');
    return { id: entry.id, key };
  });
}

/**
 * Checks a signed release manifest against the running build. Returns the
 * artifact this installation should use, or throws without side effects.
 */
function verifyManifest(bytes, signature, { keys, version, platform, arch, channel }) {
  if (!keys.length) throw failure('UPDATE_DISABLED', 'This build has no pinned update key.');
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MANIFEST_BYTES) throw failure('UPDATE_INVALID', 'The update manifest is too large.');
  let envelope;
  try { envelope = JSON.parse(signature.toString('utf8')); } catch {}
  const signer = envelope && keys.find(({ id }) => id === envelope.keyId);
  if (!signer || typeof envelope.signature !== 'string' ||
      !verify(null, bytes, signer.key, Buffer.from(envelope.signature, 'base64')))
    throw failure('UPDATE_SIGNATURE', 'The update signature is not valid for this build.');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || manifest.product !== PRODUCT || !Array.isArray(manifest.artifacts))
    throw failure('UPDATE_INVALID', 'The update manifest is not a Chicory Desktop release.');
  if (manifest.channel !== channel) throw failure('UPDATE_CHANNEL', 'The update belongs to a different release channel.');
  if (compareVersions(manifest.version, version) <= 0) throw failure('UPDATE_DOWNGRADE', 'The offered release is not newer than this build.');
  if (manifest.minimumVersion !== undefined) parseVersion(manifest.minimumVersion);
  const artifact = manifest.artifacts.find(entry => entry?.platform === platform && entry.arch === arch && entry.installer === true);
  if (!PLATFORMS.has(`${platform}-${arch}`) || !artifact) throw failure('UPDATE_PLATFORM', 'The update has no installer for this platform.');
  if (typeof artifact.file !== 'string' || !ARTIFACT_NAME.test(artifact.file) || path.basename(artifact.file) !== artifact.file ||
      !artifact.file.includes(`-${manifest.version}-`) || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES)
    throw failure('UPDATE_INVALID', 'The update artifact entry is invalid.');
  return { manifest, artifact, signer: signer.id,
    required: manifest.minimumVersion !== undefined && compareVersions(version, manifest.minimumVersion) < 0 };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}

/** Re-checks a staged installer immediately before it is opened. */
async function verifyStaged(file, artifact) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('UPDATE_TAMPERED', 'The staged update is not a regular file.');
  const actual = await hashFile(file);
  if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256)
    throw failure('UPDATE_TAMPERED', 'The staged update does not match its signed checksum.');
  return file;
}

/** Removes interrupted downloads and installers that no longer match a manifest. */
function cleanStaging(directory, keep) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const removed = [];
  for (const entry of entries) {
    if (keep && entry.name === keep) continue;
    fs.rmSync(path.join(directory, entry.name), { force: true, recursive: entry.isDirectory() && !entry.isSymbolicLink() });
    removed.push(entry.name);
  }
  return removed;
}

function freeBytes(directory, statfs) {
  const stat = statfs(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

/**
 * Streams an artifact into the staging directory. The final name appears only
 * after its size and SHA256 match the signed manifest, so a cancelled, failed
 * or disk-full download leaves nothing that could be installed.
 */
async function download({ body, artifact, directory, signal, statfs = fs.statfsSync, onProgress }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  cleanStaging(directory);
  if (freeBytes(directory, statfs) < artifact.size + FREE_SPACE_MARGIN)
    throw failure('UPDATE_NO_SPACE', 'There is not enough free disk space to download the update.');
  const final = path.join(directory, artifact.file);
  const partial = `${final}.partial`;
  const hash = createHash('sha256');
  let written = 0;
  let descriptor = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    for await (const chunk of body) {
      if (signal?.aborted) throw failure('UPDATE_CANCELLED', 'The update download was cancelled.');
      const bytes = Buffer.from(chunk);
      written += bytes.length;
      if (written > artifact.size) throw failure('UPDATE_TAMPERED', 'The update download is larger than its signed size.');
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(descriptor, bytes, offset);
      onProgress?.(written / artifact.size);
    }
    if (signal?.aborted) throw failure('UPDATE_CANCELLED', 'The update download was cancelled.');
    if (written !== artifact.size || hash.digest('hex') !== artifact.sha256)
      throw failure('UPDATE_TAMPERED', 'The downloaded update does not match its signed checksum.');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(partial, final);
    return final;
  } catch (error) {
    if (error.code === 'ENOSPC') error = failure('UPDATE_NO_SPACE', 'The disk filled while downloading the update. Nothing was installed.');
    else if (signal?.aborted || error.name === 'AbortError') error = failure('UPDATE_CANCELLED', 'The update download was cancelled.');
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(partial, { force: true });
  }
}

/**
 * Serializes work that must not overlap an update: opening or re-wrapping
 * the OS-protected storage key, and handing off to an installer.
 */
class UpdateGate {
  constructor() { this.active = null; this.waiters = []; }

  async run(kind, task) {
    while (this.active) await new Promise(resolve => this.waiters.push(resolve));
    this.active = kind;
    try { return await task(); }
    finally {
      this.active = null;
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }

  /** Updates never wait behind other work; they refuse and let the owner retry. */
  tryRun(kind, task) {
    if (this.active) return Promise.reject(failure('UPDATE_BUSY', 'Chicory is busy protecting wallet storage. Try the update again shortly.'));
    return this.run(kind, task);
  }
}

module.exports = { PRODUCT, MANIFEST_SCHEMA, MAX_MANIFEST_BYTES, compareVersions, loadPublicKeys, verifyManifest,
  verifyStaged, cleanStaging, download, hashFile, UpdateGate };
