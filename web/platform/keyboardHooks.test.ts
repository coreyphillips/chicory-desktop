import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { useBrowserHold } from './keyboardHold.ts';
import { useBrowserTap } from './keyboardTap.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const windowEvents = new Map<string, Set<() => void>>();
const documentEvents = new Map<string, Set<() => void>>();
const environment = {
  visibilityState: 'visible',
  addEventListener(name: string, listener: () => void) {
    const list = documentEvents.get(name) ?? new Set(); list.add(listener); documentEvents.set(name, list);
  },
  removeEventListener(name: string, listener: () => void) { documentEvents.get(name)?.delete(listener); },
};
Object.defineProperties(globalThis, {
  document: { configurable: true, value: environment },
  window: { configurable: true, value: {
    addEventListener(name: string, listener: () => void) {
      const list = windowEvents.get(name) ?? new Set(); list.add(listener); windowEvents.set(name, list);
    },
    removeEventListener(name: string, listener: () => void) { windowEvents.get(name)?.delete(listener); },
  } },
});
const roots = new Set<ReactTestRenderer>();
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); roots.clear(); });
  environment.visibilityState = 'visible';
});

function keyEvent(key: string) {
  const target = {};
  let prevented = 0;
  return {
    target, currentTarget: target, nativeEvent: { key },
    preventDefault: () => { prevented++; }, stopPropagation() {},
    prevented: () => prevented,
  };
}

async function hold() {
  let props!: Record<string, (...args: any[]) => any>;
  const counts = { begin: 0, cancel: 0, commit: 0, accessible: 0, capture: 0 };
  function Probe() {
    props = useBrowserHold({
      enabled: true, duration: 60000, maxDistance: 44,
      begin: () => { counts.begin++; return true; },
      cancel: () => { counts.cancel++; }, commit: () => { counts.commit++; },
      accessibleCommit: () => { counts.accessible++; },
    }) as unknown as typeof props;
    return null;
  }
  await act(async () => { const root = create(React.createElement(Probe)); roots.add(root); });
  return { props, counts };
}

test('hold keyboard handlers prevent default clicks and blur cancels before payment', async () => {
  const f = await hold();
  const down = keyEvent('Enter');
  f.props.onKeyDown(down);
  assert.equal(down.prevented(), 1);
  assert.equal(f.counts.begin, 1);
  f.props.onKeyUp(keyEvent('Enter'));
  f.props.onClick({ detail: 0, preventDefault() {} });
  assert.equal(f.counts.accessible, 0);
  assert.equal(f.counts.commit, 0);
  f.props.onKeyDown(keyEvent(' '));
  for (const listener of windowEvents.get('blur') ?? []) listener();
  assert.equal(f.counts.cancel, 2);
});

test('hold pointer input focuses and captures once and tab hiding or cancellation releases it', async () => {
  const f = await hold();
  const event = {
    pointerId: 7, button: 0, isPrimary: true, clientX: 10, clientY: 10,
    preventDefault() {}, currentTarget: { focus() {}, setPointerCapture() { f.counts.capture++; } },
  };
  f.props.onPointerDown({ ...event, isPrimary: false });
  assert.equal(f.counts.begin, 0);
  f.props.onPointerDown(event);
  assert.equal(f.counts.capture, 1);
  environment.visibilityState = 'hidden';
  for (const listener of documentEvents.get('visibilitychange') ?? []) listener();
  assert.equal(f.counts.cancel, 1);
  assert.equal(f.counts.commit, 0);
  environment.visibilityState = 'visible';
  f.props.onPointerDown(event);
  f.props.onPointerCancel();
  assert.equal(f.counts.cancel, 2);
});

test('ordinary button keyboard activation suppresses its virtual click and ignores nested key targets', async () => {
  let props!: Record<string, (...args: any[]) => any>;
  let activated = 0;
  function Probe() {
    props = useBrowserTap({ enabled: true, begin() {}, cancel() {}, activate() { activated++; } }) as unknown as typeof props;
    return null;
  }
  await act(async () => { const root = create(React.createElement(Probe)); roots.add(root); });
  props.onKeyDown({ ...keyEvent('Enter'), target: {} });
  assert.equal(activated, 0);
  props.onKeyDown(keyEvent('Enter'));
  props.onClick({ detail: 0 });
  assert.equal(activated, 1);
  props.onKeyUp(keyEvent('Enter'));
});
