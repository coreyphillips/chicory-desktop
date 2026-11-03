'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WalletManager } = require('./wallet-manager');

function harness({ dieOn } = {}) {
  const proc = new EventEmitter();
  proc.signals = [];
  proc.kill = signal => {
    proc.signals.push(signal);
    if (signal === dieOn) setImmediate(() => proc.emit('exit', 0, signal));
  };
  const rec = { id: 'wallet', port: 3311 };
  const manager = Object.assign(Object.create(WalletManager.prototype), {
    runtime: new Map([['wallet', { proc }]]),
    registry: { get: id => id === rec.id ? rec : undefined },
    killGraceMs: 1000, killReapMs: 20,
  });
  return { manager, proc, rec };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('Windows requests authenticated graceful shutdown and waits for process exit', async () => {
  const { manager, proc, rec } = harness();
  let requested;
  manager._requestDaemonStop = async record => { requested = record; };
  let complete = false;
  const stopping = manager._killProc(proc, { platform: 'win32' }).then(() => { complete = true; });
  await tick();
  assert.equal(requested, rec);
  assert.deepEqual(proc.signals, []);
  assert.equal(complete, false, 'an HTTP response is not a closed database');
  proc.emit('exit', 0, null);
  await stopping;
  assert.equal(complete, true);
  assert.deepEqual(proc.signals, []);
});

test('an unresponsive Windows daemon is force terminated after its graceful bound', async () => {
  const { manager, proc } = harness({ dieOn: 'SIGKILL' });
  manager.killGraceMs = 5;
  manager._requestDaemonStop = async () => {};
  await manager._killProc(proc, { platform: 'win32' });
  assert.deepEqual(proc.signals, ['SIGKILL']);
});

test('a Windows daemon without an answering stop API falls back to process termination', async () => {
  const { manager, proc } = harness({ dieOn: 'SIGTERM' });
  manager._requestDaemonStop = async () => { throw new Error('not listening'); };
  await manager._killProc(proc, { platform: 'win32' });
  assert.deepEqual(proc.signals, ['SIGTERM']);
});

test('POSIX daemons retain their signal handler shutdown path', async () => {
  const { manager, proc } = harness({ dieOn: 'SIGTERM' });
  manager._requestDaemonStop = async () => { assert.fail('POSIX does not need the HTTP workaround'); };
  await manager._killProc(proc, { platform: 'darwin' });
  assert.deepEqual(proc.signals, ['SIGTERM']);
});

test('graceful stop uses only the selected daemon token and requires acknowledgement', async t => {
  const { manager, rec } = harness();
  manager.token = id => { assert.equal(id, rec.id); return 'daemon-token'; };
  const calls = [];
  let packet = { ok: true, result: { stopped: true } };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => packet };
  });
  await manager._requestDaemonStop(rec);
  assert.equal(calls[0].url, 'http://127.0.0.1:3311/stop');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer daemon-token', 'Content-Type': 'application/json' });
  assert.equal(calls[0].options.body, '{}');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  packet = { ok: false, error: { code: 'UNAUTHORIZED' } };
  await assert.rejects(manager._requestDaemonStop(rec), /could not begin/);
  packet = { ok: true, result: {} };
  await assert.rejects(manager._requestDaemonStop(rec), /could not begin/);
});
