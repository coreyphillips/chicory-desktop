import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { WalletClientInterface } from '@beignet/wallet-core';
import { seedSourceWallet } from './seed.ts';

afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });
const client = (walletId: string | undefined) => ({
  connection: { walletId },
  listWallets: async () => [{ id: 'w1', name: 'Everyday', network: 'regtest' }, { id: 'w2', name: 'Savings', network: 'mainnet' }],
}) as unknown as WalletClientInterface;

test('on desktop the open wallet is the one a wallet on another network can share a phrase with', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
  assert.deepEqual(await seedSourceWallet(client('w2')), { walletId: 'w2', network: 'mainnet', name: 'Savings' });
  assert.equal(await seedSourceWallet(client(undefined)), null, 'no open wallet, no source');
  assert.equal(await seedSourceWallet(client('gone')), null, 'a wallet that is no longer here is never a source');
});

test('a plain browser offers no phrase source', async () => {
  assert.equal(await seedSourceWallet(client('w1')), null);
});
