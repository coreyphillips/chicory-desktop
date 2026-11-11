import assert from 'node:assert/strict';
import test from 'node:test';
import type { Activity } from '@beignet/wallet-core';
import { noteMoves, paymentNoteKeys } from '../chicory/src/services/paymentNotes.ts';

test('a raw receive note moves only when the entire payment matches one confirmed output', () => {
  const txid = 'ab'.repeat(32);
  const amountSats = 8000;
  const raw = { id: 'transaction:' + txid, kind: 'received', status: 'completed', txid, amountSats } as Activity;
  const rawKey = paymentNoteKeys([raw]).get(raw.id)!;
  const saved = new Map([[rawKey, { text: 'Sample lunch', address: 'sample-address' }]]);
  const matched = {
    ...raw, id: 'payment:matched',
    receiveRequest: { address: 'sample-address', bitcoinTracking: 'unique' },
    receiveStatus: {
      phase: 'completed', method: 'bitcoin', txids: [txid],
      transactions: [{ txid, amountSats, confirmed: true }],
    },
  } as Activity;
  const matchedKey = paymentNoteKeys([matched]).get(matched.id)!;
  assert.deepEqual(noteMoves([matched], saved), new Map([[rawKey, matchedKey]]));
  for (const rows of [
    [{ ...matched, status: 'pending' }],
    [{ ...matched, amountSats: 1000 }],
    [{ ...matched, receiveStatusUnavailable: true }],
    [{ ...matched, receiveRequest: { ...matched.receiveRequest!, address: 'other-address' } }],
    [matched, { ...raw, amountSats: 1000 }],
  ] satisfies Activity[][]) {
    assert.equal(noteMoves(rows, saved).size, 0);
  }
  assert.equal(noteMoves([matched], new Map([...saved, [matchedKey, { text: 'Already labeled', address: 'sample-address' }]])).size, 0);
});

test('pending, uncertain and unrelated activity do not get note editors', () => {
  const baseline = { kind: 'sent', status: 'completed' } as Activity;
  const keys = paymentNoteKeys([
    { ...baseline, id: 'incoming', kind: 'received' }, { ...baseline, id: 'sent' },
    { ...baseline, id: 'pending', status: 'pending' }, { ...baseline, id: 'uncertain', status: 'uncertain' },
    { ...baseline, id: 'transfer', kind: 'transfer' }, { ...baseline, id: 'request', kind: 'request' },
  ]);
  assert.deepEqual([...keys.keys()], ['incoming', 'sent']);
});
