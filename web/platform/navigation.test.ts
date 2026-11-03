import assert from 'node:assert/strict';
import test from 'node:test';
import { initialStage, stageReducer } from '../chicory/src/stage/scene.ts';
import type { Activity } from '@beignet/wallet-core';
import { localPoint } from './geometry.ts';

test('browser navigation cannot leave a payment in flight or an open overlay', () => {
  const send = stageReducer(initialStage(), { type: 'navigate', name: 'send' });
  const busy = stageReducer(send, { type: 'busy', busy: true });
  for (const name of ['home', 'receive', 'activity', 'settings'] as const)
    assert.equal(stageReducer(busy, { type: 'navigate', name }), busy);
  const scanning = stageReducer(send, { type: 'overlay', overlay: { name: 'scan', target: 'send', origin: null } });
  assert.equal(stageReducer(scanning, { type: 'navigate', name: 'home' }), scanning);
});

test('the current navigation item preserves the current payment draft and scene key', () => {
  const send = stageReducer(initialStage(), { type: 'link', request: 'bitcoin:request-for-review' });
  assert.equal(stageReducer(send, { type: 'navigate', name: 'send' }), send);
});

test('desktop navigation switches scenes with a fresh identity and a safe home return', () => {
  const send = stageReducer(initialStage(), { type: 'navigate', name: 'send' });
  const receive = stageReducer(send, { type: 'navigate', name: 'receive' });
  assert.equal(receive.scene.name, 'receive');
  assert.notEqual(receive.scene.key, send.scene.key);
  assert.deepEqual(receive.stack.map(scene => scene.name), ['home']);
  assert.equal(stageReducer(receive, { type: 'back' }).scene.name, 'home');
});

test('selecting another visible activity row replaces the detail without growing the return stack', () => {
  const item = (id: string) => ({ id, kind: 'sent', title: 'Payment sent', amountSats: 100, status: 'completed', timestamp: 1 } as Activity);
  const first = stageReducer(initialStage(), { type: 'open', scene: { name: 'detail', item: item('first'), from: null } });
  const second = stageReducer(first, { type: 'open', scene: { name: 'detail', item: item('second'), from: null } });
  assert.equal(second.scene.name === 'detail' && second.scene.item.id, 'second');
  assert.equal(second.stack, first.stack);
  assert.equal(stageReducer(second, { type: 'back' }).scene.name, 'home');
  const busy = stageReducer(first, { type: 'busy', busy: true });
  assert.equal(stageReducer(busy, { type: 'open', scene: { name: 'detail', item: item('second'), from: null } }), busy);
});

test('scanner and motion origins include the browser sidebar and top banner offsets', () => {
  assert.deepEqual(localPoint({ x: 600, y: 650 }, { x: 192, y: 28 }), { x: 408, y: 622 });
  assert.deepEqual(localPoint({ x: 200, y: 400 }, { x: 70, y: 28 }), { x: 130, y: 372 });
});
