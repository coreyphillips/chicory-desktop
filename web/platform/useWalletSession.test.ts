import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { DemoWalletClient, DEFAULT_PRIMARY_URI } from '@beignet/wallet-core';
import type {
  CreatedWallet, CreateWalletInput, HostConfig, WalletRecord, WalletSnapshot,
} from '@beignet/wallet-core';
import { UmbrelWalletClient } from './walletClient.ts';
import type { SessionDependencies } from './useWalletSession.ts';

registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === 'react-native-keychain'
      ? new URL('./keychain.ts', import.meta.url).href : specifier, context);
  },
});
const { useWalletSession } = await import('./useWalletSession.ts');
type Session = ReturnType<typeof useWalletSession>;
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const record: WalletRecord = {
  id: 'wallet-1', name: 'My wallet', network: 'mainnet', status: 'running',
  lfbw: { enabled: true, primaryUri: DEFAULT_PRIMARY_URI },
};
const newRecord = { ...record, id: 'wallet-2' };
const testRecord: WalletRecord = { ...record, id: 'wallet-test', network: 'regtest' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
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
const local = storage();
const sessionStore = storage();
const listeners = new Set<() => void>();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperties(globalThis, {
  localStorage: { configurable: true, value: local },
  sessionStorage: { configurable: true, value: sessionStore },
  location: { configurable: true, value: { search: '' } },
  document: { configurable: true, value: {
    visibilityState: 'visible',
    addEventListener: (_name: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => listeners.delete(listener),
  } },
});

function snapshot(wallet: WalletRecord, amount = 100): WalletSnapshot {
  return {
    wallet, balance: { totalSats: amount, availableSats: amount, pendingSats: 0, receivableSats: 10_000 },
    activity: [], primary: { uri: DEFAULT_PRIMARY_URI, connected: true, setup: 'ready' },
    notes: [], updatedAt: Date.now(), demo: false,
  };
}
class Host extends UmbrelWalletClient {
  events: string[] = [];
  records: WalletRecord[];
  config = async () => ({ defaultNetwork: 'mainnet' } as HostConfig);
  list: (() => Promise<WalletRecord[]>) | null = null;
  start = async () => {};
  stop = async () => {};
  read: (() => Promise<WalletSnapshot>) | null = null;
  reconnect = async () => {};
  provision = async (_input?: CreateWalletInput): Promise<CreatedWallet> => ({ ...newRecord, mnemonic: PHRASE });
  constructor(records: WalletRecord[] = [record]) {
    super({ fetch: async () => { throw new Error('Tests must never use the network'); } });
    this.records = records;
  }
  override async getConfig() { this.events.push('config'); return this.config(); }
  override async listWallets() { this.events.push('list'); return this.list ? this.list() : this.records; }
  override async startWallet() { this.events.push(`start:${this.connection.walletId}`); await this.start(); }
  override async stopWallet() { this.events.push(`stop:${this.connection.walletId}`); await this.stop(); }
  override async refreshWallet() { this.events.push('reconnect'); await this.reconnect(); }
  override async snapshot() {
    this.events.push(`snapshot:${this.connection.walletId}`);
    return this.read ? this.read() : snapshot(this.records.find(item => item.id === this.connection.walletId)!);
  }
  override async createWallet(input?: CreateWalletInput) {
    this.events.push(input?.mnemonic ? 'import' : 'create');
    const created = await this.provision(input);
    this.records.push(created);
    this.selectWallet(created.id);
    return created;
  }
  override async updateWalletSettings() { this.events.push('settings'); }
}
/** The desktop wallet service's encrypted store, in memory. */
let secureDelay: Promise<unknown> | null = null;
const secureEntries = new Map<string, { service: string; username: string; password: string }>();
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  if (!url.startsWith('/api/secure-store')) throw new Error(`Unexpected request ${url}`);
  const service = url === '/api/secure-store' ? undefined : decodeURIComponent(url.slice('/api/secure-store/'.length));
  const method = init.method ?? 'GET';
  let result: unknown = true;
  if (method === 'GET' && service && secureDelay) await secureDelay;
  if (service === undefined) result = [...secureEntries.keys()];
  else if (method === 'GET') result = secureEntries.get(service) ?? null;
  else if (method === 'PUT') secureEntries.set(service, { service, ...JSON.parse(String(init.body)) });
  else if (method === 'DELETE') secureEntries.delete(service);
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
} });
const roots = new Set<ReactTestRenderer>();
beforeEach(() => {
  local.entries.clear(); sessionStore.entries.clear();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '' } });
});
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); roots.clear(); });
});
async function mount(host: Host, others: Host[] = [], override?: SessionDependencies) {
  let session!: Session;
  const queue = [host, ...others];
  const dependencies = override ?? {
    createHostClient: () => {
      const next = queue.shift();
      if (!next) throw new Error('Unexpected extra host client');
      return next;
    },
    createDemoClient: () => new DemoWalletClient(),
  };
  function Harness() {
    session = useWalletSession({ tab: 'Wallet', onTab() {}, onCloseSheet() {} }, dependencies);
    return null;
  }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Harness)); });
  roots.add(root);
  return {
    get session() { return session; },
    async unmount() { await act(async () => root.unmount()); roots.delete(root); },
  };
}

