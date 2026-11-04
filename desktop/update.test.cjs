'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { Readable } = require('node:stream');
const update = require('./update.cjs');
const release = require('../build/release.cjs');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const keys = update.loadPublicKeys([{ id: 'release-2026', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }]);
const installer = Buffer.from('signed installer bytes '.repeat(4096));
const digest = createHash('sha256').update(installer).digest('hex');
const current = { keys, version: '0.2.0', platform: 'darwin', arch: 'arm64', channel: 'stable' };
const ample = () => ({ bavail: 1e12, bsize: 1 });

function manifest(overrides = {}) {
  return release.mergeManifests([{ version: '0.3.0', revision: 'a'.repeat(40), components: { tor: '0.4.9.15', engine: '0.36.1' },
    artifacts: [
      { platform: 'darwin', arch: 'arm64', file: 'Chicory-0.3.0-mac-arm64.dmg', sha256: digest, size: installer.length, installer: true },
      { platform: 'darwin', arch: 'arm64', file: 'Chicory-0.3.0-mac-arm64.zip', sha256: digest, size: installer.length, installer: false },
      { platform: 'win32', arch: 'x64', file: 'Chicory-0.3.0-win-x64.exe', sha256: digest, size: installer.length, installer: true },
    ] }], { version: '0.3.0', revision: 'a'.repeat(40), released: '2026-11-04T00:00:00.000Z', ...overrides });
}

function signed(value = manifest(), key = privateKey, keyId = 'release-2026') {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, signature: release.signManifest(bytes, key.export({ type: 'pkcs8', format: 'pem' }), keyId) };
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function chunks(bytes, size = 8192) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
  return parts;
}

test('version precedence follows semantic versioning', () => {
  assert.equal(update.compareVersions('0.3.0', '0.2.9'), 1);
  assert.equal(update.compareVersions('0.3.0-rc.1', '0.3.0'), -1);
  assert.equal(update.compareVersions('0.3.0-rc.10', '0.3.0-rc.2'), 1);
  assert.equal(update.compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => update.compareVersions('v1.0', '1.0.0'), { code: 'UPDATE_INVALID' });
});

test('upgrade from the previous release selects the signed installer for this platform', () => {
  const { bytes, signature } = signed();
  const offer = update.verifyManifest(bytes, signature, current);
  assert.equal(offer.artifact.file, 'Chicory-0.3.0-mac-arm64.dmg');
  assert.equal(offer.signer, 'release-2026');
  assert.equal(offer.required, false);
  assert.equal(offer.manifest.storageFormats.keyEnvelope, 1);
});

test('a build below the minimum supported version is told the update is required', () => {
  const { bytes, signature } = signed(manifest({ minimumVersion: '0.2.1' }));
  assert.equal(update.verifyManifest(bytes, signature, current).required, true);
});

test('tampered manifests and unknown signers are rejected', () => {
  const { bytes, signature } = signed();
  const tampered = Buffer.from(bytes.toString().replace(digest, 'f'.repeat(64)));
  assert.throws(() => update.verifyManifest(tampered, signature, current), { code: 'UPDATE_SIGNATURE' });
  const forged = signed(manifest(), other.privateKey);
  assert.throws(() => update.verifyManifest(forged.bytes, forged.signature, current), { code: 'UPDATE_SIGNATURE' });
  const renamed = signed(manifest(), other.privateKey, 'unknown');
  assert.throws(() => update.verifyManifest(renamed.bytes, renamed.signature, current), { code: 'UPDATE_SIGNATURE' });
  assert.throws(() => update.verifyManifest(bytes, Buffer.from('not json'), current), { code: 'UPDATE_SIGNATURE' });
});

test('development builds without a pinned key never accept an update', () => {
  const { bytes, signature } = signed();
  assert.throws(() => update.verifyManifest(bytes, signature, { ...current, keys: [] }), { code: 'UPDATE_DISABLED' });
});

test('downgrades, reinstalls and other channels are rejected', () => {
  const { bytes, signature } = signed();
  assert.throws(() => update.verifyManifest(bytes, signature, { ...current, version: '0.3.0' }), { code: 'UPDATE_DOWNGRADE' });
  assert.throws(() => update.verifyManifest(bytes, signature, { ...current, version: '0.4.0' }), { code: 'UPDATE_DOWNGRADE' });
  assert.throws(() => update.verifyManifest(bytes, signature, { ...current, channel: 'development' }), { code: 'UPDATE_CHANNEL' });
});

test('a release without an installer for this platform is rejected', () => {
  const { bytes, signature } = signed();
  assert.throws(() => update.verifyManifest(bytes, signature, { ...current, platform: 'linux', arch: 'x64' }), { code: 'UPDATE_PLATFORM' });
  assert.throws(() => update.verifyManifest(bytes, signature, { ...current, arch: 'x64' }), { code: 'UPDATE_PLATFORM' });
});

test('signed entries cannot point outside the staging directory or at another version', () => {
  for (const file of ['../Chicory-0.3.0-mac-arm64.dmg', 'Chicory-0.2.0-mac-arm64.dmg', 'Chicory-0.3.0-mac-arm64.pkg']) {
    const value = manifest();
    value.artifacts[0].file = file;
    const { bytes, signature } = signed(value);
    assert.throws(() => update.verifyManifest(bytes, signature, current), { code: /UPDATE_(INVALID|PLATFORM)/ });
  }
});

