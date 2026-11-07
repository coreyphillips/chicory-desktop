import assert from 'node:assert/strict';
import test from 'node:test';
import { swapScene } from './sceneSwap.ts';

const settled = () => ({ ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: Promise.resolve() });
const direct = (run: () => void) => run();

function page() {
  const held: (() => void)[] = [];
  return { held, startViewTransition(update: () => void) { held.push(update); return settled(); } };
}

test('a swap with no view transitions is a plain update, at once', () => {
  let ran = 0;
  swapScene(() => { ran += 1; }, {}, direct);
  assert.equal(ran, 1);
  swapScene(() => { ran += 1; }, undefined, direct);
  assert.equal(ran, 2);
});

test('the update waits for the frame the transition holds, inside one commit', () => {
  const at = page();
  const commits: string[] = [];
  let ran = false;
  swapScene(() => { ran = true; }, at, run => { commits.push('commit'); run(); });
  assert.equal(ran, false, 'nothing changes before the old frame is captured');
  at.held[0]();
  assert.equal(ran, true);
  assert.deepEqual(commits, ['commit']);
});

test('a swap that comes before the frame joins it in order', () => {
  const at = page();
  const order: number[] = [];
  swapScene(() => order.push(1), at, direct);
  swapScene(() => order.push(2), at, direct);
  assert.equal(at.held.length, 1, 'only one transition starts');
  at.held[0]();
  assert.deepEqual(order, [1, 2]);
  swapScene(() => order.push(3), at, direct);
  assert.equal(at.held.length, 2, 'the next swap starts its own');
  at.held[1]();
  assert.deepEqual(order, [1, 2, 3]);
});

test('the page is marked only while a transition runs, however many overlap', async () => {
  const dataset: Record<string, string> = {};
  const ends: (() => void)[] = [];
  const at = {
    documentElement: { dataset },
    startViewTransition(update: () => void) {
      update();
      return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: new Promise<void>(end => { ends.push(end); }) };
    },
  };
  swapScene(() => {}, at, direct);
  swapScene(() => {}, at, direct);
  assert.equal(dataset.swapping, 'true');
  ends[0]();
  await new Promise(done => setTimeout(done, 0));
  assert.equal(dataset.swapping, 'true', 'the newer transition still runs');
  ends[1]();
  await new Promise(done => setTimeout(done, 0));
  assert.equal(dataset.swapping, undefined);
});

test('a skipped transition still updates and raises nothing', async () => {
  let ran = false;
  const skipped = {
    startViewTransition(update: () => void) {
      update();
      const refused = Promise.reject(new DOMException('Transition was skipped', 'AbortError'));
      return { ready: refused, updateCallbackDone: Promise.resolve(), finished: Promise.resolve() };
    },
  };
  swapScene(() => { ran = true; }, skipped, direct);
  await new Promise(done => setTimeout(done, 0));
  assert.equal(ran, true);
});
