import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import * as keychain from './keychain.ts';
import * as lock from './lock.ts';

const entries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  },
});
beforeEach(() => entries.clear());

test('public preferences save while secret services and protected entries fail closed', async () => {
  const service = 'com.beignet.wallet.haptics';
  await keychain.setGenericPassword('preference', 'off', { service });
  assert.equal((await keychain.getGenericPassword({ service }) as { password: string }).password, 'off');
  const written = entries.size;
  await assert.rejects(keychain.setGenericPassword('key', 'secret', {
    service: 'com.beignet.wallet.embedded.database-key.mainnet',
  }), /Secure device storage is unavailable/);
  await assert.rejects(keychain.setGenericPassword('preference', 'on', {
    service, accessControl: 'BIOMETRY',
  }), /Secure device storage is unavailable/);
  assert.equal(entries.size, written);
  assert.equal(await keychain.getGenericPassword({ service: 'com.beignet.wallet.embedded.database-key.mainnet' }), false);
});

test('network preferences cannot persist browser relay credentials', async () => {
  const profiles = Object.fromEntries(['mainnet', 'testnet', 'regtest'].map(network => [network, {
    network, electrum: { host: 'example.test', port: 50002, tls: true },
    primaryUri: '', transport: 'native', relayUrl: '', relayToken: '',
  }]));
  const value = { version: 1, selectedNetwork: 'mainnet', profiles };
  const service = 'com.beignet.wallet.network-profiles';
  await keychain.setGenericPassword('networks', JSON.stringify(value), { service });
  profiles.mainnet.relayToken = 'private-token';
  await assert.rejects(keychain.setGenericPassword('networks', JSON.stringify(value), { service }), /managed by the local wallet service/);
  assert.ok(![...entries.values()].join('').includes('private-token'));
});

test('wallet snapshots stay in memory and secret payloads are refused', async () => {
  const service = 'com.beignet.wallet.last-snapshot.test-wallet';
  await keychain.setGenericPassword('snapshot', JSON.stringify({ walletId: 'test-wallet', snapshot: { balance: 2000 } }), { service });
  assert.equal(entries.size, 0);
  assert.ok(await keychain.getGenericPassword({ service }));
  await assert.rejects(keychain.setGenericPassword('snapshot', JSON.stringify({ mnemonic: 'secret phrase' }), { service }), /Secret wallet data/);
  await keychain.resetGenericPassword({ service });
});

test('browser does not claim device biometric authentication', async () => {
  assert.equal(await lock.supportedBiometry(), null);
  assert.equal(await lock.isLockEnabled(), false);
  assert.equal(await lock.authenticate('Unlock'), false);
  await assert.rejects(lock.setLockEnabled(true), /unavailable/);
});

test('desktop lock adapter only asks the main process and surfaces its refusals', async () => {
  const calls: string[] = [];
  const listeners: Array<(name: string, value?: string | boolean) => void> = [];
  let unlock = { ok: false, reason: 'cancelled', error: 'Authentication was cancelled.' };
  let authorize = { ok: false, reason: 'unavailable', error: 'System authentication is unavailable.' };
  const bridge = {
    state: async () => { calls.push('state'); return { enabled: true, locked: true, kind: 'fingerprint' as const }; },
    unlock: async () => { calls.push('unlock'); return unlock; },
    setEnabled: async (enabled: boolean) => { calls.push(`set:${enabled}`); return { ok: false, error: 'Authentication was cancelled. The app lock was not changed.' }; },
    authorize: async () => { calls.push('authorize'); return authorize; },
    onEvent: (callback: (name: string, value?: string | boolean) => void) => { listeners.push(callback); return () => {}; },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: { lock: bridge } } });
  try {
    assert.equal(await lock.supportedBiometry(), 'fingerprint');
    assert.equal(await lock.isLockEnabled(), true);
    assert.equal(await lock.authenticate('Unlock'), false, 'a cancelled prompt stays locked without an error loop');
    unlock = { ok: false, reason: 'unavailable', error: 'System authentication is unavailable.' };
    await assert.rejects(lock.authenticate('Unlock'), /unavailable/);
    await assert.rejects(lock.requireUnlock('Reveal'), /unavailable/);
    authorize = { ok: false, reason: 'cancelled', error: '' };
    assert.equal(await lock.requireUnlock('Reveal'), false);
    await assert.rejects(lock.setLockEnabled(true), /not changed/);
    const seen: string[] = [];
    lock.onRelock(reason => seen.push(`relock:${reason}`));
    lock.onConceal(() => seen.push('conceal'));
    lock.onLockChanged(enabled => seen.push(`changed:${enabled}`));
    for (const listener of listeners) { listener('conceal', 'blur'); listener('locked', 'suspend'); listener('changed', 'yes'); }
    assert.deepEqual(seen, ['relock:suspend', 'conceal', 'conceal']);
    bridge.state = async () => { throw new Error('ipc closed'); };
    assert.equal(await lock.isLockEnabled(), true, 'an unreadable state shows the lock screen');
    assert.equal(await lock.supportedBiometry(), null);
    assert.deepEqual(calls, ['state', 'state', 'unlock', 'unlock', 'authorize', 'authorize', 'set:true']);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});
