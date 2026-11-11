import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { registerHooks } from 'node:module';
import React from 'react';
import type { SetStateAction } from 'react';
import { act, create } from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Each launch loads the hook and the desktop keychain afresh, as a relaunched
// renderer does, over the same browser storage.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== 'react-native-keychain') return next(specifier, context);
    const launch = new URL(context.parentURL ?? import.meta.url).search;
    return next(new URL(`./keychain.ts${launch}`, import.meta.url).href, context);
  },
});

const KEY = 'chicory:public-preference:com.beignet.wallet.balance-visibility';
let entries: Map<string, string>;
let writes: string[];
beforeEach(() => {
  entries = new Map();
  writes = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return entries.size; },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === KEY) writes.push(JSON.parse(value).password);
      entries.set(key, value);
    },
    removeItem: (key: string) => { entries.delete(key); },
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { chicoryDesktop: {} } });
});

let launches = 0;
type Setter = (action: SetStateAction<boolean>) => void;
async function launch() {
  const { useBalanceVisibility } = await import(`../chicory/src/services/useBalanceVisibility.ts?launch=${++launches}`);
  const seen: boolean[] = [];
  let setHidden!: Setter;
  function Probe() {
    const [hidden, set] = useBalanceVisibility();
    seen.push(hidden);
    setHidden = set;
    return null;
  }
  let root!: ReactTestRenderer;
  await act(async () => { root = create(React.createElement(Probe)); });
  return {
    seen,
    toggle: (times = 1) => act(async () => {
      for (let i = 0; i < times; i++) setHidden(value => !value);
    }),
    quit: () => act(async () => root.unmount()),
    get now() { return seen.at(-1); },
  };
}
const saved = () => {
  const raw = entries.get(KEY);
  return raw ? JSON.parse(raw).password : undefined;
};

test('the first frame is masked, then a wallet with nothing saved shows its balance', async () => {
  const app = await launch();
  assert.equal(app.seen[0], true);
  assert.equal(app.now, false);
  await app.quit();
});

test('a hidden balance stays hidden on every frame after quitting and reopening', async () => {
  const first = await launch();
  await first.toggle();
  assert.equal(first.now, true);
  assert.equal(saved(), 'hidden');
  await first.quit();

  const reopened = await launch();
  assert.deepEqual([...new Set(reopened.seen)], [true]);
  await reopened.toggle();
  assert.equal(reopened.now, false);
  assert.equal(saved(), 'visible');
  await reopened.quit();

  const again = await launch();
  assert.equal(again.now, false);
  await again.quit();
});

test('a damaged preference stays masked until it is deliberately revealed', async () => {
  entries.set(KEY, JSON.stringify({
    username: 'balance-visibility', password: 'damaged', service: 'com.beignet.wallet.balance-visibility',
  }));
  const app = await launch();
  assert.deepEqual([...new Set(app.seen)], [true]);
  await app.toggle();
  assert.equal(app.now, false);
  assert.equal(saved(), 'visible');
  await app.quit();
});

test('quick toggles are saved in the order they were made', async () => {
  const app = await launch();
  await app.toggle(3);
  assert.equal(app.now, true);
  assert.deepEqual(writes, ['hidden', 'visible', 'hidden']);
  assert.equal(saved(), 'hidden');
  await app.quit();
});
