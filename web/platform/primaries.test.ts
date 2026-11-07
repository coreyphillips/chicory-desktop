import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PRIMARY_URI } from '@beignet/wallet-core';
import type { PrimaryStatus, WalletRecord, WalletSnapshot } from '@beignet/wallet-core';
import { anyPrimaryConnected, primariesConnected, receiveTargetConnected } from './primaries.ts';

const record: WalletRecord = {
  id: 'wallet-1', name: 'My wallet', network: 'mainnet', status: 'running',
  lfbw: { enabled: true, primaryUri: DEFAULT_PRIMARY_URI },
};
const snapshot = (over: Partial<WalletSnapshot> = {}): WalletSnapshot => ({
  wallet: record, balance: { totalSats: 1, availableSats: 1, pendingSats: 0, receivableSats: 0 },
  activity: [], primary: { uri: DEFAULT_PRIMARY_URI, connected: true, setup: 'ready' },
  notes: [], updatedAt: 1, demo: false, ...over,
});
const entry = (rank: number, over: Partial<PrimaryStatus> = {}): PrimaryStatus => ({
  pubkey: `0${(rank % 2) + 2}${String(rank).repeat(64).slice(0, 64)}`, rank, uri: `pk${rank}@host:9735`, fallbackUri: null,
  connected: true, setup: 'ready', balanceSat: 0, channelCount: 1, isReceiveTarget: rank === 1, selectionOrder: rank, ...over,
});

test('without a ranked list every reading is what the one primary says (coreyphillips/beignet#1924)', () => {
  assert.equal(anyPrimaryConnected(snapshot()), true);
  assert.equal(receiveTargetConnected(snapshot()), true);
  assert.equal(anyPrimaryConnected(snapshot({ primary: { uri: DEFAULT_PRIMARY_URI, connected: false, setup: 'ready' } })), false);
  assert.equal(receiveTargetConnected(snapshot({ primary: { uri: DEFAULT_PRIMARY_URI, connected: false, setup: 'ready' } })), false);
  assert.deepEqual(primariesConnected(snapshot()), { connected: 0, total: 0 });
  assert.deepEqual(primariesConnected(snapshot({ primaries: [] })), { connected: 0, total: 0 });
  assert.equal(anyPrimaryConnected(null), false);
  assert.equal(receiveTargetConnected(undefined), false);
});

test('with a ranked list, any node connected is enough to send, the dot follows the receive target, and the count says how many answer', () => {
  const ranked = snapshot({
    primary: { uri: DEFAULT_PRIMARY_URI, connected: false, setup: 'ready' },
    primaries: [entry(1, { connected: false, isReceiveTarget: false }), entry(2, { isReceiveTarget: true }), entry(3, { connected: false, isReceiveTarget: false })],
  });
  assert.equal(anyPrimaryConnected(ranked), true);
  assert.equal(receiveTargetConnected(ranked), true);
  assert.deepEqual(primariesConnected(ranked), { connected: 1, total: 3 });
  const away = snapshot({ primaries: [entry(1, { connected: false }), entry(2, { connected: false, isReceiveTarget: false })] });
  assert.equal(anyPrimaryConnected(away), false);
  assert.equal(receiveTargetConnected(away), false);
  // No node marked as the target: rank 1 stands in.
  const unmarked = snapshot({ primaries: [entry(1, { isReceiveTarget: false, connected: false }), entry(2, { isReceiveTarget: false })] });
  assert.equal(receiveTargetConnected(unmarked), false);
  assert.equal(anyPrimaryConnected(unmarked), true);
});
