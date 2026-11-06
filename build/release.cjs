'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, sign } = require('node:crypto');
const { PRODUCT, MANIFEST_SCHEMA, compareVersions, hashFile } = require('../desktop/update.cjs');

// electron-builder names an x64 AppImage 'x86_64'. Manifests use Node's arch names.
const ARTIFACT = /^Chicory-(.+)-(mac|win|linux)-(arm64|x64|x86_64)\.(dmg|zip|exe|AppImage)$/;
const PLATFORM = { mac: 'darwin', win: 'win32', linux: 'linux' };
const ARCH = { arm64: 'arm64', x64: 'x64', x86_64: 'x64' };
// The format an installed build reads at startup. Bump the matching entry
// whenever a release changes what it writes, so owners see it before updating.
const STORAGE_FORMATS = Object.freeze({ keyEnvelope: 1, vault: 'CHICORYVAULT1', vaultLayout: 1, database: 'sqlcipher-aes256' });

function componentVersions(root) {
  const runtime = JSON.parse(fs.readFileSync(path.join(root, '.runtime/manifest.json'), 'utf8'));
  const tor = JSON.parse(fs.readFileSync(path.join(root, 'build/tor-manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { electron: pkg.devDependencies.electron, node: runtime.node, engine: runtime.engine,
    encryptedStorageDriver: runtime.encryptedStorage, tor: tor.torVersion, torBrowserBuild: tor.bundleVersion };
}

/** Hashes this host's packaged artifacts. Release builds must not carry a development label. */
async function describeArtifacts(directory, version) {
  const artifacts = [];
  for (const file of fs.readdirSync(directory).sort()) {
    const match = ARTIFACT.exec(file);
    if (!match) continue;
    if (match[1] !== version) throw new Error(`Artifact ${file} does not carry release version ${version}.`);
    const { sha256, size } = await hashFile(path.join(directory, file));
    artifacts.push({ platform: PLATFORM[match[2]], arch: ARCH[match[3]], file, sha256, size, installer: match[4] !== 'zip' });
  }
  if (!artifacts.length) throw new Error('No release artifacts were found.');
  return artifacts;
}

function mergeManifests(parts, { version, revision, channel = 'stable', minimumVersion, released = new Date().toISOString() }) {
  compareVersions(version, version);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A full source revision is required.');
  if (minimumVersion && compareVersions(minimumVersion, version) > 0) throw new Error('The minimum version cannot be newer than the release.');
  const components = parts[0]?.components;
  const artifacts = [];
  for (const part of parts) {
    if (part.version !== version || part.revision !== revision) throw new Error('A platform build came from a different version or revision.');
    if (JSON.stringify(part.components) !== JSON.stringify(components)) throw new Error('Platform builds bundled different component versions.');
    artifacts.push(...part.artifacts);
  }
  const seen = new Set();
  for (const { file } of artifacts) {
    if (seen.has(file)) throw new Error(`Duplicate artifact ${file}.`);
    seen.add(file);
  }
  return { schema: MANIFEST_SCHEMA, product: PRODUCT, channel, version, revision, released,
    ...(minimumVersion ? { minimumVersion } : {}), components, storageFormats: STORAGE_FORMATS,
    artifacts: artifacts.sort((a, b) => a.file.localeCompare(b.file)) };
}

function checksums(artifacts) {
  return artifacts.map(({ sha256, file }) => `${sha256}  ${file}\n`).join('');
}

/** The signature covers the exact manifest bytes that clients download. */
function signManifest(bytes, privateKeyPem, keyId) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The update signing key must be Ed25519.');
  return Buffer.from(JSON.stringify({ keyId, algorithm: 'ed25519', signature: sign(null, bytes, key).toString('base64') }) + '\n');
}

/**
 * electron-builder skips notarization with only a warning when it finds no
 * credentials, so a local build needs an explicit notary login. It also needs
 * the certificate as a file, which build/sign-mac.cjs signs with, so that the
 * login keychain cannot decide which certificate signs a release.
 */
function missingMacCredentials(env) {
  const missing = ['CSC_LINK', 'CSC_KEY_PASSWORD'].filter(name => !env[name]);
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  if (!env.APPLE_KEYCHAIN_PROFILE && !apiKey.every(name => env[name])) {
    missing.push(`APPLE_KEYCHAIN_PROFILE or all of ${apiKey.join(', ')}`);
  }
  return missing;
}

module.exports = { STORAGE_FORMATS, componentVersions, describeArtifacts, mergeManifests, checksums, signManifest, missingMacCredentials };
