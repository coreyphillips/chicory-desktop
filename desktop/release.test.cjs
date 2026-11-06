'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const release = require('../build/release.cjs');

const root = path.resolve(__dirname, '..');
const revision = 'b'.repeat(40);

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('release artifacts are hashed and development-labelled files are refused', async (t) => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'Chicory-0.3.0-mac-arm64.dmg'), 'dmg');
  fs.writeFileSync(path.join(directory, 'Chicory-0.3.0-mac-arm64.zip'), 'zip');
  fs.writeFileSync(path.join(directory, 'builder-debug.yml'), 'ignored');
  const artifacts = await release.describeArtifacts(directory, '0.3.0');
  assert.deepEqual(artifacts.map(({ file, installer }) => [file, installer]),
    [['Chicory-0.3.0-mac-arm64.dmg', true], ['Chicory-0.3.0-mac-arm64.zip', false]]);
  assert.equal(artifacts[0].sha256, createHash('sha256').update('dmg').digest('hex'));
  assert.equal(release.checksums(artifacts), `${artifacts[0].sha256}  Chicory-0.3.0-mac-arm64.dmg\n${artifacts[1].sha256}  Chicory-0.3.0-mac-arm64.zip\n`);
  fs.writeFileSync(path.join(directory, 'Chicory-0.3.0-development-mac-arm64.dmg'), 'dev');
  await assert.rejects(release.describeArtifacts(directory, '0.3.0'), /release version/);
});

test('Linux and Windows artifacts are described with the names electron-builder gives them', async (t) => {
  const directory = temporary(t);
  // electron-builder spells an x64 AppImage 'x86_64'; the manifest uses Node's 'x64'.
  fs.writeFileSync(path.join(directory, 'Chicory-0.3.0-linux-x86_64.AppImage'), 'appimage');
  fs.writeFileSync(path.join(directory, 'Chicory-0.3.0-win-x64.exe'), 'exe');
  const artifacts = await release.describeArtifacts(directory, '0.3.0');
  assert.deepEqual(artifacts.map(({ platform, arch, file, installer }) => [platform, arch, file, installer]), [
    ['linux', 'x64', 'Chicory-0.3.0-linux-x86_64.AppImage', true],
    ['win32', 'x64', 'Chicory-0.3.0-win-x64.exe', true],
  ]);
});

test('merged manifests record revision, components and storage formats', () => {
  const part = { version: '0.3.0', revision, components: { tor: '0.4.9.15' }, artifacts: [{ file: 'Chicory-0.3.0-win-x64.exe' }] };
  const manifest = release.mergeManifests([part, { ...part, artifacts: [{ file: 'Chicory-0.3.0-linux-x64.AppImage' }] }], { version: '0.3.0', revision });
  assert.equal(manifest.revision, revision);
  assert.equal(manifest.channel, 'stable');
  assert.deepEqual(manifest.components, { tor: '0.4.9.15' });
  assert.deepEqual(manifest.storageFormats, release.STORAGE_FORMATS);
  assert.deepEqual(manifest.artifacts.map(a => a.file), ['Chicory-0.3.0-linux-x64.AppImage', 'Chicory-0.3.0-win-x64.exe']);
});

test('platform builds from different sources or components cannot be merged', () => {
  const part = { version: '0.3.0', revision, components: { tor: '0.4.9.15' }, artifacts: [{ file: 'a' }] };
  assert.throws(() => release.mergeManifests([part, { ...part, revision: 'c'.repeat(40), artifacts: [{ file: 'b' }] }], { version: '0.3.0', revision }), /different version/);
  assert.throws(() => release.mergeManifests([part, { ...part, components: { tor: '0.4.8.0' }, artifacts: [{ file: 'b' }] }], { version: '0.3.0', revision }), /component/);
  assert.throws(() => release.mergeManifests([part, part], { version: '0.3.0', revision }), /Duplicate/);
  assert.throws(() => release.mergeManifests([part], { version: '0.3.0', revision: 'HEAD' }), /revision/);
  assert.throws(() => release.mergeManifests([part], { version: '0.3.0', revision, minimumVersion: '0.4.0' }), /minimum/);
});