test('a pending host connection is latched and a lock invalidates its late result', async () => {
  const host = new Host();
  const config = deferred<HostConfig>();
  host.config = () => config.promise;
  const app = await mount(host);
  assert.equal(app.session.connecting, true);
  await act(async () => {
    await assert.rejects(app.session.openWallet(), { code: 'ACTION_IN_PROGRESS' });
    await app.session.disconnect();
    config.resolve({ defaultNetwork: 'mainnet' } as HostConfig);
  });
  assert.equal(app.session.client, null);
  assert.equal(app.session.walletId, '');
  assert.equal(app.session.connecting, false);
  assert.equal(host.events.filter(item => item === 'config').length, 1);
  assert.equal(host.events.some(item => item.startsWith('start:')), false);
});

test('a late opening snapshot cannot land or release the latch of an ongoing lock', async () => {
  const host = new Host();
  const read = deferred<WalletSnapshot>();
  const stop = deferred<void>();
  host.read = () => read.promise;
  host.stop = () => stop.promise;
  const app = await mount(host);
  let closing!: Promise<void>;
  await act(async () => { closing = app.session.disconnect(); });
  await act(async () => { read.resolve(snapshot(record, 500)); });
  assert.equal(app.session.closing, true);
  assert.equal(app.session.snapshot, null);
  await act(async () => { stop.resolve(); await closing; });
  assert.equal(app.session.client, null);
  assert.equal(app.session.walletId, '');
  assert.equal(app.session.closing, false);
});

test('default creation runs once and pending backup survives a page reload', async () => {
  const records: WalletRecord[] = [];
  const host = new Host(records);
  const creator = new Host(records);
  const created = deferred<CreatedWallet>();
  creator.provision = () => created.promise;
  const app = await mount(host, [creator]);
  let first!: Promise<void>;
  await act(async () => {
    first = app.session.createDefaultWallet();
    await app.session.createDefaultWallet();
  });
  assert.equal(creator.events.filter(item => item === 'create').length, 1);
  await act(async () => { created.resolve({ ...newRecord, mnemonic: PHRASE }); await first; });
  assert.equal(app.session.walletId, newRecord.id);
  assert.equal(app.session.rememberedSession?.backupPending, true);
  assert.equal(local.getItem(`chicory:backup-pending:${newRecord.id}`), 'true');
  assert.ok(![...local.entries.values(), ...sessionStore.entries.values()].join('').includes(PHRASE));
  const stops = host.events.filter(item => item.startsWith('stop:')).length;
  await app.unmount();
  assert.equal(host.events.filter(item => item.startsWith('stop:')).length, stops);
  const reloaded = await mount(new Host(records));
  assert.equal(reloaded.session.walletId, newRecord.id);
  assert.equal(reloaded.session.rememberedSession?.backupPending, true);
  await act(async () => { reloaded.session.acknowledgeBackup(); });
  assert.equal(local.getItem(`chicory:backup-pending:${newRecord.id}`), null);
  assert.equal(reloaded.session.rememberedSession?.backupPending, false);
});

test('explicit restore opens the picker after stopping the current wallet and never creates', async () => {
  const host = new Host();
  const app = await mount(host);
  await act(async () => { await app.session.openWallet({ restore: true }); });
  assert.equal(app.session.walletId, '');
  assert.ok(app.session.client);
  assert.equal(app.session.snapshot, null);
  assert.ok(host.events.includes('stop:wallet-1'));
  assert.equal(host.events.some(item => item === 'create' || item === 'import'), false);
});

