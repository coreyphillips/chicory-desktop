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

test('vendored recipes are verified without contacting their upstream URL', async t => {
  const { verifiedSourceArchive } = await import('../scripts/desktop/prepare-tor.mjs');
  const { root, write } = await fixture(t);
  await fs.mkdir(path.join(root, 'build/sources'));
  const vendored = 'build/sources/recipes.tar.gz';
  await write(vendored, 'official-recipe-fixture');
  const source = { file: 'recipes.tar.gz', vendored, url: 'https://unused.invalid/blocked', sha256: digest('official-recipe-fixture') };
  assert.equal(await verifiedSourceArchive(root, path.join(root, '.runtime/downloads'), source), path.join(root, vendored));
  await write(vendored, 'changed-recipe-fixture');
  await assert.rejects(verifiedSourceArchive(root, path.join(root, '.runtime/downloads'), source), /checksum verification failed/);
});

test('vendored recipe paths must stay in the source directory', async t => {
  const { verifiedSourceArchive } = await import('../scripts/desktop/prepare-tor.mjs');
  const { root } = await fixture(t);
  await assert.rejects(verifiedSourceArchive(root, path.join(root, '.runtime/downloads'), {
    file: 'recipes.tar.gz', vendored: '../recipes.tar.gz', sha256: digest('fixture'),
  }), /outside build\/sources/);
});
