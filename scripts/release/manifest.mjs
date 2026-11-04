// Release manifest steps for .github/workflows/release.yml.
//   part <release-dir> <out.json>        hash this host's artifacts
//   publish <parts-dir> <out-dir>        merge, write SHA256SUMS, sign
//   check                                refuse a release build that cannot ship
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const release = require(path.join(root, 'build/release.cjs'));
const { loadPublicKeys } = require(path.join(root, 'desktop/update.cjs'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const env = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const [command, ...args] = process.argv.slice(2);
if (command === 'check') {
  const tag = env('RELEASE_TAG');
  if (tag !== `v${pkg.version}`) throw new Error(`Tag ${tag} does not match package version ${pkg.version}.`);
  const keys = loadPublicKeys(JSON.parse(fs.readFileSync(path.join(root, 'build/update-keys.json'), 'utf8')).keys);
  if (!keys.length) throw new Error('Pin the release update public key in build/update-keys.json before publishing.');
  console.log(`Release ${pkg.version} can be built with ${keys.length} pinned update key(s).`);
} else if (command === 'part') {
  const [directory, output] = args;
  const part = { version: pkg.version, revision: env('GITHUB_SHA'), components: release.componentVersions(root),
    artifacts: await release.describeArtifacts(directory, pkg.version) };
  fs.writeFileSync(output, JSON.stringify(part, null, 2) + '\n');
} else if (command === 'publish') {
  const [parts, output] = args;
  const files = fs.readdirSync(parts).filter(name => name.endsWith('.json')).sort();
  const manifest = release.mergeManifests(files.map(name => JSON.parse(fs.readFileSync(path.join(parts, name), 'utf8'))),
    { version: pkg.version, revision: env('GITHUB_SHA'), minimumVersion: process.env.RELEASE_MINIMUM_VERSION || undefined });
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'update-manifest.json'), bytes);
  fs.writeFileSync(path.join(output, 'update-manifest.json.sig'),
    release.signManifest(bytes, env('CHICORY_UPDATE_SIGNING_KEY'), env('CHICORY_UPDATE_KEY_ID')));
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), release.checksums(manifest.artifacts));
} else {
  throw new Error('Usage: manifest.mjs check | part <release-dir> <out.json> | publish <parts-dir> <out-dir>');
}