test('a failed stop keeps the wallet visible and a new poll can overtake its old pending read', async () => {
  const host = new Host();
  const app = await mount(host);
  const old = deferred<WalletSnapshot>();
  host.read = () => old.promise;
  let pending!: Promise<void>;
  await act(async () => { pending = app.session.refresh(); });
  host.stop = async () => { throw new Error('Stop was not confirmed'); };
  await act(async () => { await app.session.disconnect(); });
  assert.equal(app.session.walletId, record.id);
  assert.match(app.session.error, /not confirmed/);
  host.read = async () => snapshot(record, 777);
  await act(async () => { await app.session.refresh(); });
  assert.equal(app.session.snapshot?.balance.totalSats, 777);
  assert.equal(app.session.error, '');
  await act(async () => { old.reject(new Error('An obsolete read failed')); await pending; });
  assert.equal(app.session.snapshot?.balance.totalSats, 777);
  assert.equal(app.session.error, '');
});

test('locking during manual refresh prevents another snapshot and stale flag writes', async () => {
  const host = new Host();
  const app = await mount(host);
  const reconnect = deferred<void>();
  host.reconnect = () => reconnect.promise;
  let pending!: Promise<void>;
  await act(async () => { pending = app.session.manualRefresh(); });
  await act(async () => { await app.session.disconnect(); });
  const snapshots = host.events.filter(item => item.startsWith('snapshot:')).length;
  await act(async () => { reconnect.resolve(); await pending; });
  assert.equal(app.session.client, null);
  assert.equal(app.session.refreshing, false);
  assert.equal(host.events.filter(item => item.startsWith('snapshot:')).length, snapshots);
});

test('a delayed network switch cannot change profile or selection after lock', async () => {
  const host = new Host([record, testRecord]);
  const app = await mount(host);
  const records = deferred<WalletRecord[]>();
  host.list = () => records.promise;
  let pending!: Promise<void>;
  await act(async () => {
    pending = app.session.switchNetwork({
      ...app.session.activeProfile, network: 'regtest',
      electrum: { host: 'regtest.local', port: 50001, tls: false },
    });
  });
  await act(async () => { await app.session.disconnect(); });
  await act(async () => { records.resolve([record, testRecord]); await pending; });
  assert.equal(app.session.client, null);
  assert.equal(app.session.activeProfile.network, 'mainnet');
  assert.equal(app.session.switching, false);
  assert.equal(host.events.includes(`start:${testRecord.id}`), false);
});

test('a switch to a network with no server says why and leaves the wallet as it was', async () => {
  const host = new Host([record, testRecord]);
  const app = await mount(host);
  await act(async () => {
    await assert.rejects(app.session.switchNetwork({
      ...app.session.activeProfile, network: 'regtest',
      electrum: { host: ' ', port: 60401, tls: false },
    }), /Add an Electrum server for regtest/);
  });
  assert.match(app.session.switchError, /Add an Electrum server for regtest/);
  assert.equal(app.session.activeProfile.network, 'mainnet');
  assert.equal(app.session.walletId, record.id);
  assert.equal(app.session.switching, false);
  assert.equal(host.events.some(item => item.startsWith('stop:')), false, 'nothing was stopped for a switch that cannot start');
});

test('lock overtakes creation and stops a known late-created wallet without selecting it', async () => {
  const records = [record];
  const host = new Host(records);
  const creator = new Host(records);
  const created = deferred<CreatedWallet>();
  creator.provision = () => created.promise;
  const app = await mount(host, [creator]);
  let pending!: Promise<void>;
  await act(async () => { pending = app.session.createDefaultWallet(); });
  assert.equal(app.session.walletId, record.id);
  assert.equal(host.connection.walletId, record.id);
  await act(async () => { await app.session.disconnect(); });
  await act(async () => { created.resolve({ ...newRecord, mnemonic: PHRASE }); await pending; });
  assert.equal(app.session.client, null);
  assert.equal(app.session.walletId, '');
  assert.ok(creator.events.includes(`stop:${newRecord.id}`));
  assert.equal(sessionStore.getItem('chicory:host-selection')?.includes(newRecord.id), false);
});

test('closing the tab while creation completes leaves its server daemon running', async () => {
  const records: WalletRecord[] = [];
  const host = new Host(records);
  const creator = new Host(records);
  const created = deferred<CreatedWallet>();
  creator.provision = () => created.promise;
  const app = await mount(host, [creator]);
  let pending!: Promise<void>;
  await act(async () => { pending = app.session.createDefaultWallet(); });
  await app.unmount();
  created.resolve({ ...newRecord, mnemonic: PHRASE });
  await pending;
  assert.equal(creator.events.some(item => item.startsWith('stop:')), false);
  assert.equal(local.getItem(`chicory:backup-pending:${newRecord.id}`), 'true');
});

