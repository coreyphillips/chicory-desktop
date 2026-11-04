'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const full = require('./full-backup');

const FAST = { logN: 14, r: 1, p: 1 };
const PASSPHRASE = 'correct horse battery staple';
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

function payload(overrides = {}) {
  return {
    kind: full.KIND, format: full.FORMAT, createdAt: '2026-11-04T00:00:00.000Z', app: '0.2.0', engine: '0.36.1',
    wallets: [{
      id: 'w1', record: { id: 'w1', name: 'Everyday', network: 'regtest', port: 3101 },
      mnemonic: PHRASE, apiToken: 'ab'.repeat(32),
      databases: [{ name: 'regtest.db', content: Buffer.from('encrypted pages').toString('base64') }],
      files: { 'channels.scb': Buffer.from('scb').toString('base64') },
      history: { 'channel-events.jsonl': Buffer.from('{}\n').toString('base64') },
    }],
    ...overrides,
  };
}

test('an archive round-trips under its passphrase and an export key no profile holds', () => {
  const exportKey = full.createExportKey();
  const archive = full.seal(payload(), PASSPHRASE, exportKey, { kdf: FAST });
  assert.ok(archive.subarray(0, full.MAGIC.length).equals(full.MAGIC));
  assert.equal(archive.includes(Buffer.from(PHRASE)), false, 'the phrase is never readable in the file');
  assert.equal(archive.includes(exportKey), false, 'the export key is only stored wrapped');
  const opened = full.open(archive, PASSPHRASE);
  assert.deepEqual(opened.payload, payload());
  assert.ok(opened.exportKey.equals(exportKey));
  assert.equal(full.databaseKey(exportKey, 'w1', 'regtest.db'), full.databaseKey(opened.exportKey, 'w1', 'regtest.db'));
  assert.notEqual(full.databaseKey(exportKey, 'w1', 'regtest.db'), full.databaseKey(exportKey, 'w2', 'regtest.db'));
});

test('a wrong passphrase, any changed byte or a truncated file is refused without a payload', () => {
  const archive = full.seal(payload(), PASSPHRASE, full.createExportKey(), { kdf: FAST });
  assert.throws(() => full.open(archive, 'not the passphrase at all'), { code: 'BAD_PASSPHRASE' });
  for (const at of [full.MAGIC.length + 6, full.MAGIC.length + 30, full.HEADER_BYTES - 1, full.HEADER_BYTES + 3, archive.length - 1]) {
    const changed = Buffer.from(archive);
    changed[at] ^= 1;
    assert.throws(() => full.open(changed, PASSPHRASE), (error) => ['BAD_ARCHIVE', 'BAD_PASSPHRASE'].includes(error.code), `byte ${at}`);
  }
  assert.throws(() => full.open(archive.subarray(0, archive.length - 5), PASSPHRASE), { code: 'BAD_ARCHIVE' });
  assert.throws(() => full.open(archive.subarray(0, 20), PASSPHRASE), { code: 'BAD_ARCHIVE' });
  assert.throws(() => full.open(Buffer.from('BEIGNET-BACKUP and more bytes than a header needs to be long enough to read'), PASSPHRASE),
    /not a Chicory full backup/);
});

test('passphrase work outside the bounds is refused before any is done', () => {
  const archive = full.seal(payload(), PASSPHRASE, full.createExportKey(), { kdf: FAST });
  for (const [offset, value] of [[2, 30], [2, 10], [3, 64], [4, 9]]) {
    const changed = Buffer.from(archive);
    changed[full.MAGIC.length + offset] = value;
    const started = Date.now();
    assert.throws(() => full.open(changed, PASSPHRASE), /outside the supported bounds/);
    assert.ok(Date.now() - started < 1000);
  }
  const format = Buffer.from(archive); format[full.MAGIC.length] = 2;
  assert.throws(() => full.open(format, PASSPHRASE), /newer or unsupported/);
  assert.throws(() => full.seal(payload(), PASSPHRASE, full.createExportKey(), { kdf: { logN: 21, r: 8, p: 1 } }), { code: 'BAD_ARCHIVE' });
});

test('a short passphrase is refused before anything is sealed', () => {
  assert.throws(() => full.seal(payload(), 'too short', full.createExportKey(), { kdf: FAST }), { code: 'PASSPHRASE_TOO_SHORT' });
});

test('names that could leave the wallet, repeated identities and malformed contents are refused', () => {
  const variants = [
    { label: 'traversal database', change: p => { p.wallets[0].databases[0].name = '../registry.db'; } },
    { label: 'absolute database', change: p => { p.wallets[0].databases[0].name = '/etc/regtest.db'; } },
    { label: 'unexpected file', change: p => { p.wallets[0].files = { '../../storage-key.json': 'AA==' }; } },
    { label: 'unexpected history', change: p => { p.wallets[0].history = { 'registry.json': 'AA==' }; } },
    { label: 'duplicate wallet', change: p => { p.wallets.push(structuredClone(p.wallets[0])); } },
    { label: 'record mismatch', change: p => { p.wallets[0].record.id = 'w2'; } },
    { label: 'unsafe id', change: p => { p.wallets[0].id = p.wallets[0].record.id = '../w1'; } },
    { label: 'no phrase', change: p => { p.wallets[0].mnemonic = 'short'; } },
    { label: 'bad token', change: p => { p.wallets[0].apiToken = 'not hex'; } },
    { label: 'bad base64', change: p => { p.wallets[0].databases[0].content = 'not base64!'; } },
    { label: 'wrong kind', change: p => { p.kind = 'beignet-backup'; } },
    { label: 'empty', change: p => { p.wallets = []; } },
  ];
  for (const { label, change } of variants) {
    const value = payload();
    change(value);
    const archive = full.seal(value, PASSPHRASE, full.createExportKey(), { kdf: FAST });
    assert.throws(() => full.open(archive, PASSPHRASE), { code: 'BAD_ARCHIVE' }, label);
  }
  const guardian = payload();
  guardian.wallets[0].databases.push({ name: 'guardian/set-1.sqlite', content: 'AA==' });
  assert.equal(full.open(full.seal(guardian, PASSPHRASE, full.createExportKey(), { kdf: FAST }), PASSPHRASE).payload.wallets[0].databases.length, 2);
});

test('the default passphrase work is the one sealed, within the read bounds', () => {
  const archive = full.seal(payload(), PASSPHRASE, crypto.randomBytes(32));
  const header = full.readHeader(archive);
  assert.deepEqual(header.kdf, full.DEFAULT_KDF);
});
