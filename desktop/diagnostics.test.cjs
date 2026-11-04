'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DesktopDiagnostics, redactText, redactValue, measured, stopChild, desktopResources,
  EVENT_LIMIT, OUTCOME_LIMIT, OUTPUT_LIMIT } = require('./diagnostics.cjs');
const { loadStorageKey } = require('./storage-key.cjs');

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
const KEY = 'a'.repeat(64);

function clock(start = Date.parse('2026-01-01T00:00:00Z')) {
  let current = start;
  const read = () => current;
  read.advance = ms => { current += ms; };
  return read;
}

function profile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chicory-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function diagnosticsFor(t, options = {}) {
  const directory = profile(t);
  const file = path.join(directory, 'diagnostics.json');
  const time = clock();
  const diagnostics = new DesktopDiagnostics({ file, clock: time, paths: [[directory, '<profile>']],
    versions: { app: '0.2.0', tor: '0.4.9.15', storageEnvelope: 1 }, ...options });
  return { diagnostics, file, time, directory };
}

const saved = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('redacts secrets, identifiers and private paths from text', () => {
  const text = redactText([
    `phrase ${PHRASE}`, `key=${KEY}`, 'token: "abc123"', 'Bearer abc.def', 'http://user:pass@127.0.0.1:3000/x',
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', `${'b'.repeat(56)}.onion:50001`,
    '/Users/alice/Library/Chicory', 'C:\\Users\\alice\\AppData',
  ].join(' | '), { limit: 2000 });
  for (const secret of ['abandon ability', KEY, 'abc123', 'abc.def', 'user:pass', 'lnbc2500', 'bc1qar0', 'bbbbbbbb', 'alice'])
    assert.equal(text.includes(secret), false, secret);
  assert.match(text, /\[redacted words\]/);
  assert.equal(redactText(PHRASE.replaceAll(' ', '\n')), '[redacted words]');
  assert.equal(redactText(`mnemonic: ${PHRASE}`), 'mnemonic: [redacted words]');
  assert.match(text, /<home>/);
  assert.equal(redactText('x'.repeat(5000)).length <= 300, true);
});

test('drops sensitive fields and payment identifiers from structured reports', () => {
  const value = redactValue({ primaryTransport: 'iroh-direct', primaryRttMs: 41,
    wallet: { primaryUri: 'pk@host:9735', primaryPubkey: '02'.padEnd(66, 'c') },
    channels: [{ channelId: 'c'.repeat(64), fundingTxid: 'd'.repeat(64), capacitySats: 1000 }],
    nested: { apiToken: 'secret', message: `seed ${PHRASE}` } });
  assert.equal(value.primaryTransport, 'iroh-direct');
  assert.equal(value.wallet.primaryUri, '[redacted]');
  assert.equal(value.wallet.primaryPubkey, '[redacted]');
  assert.equal(value.channels[0].channelId, '[redacted]');
  assert.equal(value.channels[0].fundingTxid, '[redacted]');
  assert.equal(value.channels[0].capacitySats, 1000);
  assert.equal(value.nested.apiToken, '[redacted]');
  assert.equal(JSON.stringify(value).includes('abandon'), false);
});

test('distinguishes unsupported, unavailable, stale and current measurements', () => {
  assert.deepEqual(measured(undefined, 0), { state: 'unsupported', value: null });
  assert.deepEqual(measured(null, 0), { state: 'unavailable', value: null });
  assert.equal(measured(0, 1000, { current: 1000 }).state, 'current');
  assert.equal(measured(0, 1000, { current: 1000 }).value, 0);
  assert.equal(measured(5, 1000, { current: 2000, since: 1500 }).state, 'stale');
  assert.equal(measured(5, 1000, { current: 1000 + 10 * 60000 }).state, 'stale');
});

test('reports a Tor bootstrap failure with progress and keeps it for the next launch', t => {
  const { diagnostics, file } = diagnosticsFor(t);
  diagnostics.torStatus({ phase: 'starting', progress: 0, error: null });
  diagnostics.torStatus({ phase: 'starting', progress: 45, error: null });
  diagnostics.torStatus({ phase: 'failed', progress: 45, error: 'Tor could not connect within two minutes.' });
  const report = diagnostics.report();
  assert.equal(report.tor.phase, 'failed');
  assert.deepEqual([report.tor.progress.state, report.tor.progress.value], ['current', 45]);
  assert.equal(report.lifecycle.tor.code, 'TOR_UNAVAILABLE');
  // Progress steps are not events; phase changes are.
  assert.deepEqual(report.events.map(event => event.message.split(':')[0]), ['starting', 'failed']);
  assert.equal(saved(file).lifecycle.tor.state, 'failed');
});

