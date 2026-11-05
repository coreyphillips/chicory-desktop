'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const asar = require('@electron/asar');
const verifyPackage = require('../build/verify-package.cjs');
const { previewCandidate } = require('./floresta-preview.cjs');

test('only the matching packaged preview metadata selects its fixed signed binary', () => {
  const pin = { version: 1, platform: 'darwin', arch: 'arm64', sha256: 'a'.repeat(64), sourceBinarySha256: 'b'.repeat(64) };
  const metadata = { chicoryChannel: 'floresta-preview', chicoryFlorestaPreview: pin };
  const read = value => previewCandidate(value, '/resources', 'darwin', 'arm64');
  assert.deepEqual(read(metadata), { binary: path.join('/resources', 'runtime', 'floresta', 'florestad'), sha256: pin.sha256 });
  for (const chicoryChannel of ['stable', 'development', undefined]) assert.equal(read({ ...metadata, chicoryChannel }), null);
  for (const invalid of [{ sha256: undefined }, { sha256: [pin.sha256] }, { sha256: pin.sha256 + 'a' }, { arch: 'x64' }, { version: 0 }, { platform: 'linux' }]) {
    assert.equal(read({ ...metadata, chicoryFlorestaPreview: { ...pin, ...invalid } }), null);
  }
  assert.equal(read({ ...metadata, chicoryFlorestaPreview: null }), null);
});

test('package verification refuses a monitor in the normal release resources', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-preview-package-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'metadata');
  const resources = path.join(directory, 'resources');
  await fs.mkdir(source);
  await fs.mkdir(path.join(resources, 'runtime', 'floresta'), { recursive: true });
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ chicoryChannel: 'stable' }));
  await asar.createPackage(source, path.join(resources, 'app.asar'));
  await assert.rejects(verifyPackage({ appOutDir: directory, electronPlatformName: 'linux' }), /dedicated development package/);
});

test('Linux and Windows x64 previews resolve only their unmodified host executable', () => {
  for (const [platform, filename] of [['linux', 'florestad'], ['win32', 'florestad.exe']]) {
    const sha256 = '1'.repeat(64);
    const pin = { version: 1, platform, arch: 'x64', sha256, sourceBinarySha256: sha256 };
    const metadata = { chicoryChannel: 'floresta-preview', chicoryFlorestaPreview: pin };
    assert.deepEqual(previewCandidate(metadata, '/resources', platform, 'x64'),
      { binary: path.join('/resources', 'runtime', 'floresta', filename), sha256 });
    for (const [host, arch] of [[platform, 'arm64'], ['darwin', 'x64'], ['freebsd', 'x64']]) {
      assert.equal(previewCandidate(metadata, '/resources', host, arch), null);
      if (host !== 'darwin') assert.equal(previewCandidate({ ...metadata, chicoryFlorestaPreview: { ...pin, platform: host, arch } }, '/resources', host, arch), null);
    }
    assert.equal(previewCandidate({ ...metadata, chicoryFlorestaPreview: { ...pin, sha256: '2'.repeat(64) } }, '/resources', platform, 'x64'), null);
  }
});
