import assert from 'node:assert/strict';
import test from 'node:test';
import { isCustomLayoutConfig, runMotion } from './motion.ts';
import type { MotionAnimation, MotionScheduler, MotionStyle } from './motion.ts';

function clock() {
  let now = 0;
  let serial = 0;
  const pending = new Map<number, (at: number) => void>();
  const history: ((at: number) => void)[] = [];
  const scheduler: MotionScheduler = {
    now: () => now,
    request(callback) { const id = ++serial; pending.set(id, callback); history.push(callback); return id; },
    cancel(id) { pending.delete(id); },
  };
  return {
    scheduler, history,
    advance(at: number) { now = at; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(at)); },
    pending: () => pending.size,
  };
}
function timing(to: number, duration: number, callback?: (finished: boolean) => void): MotionAnimation {
  let start = 0;
  let from = 0;
  return {
    current: to, callback,
    onStart(self, value, now) { from = Number(value); start = now; self.current = value; },
    onFrame(self, now) {
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      self.current = from + (to - from) * progress;
      return progress === 1;
    },
  };
}

test('custom callbacks are distinguished from Reanimated presets and Keyframes', () => {
  const custom = () => ({ initialValues: {}, animations: {} });
  const preset = Object.assign(() => {}, { presetName: 'FadeIn' });
  const builder = Object.assign(() => {}, { build: () => custom });
  assert.equal(isCustomLayoutConfig(custom), true);
  assert.equal(isCustomLayoutConfig(preset), false);
  assert.equal(isCustomLayoutConfig(builder), false);
  assert.equal(isCustomLayoutConfig({ definitions: { 0: {}, 100: {} } }), false);
});

test('the native animation object receives the real clock and initial transform values', () => {
  const time = clock();
  const frames: MotionStyle[] = [];
  const finished: boolean[] = [];
  runMotion({
    initialValues: { opacity: 0, transform: [{ translateY: 24 }, { scale: 0.8 }] },
    animations: { opacity: timing(1, 100), transform: [{ translateY: timing(0, 200) }, { scale: timing(1, 100) }] },
    callback: value => finished.push(value),
  }, frame => frames.push(frame), time.scheduler);
  time.advance(50);
  assert.deepEqual(frames.at(-1), { opacity: 0.5, transform: [{ translateY: 18 }, { scale: 0.9 }] });
  time.advance(100);
  assert.deepEqual(finished, []);
  time.advance(200);
  assert.deepEqual(frames.at(-1), { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] });
  assert.deepEqual(finished, [true]);
  assert.equal(time.pending(), 0);
  assert.deepEqual(frames[0], { opacity: 0, transform: [{ translateY: 24 }, { scale: 0.8 }] });
});

test('spring completion follows its native rest condition instead of an estimated duration', () => {
  const time = clock();
  let atRest = false;
  const observed: number[] = [];
  const spring: MotionAnimation = {
    onStart(self, value) { self.current = value; },
    onFrame(self, now) { observed.push(now); self.current = atRest ? 1 : 1.1; return atRest; },
  };
  const done: boolean[] = [];
  runMotion({ initialValues: { opacity: 0 }, animations: { opacity: spring }, callback: value => done.push(value) }, () => {}, time.scheduler);
  time.advance(16); time.advance(250); time.advance(1200);
  assert.deepEqual(done, []);
  atRest = true;
  time.advance(1234);
  assert.deepEqual(observed, [16, 250, 1200, 1234]);
  assert.deepEqual(done, [true]);
});

test('higher-order delay and sequence callbacks run during playback, never while preparing frames', () => {
  const time = clock();
  const events: string[] = [];
  const nativeSequence: MotionAnimation = {
    onStart(self) { self.current = 0; },
    onFrame(self, now) {
      if (now < 80) { self.current = 0; return false; }
      if (now < 160) { self.current = 1; events.push('first step'); return false; }
      self.current = 2; events.push('second step'); return true;
    },
    callback: finished => events.push(`sequence ${finished}`),
  };
  runMotion({ initialValues: { opacity: 0 }, animations: { opacity: nativeSequence }, callback: finished => events.push(`layout ${finished}`) }, () => {}, time.scheduler);
  assert.deepEqual(events, []);
  time.advance(40);
  assert.deepEqual(events, []);
  time.advance(100);
  assert.deepEqual(events, ['first step']);
  time.advance(170);
  assert.deepEqual(events, ['first step', 'second step', 'sequence true', 'layout true']);
});