test('storage formats match what this build writes', () => {
  const { MAGIC, VAULT_FORMAT } = require('../server/vault-files');
  const { ENVELOPE_VERSION } = require('./storage-key.cjs');
  assert.equal(MAGIC.toString(), release.STORAGE_FORMATS.vault);
  assert.equal(VAULT_FORMAT, release.STORAGE_FORMATS.vaultLayout);
  assert.equal(ENVELOPE_VERSION, release.STORAGE_FORMATS.keyEnvelope);
});

test('a local macOS release needs a certificate file and a notary login', () => {
  const certificate = { CSC_LINK: 'developer-id.p12', CSC_KEY_PASSWORD: 'password' };
  const apiKey = { APPLE_API_KEY: 'key.p8', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer' };
  assert.deepEqual(release.missingMacCredentials({ ...certificate, APPLE_KEYCHAIN_PROFILE: 'chicory-notary' }), []);
  assert.deepEqual(release.missingMacCredentials({ ...certificate, ...apiKey }), []);
  assert.deepEqual(release.missingMacCredentials({ ...apiKey }), ['CSC_LINK', 'CSC_KEY_PASSWORD']);
  // electron-builder would otherwise skip notarization and still succeed.
  assert.match(release.missingMacCredentials(certificate).join(), /APPLE_KEYCHAIN_PROFILE/);
  assert.match(release.missingMacCredentials({ ...certificate, APPLE_API_KEY: 'key.p8' }).join(), /APPLE_API_ISSUER/);
});

test('a macOS release signs by the hash of the certificate from CSC_LINK', async (t) => {
  const config = fs.readFileSync(path.join(root, 'build/electron-builder.release.yml'), 'utf8');
  assert.match(config, /^  sign: build\/sign-mac\.cjs$/m);

  const codeSign = require('app-builder-lib/out/codeSign/macCodeSign');
  const signByHash = require('../build/sign-mac.cjs');
  const found = t.mock.method(codeSign, 'findIdentity', async () => ({ name: 'a shared name', hash: 'AB12' }));
  const signed = t.mock.method(codeSign, 'sign', async () => {});

  await signByHash({ app: 'Chicory.app', keychain: 'csc-link.keychain' });
  assert.equal(found.mock.calls[0].arguments[2], 'csc-link.keychain');
  assert.deepEqual(signed.mock.calls[0].arguments[0], { app: 'Chicory.app', keychain: 'csc-link.keychain', identity: 'AB12' });

  // Without CSC_LINK the login keychain would pick a certificate.
  await assert.rejects(signByHash({ app: 'Chicory.app' }), /CSC_LINK/);
  found.mock.mockImplementation(async () => null);
  await assert.rejects(signByHash({ app: 'Chicory.app', keychain: 'empty.keychain' }), /CSC_LINK/);
  assert.equal(signed.mock.callCount(), 1);
});

test('development packages are labelled and only the release config can drop the label', () => {
  const development = fs.readFileSync(path.join(root, 'build/electron-builder.yml'), 'utf8');
  const signed = fs.readFileSync(path.join(root, 'build/electron-builder.release.yml'), 'utf8');
  assert.match(development, /^artifactName: Chicory-\$\{version\}-development-/m);
  assert.match(development, /chicoryChannel: development/);
  assert.match(development, /identity: '-'/);
  assert.match(signed, /^extends: build\/electron-builder\.yml$/m);
  assert.match(signed, /chicoryChannel: stable/);
  assert.match(signed, /forceCodeSigning: true/);
  assert.match(signed, /notarize: true/);
  // Public keys only. A private key in source control would let anyone sign updates.
  const pinned = fs.readFileSync(path.join(root, 'build/update-keys.json'), 'utf8');
  assert.doesNotMatch(pinned, /PRIVATE KEY/);
});