test('fresh install has no staging directory and downloads a verified installer', async (t) => {
  const directory = path.join(temporary(t), 'updates');
  const { artifact } = update.verifyManifest(...Object.values(signed()), current);
  const progress = [];
  const file = await update.download({ body: Readable.from(chunks(installer)), artifact, directory, statfs: ample, onProgress: v => progress.push(v) });
  assert.equal(path.basename(file), artifact.file);
  assert.deepEqual(fs.readdirSync(directory), [artifact.file]);
  assert.equal(progress.at(-1), 1);
  assert.equal(await update.verifyStaged(file, artifact), file);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('tampered or oversized downloads leave nothing installable', async (t) => {
  const directory = temporary(t);
  const { artifact } = update.verifyManifest(...Object.values(signed()), current);
  const flipped = Buffer.from(installer); flipped[100] ^= 1;
  await assert.rejects(update.download({ body: Readable.from(chunks(flipped)), artifact, directory, statfs: ample }), { code: 'UPDATE_TAMPERED' });
  await assert.rejects(update.download({ body: Readable.from(chunks(Buffer.concat([installer, Buffer.from('x')]))), artifact, directory, statfs: ample }), { code: 'UPDATE_TAMPERED' });
  await assert.rejects(update.download({ body: Readable.from(chunks(installer.subarray(1))), artifact, directory, statfs: ample }), { code: 'UPDATE_TAMPERED' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a staged installer changed after download is refused before it is opened', async (t) => {
  const directory = temporary(t);
  const { artifact } = update.verifyManifest(...Object.values(signed()), current);
  const file = await update.download({ body: Readable.from(chunks(installer)), artifact, directory, statfs: ample });
  fs.appendFileSync(file, 'x');
  await assert.rejects(update.verifyStaged(file, artifact), { code: 'UPDATE_TAMPERED' });
});

test('a cancelled download removes its partial file', async (t) => {
  const directory = temporary(t);
  const { artifact } = update.verifyManifest(...Object.values(signed()), current);
  const controller = new AbortController();
  async function* body() {
    yield installer.subarray(0, 1000);
    controller.abort();
    yield installer.subarray(1000, 2000);
  }
  await assert.rejects(update.download({ body: body(), artifact, directory, signal: controller.signal, statfs: ample }), { code: 'UPDATE_CANCELLED' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('low disk space is refused before writing and a disk-full write is cleaned up', async (t) => {
  const directory = temporary(t);
  const { artifact } = update.verifyManifest(...Object.values(signed()), current);
  await assert.rejects(update.download({ body: Readable.from([installer]), artifact, directory, statfs: () => ({ bavail: 10, bsize: 4096 }) }), { code: 'UPDATE_NO_SPACE' });
  assert.deepEqual(fs.readdirSync(directory), []);
  async function* full() {
    yield installer.subarray(0, 4096);
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
  }
  await assert.rejects(update.download({ body: full(), artifact, directory, statfs: ample }), { code: 'UPDATE_NO_SPACE' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('recovery after an interruption keeps wallet data and retries to the known release', async (t) => {
  const profile = temporary(t);
  const directory = path.join(profile, 'updates');
  fs.mkdirSync(path.join(profile, 'wallets'));
  fs.writeFileSync(path.join(profile, 'storage-key.json'), 'protected');
  fs.writeFileSync(path.join(profile, 'wallets', 'vault'), 'encrypted');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'Chicory-0.3.0-mac-arm64.dmg.partial'), 'half');
  fs.writeFileSync(path.join(directory, 'Chicory-0.2.5-mac-arm64.dmg'), 'stale');
  assert.deepEqual(update.cleanStaging(directory).sort(), ['Chicory-0.2.5-mac-arm64.dmg', 'Chicory-0.3.0-mac-arm64.dmg.partial']);
  const { artifact } = update.verifyManifest(...Object.values(signed()), current);
  const file = await update.download({ body: Readable.from(chunks(installer)), artifact, directory, statfs: ample });
  await update.verifyStaged(file, artifact);
  assert.equal(fs.readFileSync(path.join(profile, 'storage-key.json'), 'utf8'), 'protected');
  assert.equal(fs.readFileSync(path.join(profile, 'wallets', 'vault'), 'utf8'), 'encrypted');
  assert.deepEqual(update.cleanStaging(path.join(profile, 'missing')), []);
});

test('an update cannot start while the storage key is being opened or re-wrapped', async () => {
  const gate = new update.UpdateGate();
  let finish;
  const rotation = gate.run('storage-key', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(gate.tryRun('update', async () => 'installed'), { code: 'UPDATE_BUSY' });
  finish('opened');
  assert.equal(await rotation, 'opened');
  assert.equal(await gate.tryRun('update', async () => 'installed'), 'installed');
});

test('key rotation waits for an update handoff that already began', async () => {
  const gate = new update.UpdateGate();
  const order = [];
  let finish;
  const handoff = gate.tryRun('update', () => new Promise(resolve => { finish = resolve; }).then(() => order.push('update')));
  const rotation = gate.run('storage-key', async () => order.push('storage-key'));
  await new Promise(setImmediate);
  assert.deepEqual(order, []);
  finish();
  await Promise.all([handoff, rotation]);
  assert.deepEqual(order, ['update', 'storage-key']);
});

test('loadPublicKeys accepts only Ed25519 keys', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => update.loadPublicKeys([{ id: 'rsa', publicKey: rsa }]), { code: 'UPDATE_KEYS_INVALID' });
  assert.deepEqual(update.loadPublicKeys(undefined), []);
});