test('cancellation interrupts unfinished leaves once and stale frames cannot write', () => {
  const time = clock();
  const events: string[] = [];
  const frames: MotionStyle[] = [];
  const controller = runMotion({
    initialValues: { opacity: 0, width: 0 },
    animations: {
      opacity: timing(1, 10, done => events.push(`opacity ${done}`)),
      width: timing(100, 100, done => events.push(`width ${done}`)),
    },
    callback: done => events.push(`layout ${done}`),
  }, style => frames.push(style), time.scheduler, { done: done => events.push(`cleanup ${done}`) });
  time.advance(10);
  controller.cancel(); controller.cancel();
  const last = structuredClone(frames.at(-1));
  time.history.at(-1)!(500);
  assert.deepEqual(frames.at(-1), last);
  assert.deepEqual(events, ['opacity true', 'width false', 'layout false', 'cleanup false']);
  assert.equal(time.pending(), 0);
});

test('a replacement timeline cannot be changed by the cancelled timeline', () => {
  const time = clock();
  let painted = 0;
  const first = runMotion({ initialValues: { opacity: 0 }, animations: { opacity: timing(1, 100) } }, style => { painted = Number(style.opacity); }, time.scheduler);
  time.advance(30);
  const stale = time.history.at(-1)!;
  first.cancel();
  runMotion({ initialValues: { opacity: painted }, animations: { opacity: timing(0, 50) } }, style => { painted = Number(style.opacity); }, time.scheduler);
  time.advance(55);
  const newer = painted;
  stale(200);
  assert.equal(painted, newer);
  time.advance(80);
  assert.equal(painted, 0);
});

test('instant reduced-motion poses and constant properties keep their declared shape', () => {
  const time = clock();
  const frames: MotionStyle[] = [];
  const done: boolean[] = [];
  runMotion({
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: 1, transform: [{ scale: 1 }], backgroundColor: '#ffeecc' },
    callback: finished => done.push(finished),
  }, style => frames.push(style), time.scheduler);
  time.advance(16);
  assert.deepEqual(frames.at(-1), { opacity: 1, transform: [{ scale: 1 }], backgroundColor: '#ffeecc' });
  assert.deepEqual(done, [true]);
});

test('initialization failures cancel started leaves and still release retained DOM', () => {
  const time = clock();
  const events: boolean[] = [];
  assert.throws(() => runMotion({
    initialValues: { opacity: 0, width: 0 },
    animations: {
      opacity: timing(1, 100, done => events.push(done)),
      width: { onStart() { throw new Error('invalid native animation'); }, onFrame() { return false; } },
    },
  }, () => {}, time.scheduler, { done: done => events.push(done) }), /invalid native animation/);
  assert.deepEqual(events, [false, false]);
  assert.equal(time.pending(), 0);
});

test('frame errors release retained DOM and report cancellation exactly once', () => {
  const time = clock();
  const callbacks: boolean[] = [];
  runMotion({
    initialValues: { opacity: 0 },
    animations: { opacity: {
      onStart() {}, onFrame() { throw new Error('frame failed'); },
      callback: value => callbacks.push(value),
    } },
    callback: value => callbacks.push(value),
  }, () => {}, time.scheduler, { done: value => callbacks.push(value) });
  assert.throws(() => time.advance(16), /frame failed/);
  assert.deepEqual(callbacks, [false, false, false]);
  assert.equal(time.pending(), 0);
});

test('a failing cancellation callback cannot leave retained DOM behind', () => {
  const time = clock();
  let cleaned = false;
  const controller = runMotion({
    initialValues: { opacity: 0 },
    animations: { opacity: timing(1, 100, () => { throw new Error('callback failed'); }) },
  }, () => {}, time.scheduler, { done: () => { cleaned = true; } });
  assert.throws(() => controller.cancel(), /callback failed/);
  assert.equal(cleaned, true);
  assert.equal(time.pending(), 0);
});