for (const [name, setup, code] of [
  ['missing', directory => {
    fs.mkdirSync(path.join(directory, 'wallets', 'one'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'wallets', 'one', 'wallet.db'), 'x');
  }, 'STORAGE_KEY_MISSING'],
  ['wrong', directory => fs.writeFileSync(path.join(directory, 'storage-key.json'),
    JSON.stringify({ version: 1, provider: 'electron.safeStorage', ciphertext: Buffer.from('other').toString('base64') })), 'STORAGE_KEY_UNAVAILABLE'],
]) {
  test(`preserves a ${name} encryption key failure before any wallet opens`, async t => {
    const { diagnostics, file, directory } = diagnosticsFor(t);
    setup(directory);
    const safeStorage = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async () => Buffer.from('x'),
      decryptStringAsync: async () => { throw new Error(`cannot open ${KEY}`); } };
    diagnostics.startupBegan();
    diagnostics.state('storage', 'opening');
    const error = await loadStorageKey({ profile: directory, safeStorage, platform: 'darwin' }).catch(cause => cause);
    assert.equal(error.code, code);
    diagnostics.state('storage', 'failed', error);
    diagnostics.startupEnded('failed', error);
    const persisted = saved(file);
    assert.equal(persisted.lifecycle.storage.code, code);
    assert.equal(persisted.startups.at(-1).outcome, 'failed');
    assert.equal(persisted.startups.at(-1).code, code);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(KEY), false);
    assert.equal(text.includes(directory), false);
    // The next launch shows it as an earlier, stale session.
    const next = new DesktopDiagnostics({ file });
    assert.equal(next.report().previousSession.state, 'stale');
    assert.equal(next.report().previousSession.startups.at(-1).code, code);
  });
}

test('reports corrupt encrypted storage with the manager error tail', t => {
  const { diagnostics, file, directory } = diagnosticsFor(t);
  diagnostics.startupBegan();
  diagnostics.state('manager', 'starting');
  diagnostics.managerOutput(`vault open failed at ${path.join(directory, 'wallets', 'x.db')}\nkey=${KEY}\npartial`);
  const error = Object.assign(new Error('Encrypted wallet storage could not be opened. Existing data was preserved.'), { code: 'STORAGE_UNAVAILABLE' });
  diagnostics.state('storage', 'failed', error);
  diagnostics.managerExited({ code: 1, signal: null, expected: false });
  diagnostics.startupEnded('failed', error);
  const report = diagnostics.report();
  assert.equal(report.lifecycle.storage.code, 'STORAGE_UNAVAILABLE');
  assert.equal(report.lifecycle.manager.state, 'crashed');
  // The last line had no newline. It is often the error that ended the process, so it is kept.
  assert.deepEqual(report.managerOutput, ['vault open failed at <profile>/wallets/x.db', 'key=[redacted]', 'partial']);
  const persisted = saved(file);
  assert.equal(persisted.managerOutput.length, 3);
  assert.equal(JSON.stringify(persisted).includes(KEY), false);
});

