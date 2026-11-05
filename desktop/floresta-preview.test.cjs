'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
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
