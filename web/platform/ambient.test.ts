import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AMBIENT_REST_MS, useAmbientRest, wakeAmbient } from '../chicory/src/motion/ambient.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

for (const jump of [-3600000, 3600000]) {
  test(`decoration rests on time when the system clock jumps by ${jump} ms`, async t => {
    let elapsed = 0;
    t.mock.method(performance, 'now', () => elapsed);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000_000 });
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useAmbientRest());
      return null;
    }
    async function advance(ms: number) {
      elapsed += ms;
      await act(() => t.mock.timers.tick(ms));
    }
    wakeAmbient();
    let root!: ReactTestRenderer;
    await act(() => { root = create(React.createElement(Probe)); });
    try {
      await advance(AMBIENT_REST_MS / 2);
      wakeAmbient();
      // Move only the wall clock. Timer delivery still follows elapsed time.
      const wall = Date.now() - elapsed + jump;
      t.mock.method(Date, 'now', () => wall + elapsed);
      await advance(AMBIENT_REST_MS - 1);
      assert.equal(seen.at(-1), false);
      await advance(1);
      assert.equal(seen.at(-1), true);
      await act(wakeAmbient);
      assert.equal(seen.at(-1), false);
    } finally {
      await act(() => root.unmount());
    }
  });
}