test('manual CreateSheet completion clears pending backup only on its acknowledged select', async () => {
  const records: WalletRecord[] = [];
  const host = new Host(records);
  const creator = new Host(records);
  const app = await mount(host, [creator]);
  let created!: CreatedWallet;
  await act(async () => { created = await app.session.client!.createWallet({ name: 'New wallet' }); });
  assert.equal(app.session.walletId, '');
  assert.equal(local.getItem(`chicory:backup-pending:${created.id}`), 'true');
  await act(async () => { await app.session.selectWallet(created, true); });
  assert.equal(app.session.walletId, created.id);
  assert.equal(app.session.rememberedSession?.backupPending, false);
  assert.equal(local.getItem(`chicory:backup-pending:${created.id}`), null);
});

test('a saved locked wallet waits for an explicit open instead of auto-starting on reload', async () => {
  sessionStore.setItem('chicory:host-selection', JSON.stringify({ walletId: record.id, locked: true }));
  const host = new Host();
  const reopen = new Host();
  const app = await mount(host, [reopen]);
  assert.equal(app.session.client, null);
  assert.equal(app.session.rememberedSession?.locked, true);
  assert.equal(host.events.some(item => item.startsWith('start:')), false);
  await act(async () => { await app.session.openWallet(); });
  assert.equal(app.session.walletId, record.id);
  assert.ok(reopen.events.includes(`start:${record.id}`));
});

test('Welcome network setup never reopens a saved wallet from a different network', async () => {
  sessionStore.setItem('chicory:host-selection', JSON.stringify({ walletId: record.id, locked: true }));
  const host = new Host();
  const configured = new Host();
  const app = await mount(host, [configured]);
  await act(async () => {
    await app.session.openDevice({
      ...app.session.activeProfile, network: 'regtest',
      electrum: { host: 'regtest.local', port: 50001, tls: false },
    }, { existingOnly: true, walletId: record.id, prepared: true });
  });
  assert.equal(app.session.activeProfile.network, 'regtest');
  assert.equal(app.session.walletId, '');
  assert.ok(app.session.client);
  assert.equal(configured.events.some(item => item.startsWith('start:')), false);
});

test('explicit demo mode uses only a DemoWalletClient and does not overwrite host selection', async () => {
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?demo' } });
  sessionStore.setItem('chicory:host-selection', 'saved-host-choice');
  const app = await mount(new Host(), [], {
    createHostClient: () => { throw new Error('Demo must never construct a host client'); },
    createDemoClient: () => new DemoWalletClient(),
  });
  assert.equal(app.session.client?.demo, true);
  assert.equal(sessionStore.getItem('chicory:host-selection'), 'saved-host-choice');
});


test('native desktop remembers the selected wallet across a new window session', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  const app = await mount(new Host([record, newRecord]));
  await act(async () => { await app.session.selectWallet(newRecord); });
  assert.deepEqual(JSON.parse(local.getItem('chicory:host-selection')!), { walletId: newRecord.id, locked: false });
  assert.equal(sessionStore.getItem('chicory:host-selection'), null);
  await app.unmount();
  sessionStore.entries.clear();
  const reopened = new Host([record, newRecord]);
  const next = await mount(reopened);
  assert.equal(next.session.walletId, newRecord.id);
  assert.ok(reopened.events.includes(`start:${newRecord.id}`));
});

test('a native desktop wallet explicitly stopped stays stopped across launches', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  const app = await mount(new Host());
  await act(async () => { await app.session.disconnect(); });
  await app.unmount();
  sessionStore.entries.clear();
  const reopened = new Host();
  const next = await mount(reopened);
  assert.equal(next.session.client, null);
  assert.equal(next.session.rememberedSession?.locked, true);
  assert.equal(reopened.events.some(item => item.startsWith('start:')), false);
});

test('desktop defaults use the mobile primary and preserve custom profiles', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  const { defaultPreferences, loadNetworkPreferences, saveNetworkPreferences } = await import('../chicory/src/services/networks.ts');
  const preferences = defaultPreferences();
  assert.equal(preferences.profiles.mainnet.primaryUri, DEFAULT_PRIMARY_URI);
  const customPrimary = '02' + 'a'.repeat(64) + '@node.example:9735';
  preferences.profiles.mainnet.primaryUri = customPrimary;
  await saveNetworkPreferences(preferences);
  assert.equal((await loadNetworkPreferences()).profiles.mainnet.primaryUri, customPrimary);
});

