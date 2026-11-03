import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { runMotion } from './motion.ts';
import type { MotionAnimation, MotionStyle } from './motion.ts';

// Load the actual pinned animation algorithms in Node. Only platform bridges
// are supplied here; timing, easing, spring, delay, sequence, color decoration
// and the app's steady clock are the unmodified production implementations.
const library = new URL('../../node_modules/react-native-reanimated/lib/module/', import.meta.url);
const moduleText = (source: string) => 'data:text/javascript,' + encodeURIComponent(source);
const reducedModule = moduleText('export const ReducedMotionManager={jsValue:false,uiValue:{value:false}};');
Object.assign(globalThis, { __DEV__: false, __RUNTIME_KIND: 0 });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react-native-reanimated') return {
      url: moduleText(`export { defineAnimation } from ${JSON.stringify(new URL('animation/util.js', library).href)}; export { Easing } from ${JSON.stringify(new URL('Easing.js', library).href)}; export { withSequence } from ${JSON.stringify(new URL('animation/sequence.js', library).href)}; export { withTiming } from ${JSON.stringify(new URL('animation/timing.js', library).href)};`), shortCircuit: true,
    };
    if (specifier === 'react-native-worklets') return {
      url: moduleText('export const RuntimeKind={ReactNative:1};export const createSerializable=x=>x;export const serializableMappingCache=new WeakMap();'), shortCircuit: true,
    };
    if (context.parentURL?.includes('/react-native-reanimated/')) {
      if (specifier.endsWith('/common/index.js')) return { url: moduleText('export const logger={warn(){},error(){}};export const IS_WINDOW_AVAILABLE=false;'), shortCircuit: true };
      if (/ReducedMotion$/.test(specifier)) return { url: reducedModule, shortCircuit: true };
      if (specifier.startsWith('.') && !specifier.endsWith('.js')) {
        const candidate = new URL(specifier + '.js', context.parentURL);
        if (existsSync(candidate)) return next(candidate.href, context);
      }
    }
    return next(specifier, context);
  },
});
const { withTiming } = await import(new URL('animation/timing.js', library).href);
const { withSpring } = await import(new URL('animation/spring/spring.js', library).href);
const { withDelay } = await import(new URL('animation/delay.js', library).href);
const { withSequence } = await import(new URL('animation/sequence.js', library).href);
const { ReducedMotionManager } = await import(reducedModule);
const { steady } = await import('../chicory/src/motion/steady.ts');
const { curves, springs } = await import('../chicory/src/motion/tokens.ts');

test('browser tracks match the native timing, spring, sequence and steady clocks frame for frame', () => {
  const make = () => ({
    opacity: steady(withDelay(80, withTiming(1, { duration: 160, easing: curves.standard }))) as MotionAnimation,
    shift: steady(withSpring(0, springs.pane)) as MotionAnimation,
    rotate: steady(withSequence(withTiming('90deg', { duration: 100 }), withTiming('0deg', { duration: 100 }))) as MotionAnimation,
  });
  const actual = make();
  const expected = make();
  expected.opacity.onStart(expected.opacity, 0, 0, null);
  expected.shift.onStart(expected.shift, 120, 0, null);
  expected.rotate.onStart(expected.rotate, '0deg', 0, null);
  let nextFrame: ((time: number) => void) | null = null;
  let latest: MotionStyle = {};
  let finished = 0;
  runMotion({
    initialValues: { opacity: 0, transform: [{ translateX: 120 }, { rotate: '0deg' }] },
    animations: { opacity: actual.opacity, transform: [{ translateX: actual.shift }, { rotate: actual.rotate }] },
    callback: done => { if (done) finished++; },
  }, style => { latest = style; }, {
    now: () => 0,
    request(callback) { nextFrame = callback; return 1; },
    cancel() { nextFrame = null; },
  });
  const done = { opacity: false, shift: false, rotate: false };
  const times = [16, 32, 80, 96, 400, ...Array.from({ length: 120 }, (_, i) => 416 + i * 16)];
  for (const now of times) {
    if (!nextFrame) break;
    const frame = nextFrame as (time: number) => void;
    nextFrame = null;
    frame(now);
    for (const key of ['opacity', 'shift', 'rotate'] as const) {
      if (!done[key]) done[key] = expected[key].onFrame(expected[key], now);
    }
    assert.equal(latest.opacity, expected.opacity.current);
    assert.equal((latest.transform as { translateX?: number }[])[0].translateX, expected.shift.current);
    assert.equal((latest.transform as { rotate?: string }[])[1].rotate, expected.rotate.current);
    if (now === 400) assert.ok(Number(latest.opacity) < 0.5, 'a long unpainted frame must not skip the delayed entrance');
  }
  assert.equal(finished, 1);
  assert.equal(latest.opacity, 1);
  assert.deepEqual(latest.transform, [{ translateX: 0 }, { rotate: '0deg' }]);
});

test('reduced-motion crossfades still run when movement is disabled by the system', () => {
  ReducedMotionManager.uiValue.value = true;
  ReducedMotionManager.jsValue = true;
  try {
    let frame: ((time: number) => void) | null = null;
    let painted: MotionStyle = {};
    let completed = 0;
    runMotion({
      initialValues: { opacity: 0, transform: [{ scale: 1 }] },
      animations: { opacity: withTiming(1, { duration: 160, easing: curves.standard, reduceMotion: 'never' }), transform: [{ scale: 1 }] },
      callback: done => { if (done) completed++; },
    }, style => { painted = style; }, {
      now: () => 0,
      request(callback) { frame = callback; return 1; },
      cancel() { frame = null; },
    });
    frame!(80);
    assert.ok(Number(painted.opacity) > 0 && Number(painted.opacity) < 1);
    assert.deepEqual(painted.transform, [{ scale: 1 }]);
    frame!(160);
    assert.equal(painted.opacity, 1);
    assert.equal(completed, 1);
  } finally {
    ReducedMotionManager.uiValue.value = false;
    ReducedMotionManager.jsValue = false;
  }
});

test('interrupted native springs retain velocity and the steady clock across browser layout changes', () => {
  let now = 0;
  let frame: ((time: number) => void) | null = null;
  let painted: MotionStyle = {};
  const scheduler = {
    now: () => now,
    request(callback: (time: number) => void) { frame = callback; return 1; },
    cancel() { frame = null; },
  };
  const firstNative = steady(withSpring(100, springs.pane)) as MotionAnimation;
  firstNative.onStart(firstNative, 0, 0, null);
  const first = runMotion({
    initialValues: { transform: [{ translateX: 0 }] },
    animations: { transform: [{ translateX: steady(withSpring(100, springs.pane)) }] },
  }, style => { painted = style; }, scheduler);
  for (const at of [16, 32, 48]) {
    now = at; frame!(at); firstNative.onFrame(firstNative, at);
  }
  const value = (painted.transform as { translateX: number }[])[0].translateX;
  assert.equal(value, firstNative.current);
  first.cancel();
  const secondNative = steady(withSpring(0, springs.pane)) as MotionAnimation;
  secondNative.onStart(secondNative, value, now, firstNative);
  runMotion({
    initialValues: { transform: [{ translateX: value }] },
    animations: { transform: [{ translateX: steady(withSpring(0, springs.pane)) }] },
  }, style => { painted = style; }, scheduler, { previous: first });
  for (const at of [64, 80, 160, 176]) {
    now = at; frame!(at); secondNative.onFrame(secondNative, at);
    assert.equal((painted.transform as { translateX: number }[])[0].translateX, secondNative.current);
  }
});
