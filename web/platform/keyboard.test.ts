import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amountKey, createHoldInput, createTapInput, editableTarget, holdKey,
} from './keyboard.ts';
import type { HoldScheduler } from './keyboard.ts';

function fixture(duration = 700) {
  let now = 0;
  let live = true;
  let began = 0;
  let cancelled = 0;
  let committed = 0;
  let identifier = 0;
  const queued = new Map<number, { at: number; call: () => void }>();
  const scheduler: HoldScheduler = {
    now: () => now,
    set: (call, delay) => {
      const id = ++identifier;
      queued.set(id, { at: now + delay, call });
      return id;
    },
    clear: id => { queued.delete(id as number); },
  };
  const input = createHoldInput({
    duration: () => duration,
    live: () => live,
    begin: () => { began++; return true; },
    cancel: () => { cancelled++; },
    commit: () => { committed++; },
  }, scheduler);
  const tick = (milliseconds: number) => {
    now += milliseconds;
    const due = [...queued.entries()].filter(([, entry]) => entry.at <= now);
    for (const [id, entry] of due) {
      if (!queued.has(id)) continue;
      queued.delete(id); entry.call();
    }
  };
  return {
    input, queued, tick,
    hide: () => { live = false; },
    counts: () => ({ began, cancelled, committed }),
  };
}

test('digits and backspace are accepted without intercepting browser shortcuts or composition', () => {
  assert.equal(amountKey({ key: '7' }), '7');
  assert.equal(amountKey({ key: 'Backspace' }), 'back');
  for (const event of [
    { key: '7', ctrlKey: true }, { key: '7', metaKey: true },
    { key: '7', altKey: true }, { key: '7', isComposing: true },
    { key: '.' }, { key: '-' }, { key: 'Enter' }, { key: ' ' },
  ]) assert.equal(amountKey(event), null);
  assert.equal(holdKey({ key: 'Enter', shiftKey: true }), null);
});

test('editable fields keep their text input, including contenteditable descendants', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(editableTarget({ tagName }), true);
  assert.equal(editableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(editableTarget({ tagName: 'SPAN', closest: () => ({}) }), true);
  assert.equal(editableTarget({ tagName: 'DIV', closest: () => null }), false);
  assert.equal(editableTarget(null), false);
});

test('a short Enter or Space press never commits a payment', () => {
  for (const key of ['Enter', ' ']) {
    const f = fixture();
    assert.equal(f.input.keyDown({ key }), true);
    f.tick(699);
    f.input.keyUp({ key });
    f.tick(1000);
    assert.deepEqual(f.counts(), { began: 1, cancelled: 1, committed: 0 });
  }
});

test('key repeat neither restarts the hold nor commits twice after the threshold', () => {
  const f = fixture();
  f.input.keyDown({ key: ' ' });
  f.tick(300);
  f.input.keyDown({ key: ' ', repeat: true });
  f.tick(400);
  assert.deepEqual(f.counts(), { began: 1, cancelled: 0, committed: 1 });
  f.input.keyDown({ key: ' ', repeat: true });
  f.input.keyUp({ key: ' ' });
  f.input.keyDown({ key: ' ' });
  f.tick(2000);
  assert.equal(f.counts().committed, 1);
});

test('warning confirmations require the full longer duration', () => {
  const f = fixture(1000);
  f.input.keyDown({ key: 'Enter' });
  f.tick(700); assert.equal(f.counts().committed, 0);
  f.tick(299); assert.equal(f.counts().committed, 0);
  f.tick(1); assert.equal(f.counts().committed, 1);
});

test('release with changed modifiers and a modifier shortcut both cancel the held key', () => {
  const f = fixture();
  f.input.keyDown({ key: 'Enter' });
  f.tick(100);
  f.input.keyUp({ key: 'Enter', shiftKey: true });
  f.tick(1000);
  assert.equal(f.counts().committed, 0);
  f.input.keyDown({ key: ' ' });
  f.input.keyDown({ key: 'Control', ctrlKey: true });
  f.tick(1000);
  assert.equal(f.counts().cancelled, 2);
});

test('blur, hidden tabs, disabled controls and stale queued timers cannot complete a hold', () => {
  const f = fixture();
  f.input.pointerDown(1, 10, 10);
  const queued = [...f.queued.values()][0].call;
  f.input.cancel();
  f.tick(1000); queued();
  assert.equal(f.counts().committed, 0);
  f.input.keyDown({ key: ' ' });
  f.hide(); f.tick(1000);
  assert.equal(f.counts().committed, 0);
  assert.equal(f.counts().cancelled, 2);
});

test('a second pointer or key cannot take over an active hold', () => {
  const f = fixture();
  assert.equal(f.input.pointerDown(3, 50, 50), true);
  assert.equal(f.input.pointerDown(4, 50, 50), false);
  f.input.keyDown({ key: 'Enter' });
  f.input.pointerUp(4);
  f.tick(700);
  assert.deepEqual(f.counts(), { began: 1, cancelled: 0, committed: 1 });
});

test('pointer movement beyond native tolerance cancels and old timers cannot affect a new hold', () => {
  const f = fixture();
  f.input.pointerDown(1, 50, 50);
  const old = [...f.queued.values()][0].call;
  f.input.pointerMove(1, 80, 80);
  assert.equal(f.counts().cancelled, 0);
  f.input.pointerMove(1, 95, 50);
  assert.equal(f.counts().cancelled, 1);
  f.input.pointerDown(2, 1, 1);
  old();
  assert.equal(f.counts().committed, 0);
  f.tick(700);
  assert.equal(f.counts().committed, 1);
});

test('an early timer does not shorten the required hold and a reset allows only a fresh hold', () => {
  const f = fixture();
  f.input.keyDown({ key: ' ' });
  [...f.queued.values()][0].call();
  assert.equal(f.counts().committed, 0);
  f.input.reset();
  f.tick(1000);
  assert.equal(f.counts().committed, 0);
  f.input.keyDown({ key: 'Enter' });
  f.tick(700);
  assert.equal(f.counts().committed, 1);
});

test('handled hold keys suppress their browser virtual clicks after early release', () => {
  const f = fixture();
  assert.equal(f.input.suppressClick(), false);
  f.input.keyDown({ key: 'Enter' });
  assert.equal(f.input.suppressClick(), true);
  f.input.keyUp({ key: 'Enter' });
  assert.equal(f.input.suppressClick(), true);
  f.tick(101);
  assert.equal(f.input.suppressClick(), false);
});

test('ordinary buttons use Enter on press and Space on release without repeated activation', () => {
  let count = 0;
  let time = 0;
  const input = createTapInput({ live: () => true, begin() {}, cancel() {}, activate() { count++; } }, () => time);
  input.keyDown({ key: 'Enter' });
  input.keyDown({ key: 'Enter', repeat: true });
  assert.equal(count, 1);
  assert.equal(input.suppressClick(), true);
  input.keyUp({ key: 'Enter' });
  time += 101;
  assert.equal(input.suppressClick(), false);
  input.keyDown({ key: ' ' });
  assert.equal(count, 1);
  input.keyUp({ key: ' ' });
  assert.equal(count, 2);
  input.keyDown({ key: ' ' }); input.cancel(); input.keyUp({ key: ' ' });
  assert.equal(count, 2);
});
