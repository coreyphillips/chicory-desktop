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
