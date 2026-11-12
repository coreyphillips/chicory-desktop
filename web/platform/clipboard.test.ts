import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Clipboard from './clipboard.ts';

const copied: string[] = [];
function documentStub() {
  return {
    createElement: () => ({ value: '', style: {}, setAttribute() {}, select() {}, remove() {} }),
    body: { append(field: { value: string }) { copied.push(field.value); } },
    execCommand: (command: string) => command === 'copy',
  };
}
function browser(clipboard: unknown) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub() });
}
afterEach(() => { copied.length = 0; Reflect.deleteProperty(globalThis, 'document'); });

test('a missing or refused clipboard says to paste into the field instead, never a raw browser error', async () => {
  browser(undefined);
  await assert.rejects(Clipboard.getString(), /unavailable\. Paste into the request field instead/);
  browser({ readText: async () => { throw Object.assign(new Error('Read permission denied.'), { name: 'NotAllowedError' }); } });
  await assert.rejects(Clipboard.getString(), (error: Error) =>
    /not allowed to read the clipboard\. Paste into the request field instead/.test(error.message) && !/permission denied/.test(error.message));
  browser({ readText: async () => 'lnbcrt1example' });
  assert.equal(await Clipboard.getString(), 'lnbcrt1example');
});

test('copying falls back to the page when the clipboard API is missing or refuses', async () => {
  browser(undefined);
  Clipboard.setString('bcrt1qexample');
  assert.deepEqual(copied, ['bcrt1qexample']);
  browser({ writeText: async () => { throw new Error('Write permission denied.'); } });
  Clipboard.setString('lnbcrt1copy');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(copied, ['bcrt1qexample', 'lnbcrt1copy']);
});

function host(copySecret?: (text: string) => Promise<boolean>) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: copySecret ? { copySecret } : {} } });
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

test('a secret goes on the clipboard only where the host can take it back', async () => {
  assert.equal(Clipboard.canHoldSecret(), false);
  assert.equal(await Clipboard.setSecret('twelve words'), false);
  host();
  assert.equal(Clipboard.canHoldSecret(), false);
  assert.equal(await Clipboard.setSecret('twelve words'), false);
  browser({ writeText: () => { throw new Error('a secret never reaches the page clipboard'); } });
  assert.equal(await Clipboard.setSecret('twelve words'), false);
  assert.deepEqual(copied, []);
});
test('the host is handed the secret and its answer stands, and a failure is an answer', async () => {
  const handed: string[] = [];
  host(async text => { handed.push(text); return true; });
  assert.equal(Clipboard.canHoldSecret(), true);
  assert.equal(await Clipboard.setSecret('twelve words'), true);
  assert.deepEqual(handed, ['twelve words']);
  host(async () => false);
  assert.equal(await Clipboard.setSecret('twelve words'), false);
  host(async () => { throw new Error('refused'); });
  assert.equal(await Clipboard.setSecret('twelve words'), false);
});
