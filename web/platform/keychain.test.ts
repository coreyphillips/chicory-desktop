import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const PREFIX = 'chicory:public-preference:';
const DRAFT = 'com.beignet.wallet.offline-request.wallet-1';
const draft = JSON.stringify({ id: 'r'.repeat(20), amountSats: 4000, description: 'rent for march' });

function storage() {
  const entries = new Map<string, string>();
  return {
    entries,
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}
let instance = 0;
async function fresh(desktop: boolean, { failWrites = false } = {}) {
  const local = storage();
  const store = new Map<string, unknown>();
  const requests: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: desktop ? { chicoryDesktop: {} } : {} });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push(`${method} ${url}`);
    const service = url === '/api/secure-store' ? undefined : decodeURIComponent(url.slice('/api/secure-store/'.length));
    if (failWrites && method === 'PUT') return new Response(JSON.stringify({ ok: false, error: { message: 'The disk is full.' } }), { status: 500 });
    let result: unknown = true;
    if (service === undefined) result = [...store.keys()];
    else if (method === 'GET') result = store.get(service) ?? null;
    else if (method === 'PUT') store.set(service, { service, ...JSON.parse(String(init.body)) });
    else store.delete(service);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  } });
  const keychain = await import(`./keychain.ts?case=${++instance}`);
  return { keychain, local, store, requests };
}
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

test('on desktop, private state goes only to the encrypted store and display preferences stay local', async () => {
  const { keychain, local, store } = await fresh(true);
  await keychain.setGenericPassword('offline-request', draft, { service: DRAFT });
  await keychain.setGenericPassword('auto-pay', JSON.stringify({ on: true, share: 10 }), { service: 'com.beignet.wallet.auto-pay' });
  await keychain.setGenericPassword('haptics', 'on', { service: 'com.beignet.wallet.haptics' });
  await keychain.setGenericPassword('beignet-snapshot', JSON.stringify({ version: 1 }), { service: 'com.beignet.wallet.last-snapshot.wallet-1' });
  assert.deepEqual([...store.keys()].sort(), [DRAFT, 'com.beignet.wallet.auto-pay', 'com.beignet.wallet.last-snapshot.wallet-1'].sort());
  assert.deepEqual([...local.entries.keys()], [`${PREFIX}com.beignet.wallet.haptics`]);
  assert.equal([...local.entries.values()].join('').includes('rent for march'), false, 'no draft in browser storage');
  assert.equal((await keychain.getGenericPassword({ service: DRAFT })).password, draft);
  assert.ok((await keychain.getAllGenericPasswordServices()).includes(DRAFT));
  await keychain.resetGenericPassword({ service: DRAFT });
  assert.equal(store.has(DRAFT), false);
});

test('a later launch reads private state back from the encrypted store', async () => {
  const first = await fresh(true);
  await first.keychain.setGenericPassword('offline-request', draft, { service: DRAFT });
  const saved = first.store.get(DRAFT);
  const second = await fresh(true);
  second.store.set(DRAFT, saved);
  assert.equal((await second.keychain.getGenericPassword({ service: DRAFT })).password, draft);
});

test('plaintext private state from an earlier build is removed, never imported', async () => {
  const { keychain, local, store } = await fresh(true);
  local.setItem(`${PREFIX}${DRAFT}`, JSON.stringify({ username: 'offline-request', password: draft, service: DRAFT }));
  local.setItem(`${PREFIX}com.beignet.wallet.haptics`, JSON.stringify({ username: 'haptics', password: 'off', service: 'com.beignet.wallet.haptics' }));
  assert.equal(await keychain.getGenericPassword({ service: DRAFT }), false);
  assert.equal(local.getItem(`${PREFIX}${DRAFT}`), null);
  assert.notEqual(local.getItem(`${PREFIX}com.beignet.wallet.haptics`), null, 'display preferences are kept');
  assert.equal(store.size, 0, 'nothing is carried over');
});

test('a draft that could not be saved fails, so its reservation is never made', async () => {
  const { keychain } = await fresh(true, { failWrites: true });
  await assert.rejects(keychain.setGenericPassword('offline-request', draft, { service: DRAFT }), /disk is full/);
  assert.equal(await keychain.getGenericPassword({ service: DRAFT }).catch(() => 'unreadable'), false);
});

test('the desktop demo has no wallet service, so it keeps the browser behavior', async () => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?demo' } });
  try {
    const { keychain, requests } = await fresh(true);
    await keychain.setGenericPassword('offline-request', draft, { service: DRAFT });
    assert.deepEqual(requests, []);
  } finally { Reflect.deleteProperty(globalThis, 'location'); }
});

test('a plain browser keeps its previous behavior and never calls the store', async () => {
  const { keychain, local, requests } = await fresh(false);
  await keychain.setGenericPassword('offline-request', draft, { service: DRAFT });
  assert.ok(local.getItem(`${PREFIX}${DRAFT}`));
  assert.deepEqual(requests, []);
});