test('redacts a recovery phrase wrapped across stderr lines and chunks', t => {
  const { diagnostics, file } = diagnosticsFor(t);
  const words = PHRASE.split(' ');
  diagnostics.managerOutput(`mnemonic: ${words.slice(0, 6).join(' ')}\n${words.slice(6, 9).join(' ')}`);
  diagnostics.managerOutput(` ${words.slice(9).join(' ')}\nError: vault open failed\n`);
  diagnostics.startupEnded('failed', new Error('vault open failed'));
  assert.deepEqual(diagnostics.report().managerOutput, ['mnemonic: [redacted words]', 'Error: vault open failed']);
  for (const text of [fs.readFileSync(file, 'utf8'), diagnostics.text()])
    for (const word of words) assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`), word);
});

test('redacts recovery phrases written as lists, arrays or with a capital first word', () => {
  const words = PHRASE.split(' ');
  const forms = [
    JSON.stringify({ words }),
    JSON.stringify(words),
    words.map((word, index) => `${index + 1}. ${word}`).join(' '),
    words.map((word, index) => `${index + 1}) ${word}`).join('\n'),
    `Mnemonic: ${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}`,
    words.join(', '),
  ];
  for (const form of forms) {
    const text = redactText(form, { limit: 2000 });
    for (const word of words) assert.doesNotMatch(text, new RegExp(`\\b${word}\\b`, 'i'), `${word} in ${text}`);
  }
  assert.equal(redactText('Tor bootstrap failed: could not connect to the guard relay'),
    'Tor bootstrap failed: could not connect to the guard relay', 'ordinary messages are left alone');
});

test('keeps the head of an overlong stderr line so a phrase is never cut into what is shown', t => {
  const { diagnostics } = diagnosticsFor(t);
  // A long line arrives in chunks, with a phrase near its start and its newline much later.
  diagnostics.managerOutput(`fatal: ${PHRASE} `);
  for (let index = 0; index < 20; index += 1) diagnostics.managerOutput('x '.repeat(100));
  diagnostics.managerOutput('end\n');
  const [line] = diagnostics.report().managerOutput;
  assert.match(line, /^fatal: \[redacted words\]/);
  for (const word of PHRASE.split(' ')) assert.doesNotMatch(line, new RegExp(`\\b${word}\\b`), word);
});

test('keeps a final error line that has no newline', t => {
  const { diagnostics, file } = diagnosticsFor(t);
  diagnostics.managerOutput('starting wallets\nError: SQLITE_CORRUPT: database disk image is malformed');
  diagnostics.managerExited({ code: 1, signal: null, expected: false });
  assert.deepEqual(diagnostics.report().managerOutput, ['starting wallets', 'Error: SQLITE_CORRUPT: database disk image is malformed']);
  assert.match(fs.readFileSync(file, 'utf8'), /SQLITE_CORRUPT/);
});

test('reports a crashed manager and engine exits without wallet identifiers', t => {
  const { diagnostics, file, time } = diagnosticsFor(t);
  diagnostics.state('manager', 'ready');
  const manager = { at: time(), engineVersion: '0.9.4', vaultFormat: 1, node: 'v24.0.0',
    resources: { rssKb: 0, threads: 'unsupported' },
    wallets: { total: 2, running: 1, restarting: 1, restarts: 3,
      lastExit: { code: null, signal: 'SIGSEGV', at: '2026-01-01T00:00:00.000Z', expected: false },
      lastStartError: { message: `daemon failed for ${'e'.repeat(64)}`, at: '2026-01-01T00:00:00.000Z' } } };
  const report = diagnostics.report({ manager, desktop: desktopResources([{ memory: { workingSetSize: 100 }, cpu: { percentCPUUsage: 1.25 } }], { rss: 2048 }) });
  assert.equal(report.versions.engine, '0.9.4');
  assert.equal(report.versions.vault, 1);
  assert.equal(report.resources.engines.lastExit.signal, 'SIGSEGV');
  assert.equal(report.resources.engines.lastStartError.message.includes('eeee'), false);
  // A measured zero stays a zero; an unmeasurable count says so.
  assert.equal(report.resources.manager.value.rssKb, 0);
  assert.equal(report.resources.manager.value.threads, 'unsupported');
  assert.equal(report.resources.tor.state, 'unsupported');
  assert.deepEqual(report.resources.desktop.value, { processes: 1, workingSetKb: 100, cpuPercent: 1.3, mainRssKb: 2 });
  diagnostics.managerExited({ code: null, signal: 'SIGKILL', expected: false });
  assert.equal(saved(file).lifecycle.manager.state, 'crashed');
  assert.equal(diagnostics.report().resources.manager.state, 'unavailable');
});

test('marks measurements from before a resume as stale', t => {
  const { diagnostics, time } = diagnosticsFor(t);
  diagnostics.startupEnded('ready');
  diagnostics.torStatus({ phase: 'ready', progress: 100 });
  const wallet = { checkedAt: time(), primaryTransport: 'iroh-direct', primaryRttMs: 0 };
  assert.equal(diagnostics.report({ wallet }).transport.rttMs.state, 'current');
  assert.equal(diagnostics.report({ wallet }).transport.rttMs.value, 0);
  time.advance(1000);
  diagnostics.suspend();
  assert.equal(diagnostics.report().lifecycle.app.state, 'suspended');
  time.advance(60 * 60000);
  diagnostics.resume();
  const report = diagnostics.report({ wallet });
  assert.equal(report.lifecycle.app.state, 'ready');
  assert.equal(report.power.suspends, 1);
  assert.equal(report.tor.progress.state, 'stale');
  assert.equal(report.transport.rttMs.state, 'stale');
  diagnostics.torStatus({ phase: 'ready', progress: 100 });
  assert.equal(diagnostics.report().tor.progress.state, 'current');
  // Tor and plain TCP paths have no round-trip measurement in the engine.
  assert.equal(diagnostics.report({ wallet: { checkedAt: time(), primaryTransport: 'tor', primaryRttMs: null } }).transport.rttMs.state, 'unsupported');
  assert.equal(diagnostics.report({ wallet: { checkedAt: time(), primaryTransport: 'iroh-relay', primaryRttMs: null } }).transport.rttMs.state, 'unavailable');
});

test('records a shutdown that needed the kill deadline as a timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { diagnostics, file } = diagnosticsFor(t);
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true, sent: [], killed: [] });
  child.send = (message, callback) => { child.sent.push(message.type); callback(); };
  child.kill = signal => { child.killed.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); };
  diagnostics.shutdownBegan();
  const stopped = stopChild(child, { timeoutMs: 45000 });
  t.mock.timers.tick(44999);
  assert.deepEqual(child.killed, []);
  t.mock.timers.tick(1);
  const outcome = await stopped;
  assert.equal(outcome, 'timeout');
  assert.deepEqual(child.sent, ['shutdown']);
  assert.deepEqual(child.killed, ['SIGKILL']);
  diagnostics.shutdownEnded({ manager: outcome, tor: 'stopped' });
  const persisted = saved(file);
  assert.equal(persisted.shutdowns.at(-1).outcome, 'timeout');
  assert.equal(persisted.events.at(-1).code, 'SHUTDOWN_TIMEOUT');

  const clean = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true });
  clean.send = () => queueMicrotask(() => clean.emit('exit', 0, null));
  clean.kill = () => assert.fail('a clean stop must not be killed');
  assert.equal(await stopChild(clean), 'exited');
  assert.equal(await stopChild(undefined), 'not-running');

  const failing = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true });
  failing.send = () => queueMicrotask(() => failing.emit('exit', 1, null));
  assert.equal(await stopChild(failing), 'failed');
  const crashed = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true });
  crashed.send = () => queueMicrotask(() => crashed.emit('exit', null, 'SIGSEGV'));
  assert.equal(await stopChild(crashed), 'failed');
  diagnostics.shutdownEnded({ manager: 'failed', tor: 'stopped' });
  assert.equal(diagnostics.report().shutdowns.at(-1).outcome, 'incomplete');
});

test('keeps events, outcomes and output bounded', t => {
  const { diagnostics, file } = diagnosticsFor(t);
  for (let index = 0; index < 200; index += 1) {
    diagnostics.record('test', `event ${index}`);
    diagnostics.startupEnded(index % 2 ? 'ready' : 'failed', index % 2 ? undefined : new Error('x'.repeat(5000)));
    diagnostics.shutdownEnded({ manager: 'exited', tor: 'stopped' });
    diagnostics.managerOutput(`line ${index}\n`);
  }
  const report = diagnostics.report();
  assert.equal(report.events.length, EVENT_LIMIT);
  assert.equal(report.startups.length, OUTCOME_LIMIT);
  assert.equal(report.shutdowns.length, OUTCOME_LIMIT);
  assert.equal(report.managerOutput.length, OUTPUT_LIMIT);
  const appEvents = Array.from({ length: 80 }, (_, index) => ({ message: `app ${index}` }));
  assert.equal(diagnostics.report({ events: appEvents }).appEvents.at(-1).message, 'app 79');
  assert.ok(fs.statSync(file).size < 64 * 1024);
  const huge = { wallet: { utxos: Array.from({ length: 5000 }, (_, height) => ({ height, valueSats: 1 })) } };
  assert.ok(diagnostics.text(huge).length < 128 * 1024);
});

test('ignores a damaged or oversized saved report', t => {
  const directory = profile(t);
  const file = path.join(directory, 'diagnostics.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(new DesktopDiagnostics({ file }).report().previousSession, undefined);
  fs.writeFileSync(file, JSON.stringify({ format: 1, pad: 'x'.repeat(70000) }));
  assert.equal(new DesktopDiagnostics({ file }).report().previousSession, undefined);
});