test('erase is offered only by a desktop host that can erase, never in a plain browser', async () => {
  const browser = await mount(new Host());
  assert.equal(browser.session.eraseDevice, undefined);
  await browser.unmount();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  const older = await mount(new Host());
  assert.equal(older.session.eraseDevice, undefined, 'a host without the erase call shows no row');
  await older.unmount();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: { erase: async () => ({ ok: true }) } } });
  const desktop = await mount(new Host());
  assert.equal(typeof desktop.session.eraseDevice, 'function');
});

test('erasing draws the erase transit until the host answers, and a refusal is shown and retryable', async () => {
  const answer = deferred<{ ok: boolean; code?: string; error?: string }>();
  let calls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {
    erase: () => { calls += 1; return answer.promise; },
  } } });
  const app = await mount(new Host());
  let pending!: Promise<void>;
  await act(async () => { pending = app.session.eraseDevice!(); });
  assert.equal(app.session.erasing, true);
  assert.equal(app.session.closing, true, 'closing and erasing together draw the erase transit');
  const message = 'Erasing did not finish. Some wallet files could not be removed.';
  await act(async () => {
    answer.resolve({ ok: false, code: 'ERASE_INCOMPLETE', error: message });
    await assert.rejects(pending, (error: Error & { code?: string }) => error.message === message && error.code === 'ERASE_INCOMPLETE');
  });
  assert.equal(app.session.erasing, false);
  assert.equal(app.session.closing, false);
  assert.equal(app.session.error, message, 'the session says it too, in case the transit replaced the panel');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: { erase: async () => { calls += 1; return { ok: true }; } } } });
  await act(async () => { await app.session.eraseDevice!(); });
  assert.equal(calls, 2);
});

test('a returning desktop wallet opens on its encrypted cached view until the live read lands', async () => {
  const { cacheEntry } = await import('../chicory/src/services/snapshotCache.ts');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  // Its own wallet, so no earlier test's in-memory entry stands in for the store.
  const returning = { ...record, id: 'wallet-returning' };
  const cachedAt = Date.now() - 3_600_000;
  const service = `com.beignet.wallet.last-snapshot.${returning.id}`;
  secureEntries.set(service, { service, username: 'beignet-snapshot',
    password: cacheEntry(returning.id, { ...snapshot(returning, 777), updatedAt: cachedAt }).stored });
  const host = new Host([returning]);
  const live = deferred<WalletSnapshot>();
  host.read = () => live.promise;
  const app = await mount(host);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(app.session.snapshot?.balance.totalSats, 777, 'the cached view is shown while the engine starts');
  assert.equal(app.session.snapshot?.primary.connected, false, 'a cached connection is never claimed');
  assert.equal(app.session.snapshot?.updatedAt, cachedAt, 'it keeps its original time, so the staleness gate holds');
  await act(async () => { live.resolve(snapshot(returning, 100)); await live.promise; });
  assert.equal(app.session.snapshot?.balance.totalSats, 100);
  assert.equal(app.session.snapshot?.primary.connected, true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.match(secureEntries.get(service)!.password, /"totalSats":100/, 'the live read becomes the next cached view');
});

test('a cached view that arrives after the live read never covers it', async () => {
  const { cacheEntry } = await import('../chicory/src/services/snapshotCache.ts');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  const racing = { ...record, id: 'wallet-racing' };
  const service = `com.beignet.wallet.last-snapshot.${racing.id}`;
  secureEntries.set(service, { service, username: 'beignet-snapshot', password: cacheEntry(racing.id, snapshot(racing, 777)).stored });
  const slow = deferred<void>();
  secureDelay = slow.promise;
  try {
    const app = await mount(new Host([racing]));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(app.session.snapshot?.balance.totalSats, 100, 'the live read landed first');
    await act(async () => { slow.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(app.session.snapshot?.balance.totalSats, 100, 'the late cache read is ignored');
  } finally { secureDelay = null; }
});

test('a wallet that reuses a phrase the owner already holds is not marked for a new backup', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  const host = new Host();
  const related = { ...record, id: 'wallet-related', network: 'regtest' as const };
  host.provision = async () => related as CreatedWallet;
  const app = await mount(host, [new Host([record, related])]);
  await act(async () => { await app.session.client!.createWallet({ name: 'Related', network: 'regtest', primaryUri: DEFAULT_PRIMARY_URI }); });
  assert.equal(local.getItem(`chicory:backup-pending:${related.id}`), null, 'no phrase came back, so there is nothing new to write down');
});
