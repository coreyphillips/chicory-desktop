'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chicory-tor-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'build'));
  await fs.mkdir(path.join(root, '.runtime/downloads'), { recursive: true });
  const write = (file, data) => fs.writeFile(path.join(root, file), data);
  const manifest = { torVersion: 'fixture', baseUrl: 'https://unused.invalid/',
    source: { url: 'https://unused.invalid/source', sha256: digest('correct-source') },
    platforms: { [`${process.platform}-${process.arch}`]: { file: 'bundle.tar.gz', sha256: digest('correct-bundle') } } };
  return { root, write, manifest };
}

test('a corrupted cached Tor archive is rejected before extraction or execution', async t => {
  const { prepareTor } = await import('../scripts/desktop/prepare-tor.mjs');
  const { root, write, manifest } = await fixture(t);
  await write('build/tor-manifest.json', JSON.stringify(manifest));
  await write('.runtime/downloads/bundle.tar.gz', 'changed-bundle');
  await assert.rejects(prepareTor(root), /checksum verification failed for bundle/);
  await assert.rejects(fs.access(path.join(root, '.runtime/tor')), { code: 'ENOENT' });
});

test('a corrupted source archive also prevents Tor from being packaged', async t => {
  const { prepareTor } = await import('../scripts/desktop/prepare-tor.mjs');
  const { root, write, manifest } = await fixture(t);
  await write('build/tor-manifest.json', JSON.stringify(manifest));
  await write('.runtime/downloads/bundle.tar.gz', 'correct-bundle');
  await write('.runtime/downloads/tor-fixture.tar.gz', 'changed-source');
  await assert.rejects(prepareTor(root), /checksum verification failed for tor-fixture/);
});

test('an unsupported target cannot substitute a system Tor installation', async t => {
  const { prepareTor } = await import('../scripts/desktop/prepare-tor.mjs');
  const { root, write, manifest } = await fixture(t);
  manifest.platforms = {};
  await write('build/tor-manifest.json', JSON.stringify(manifest));
  await assert.rejects(prepareTor(root), /No reviewed Tor Expert Bundle/);
});
