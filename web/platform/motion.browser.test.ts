import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { restingRect, runCustomWebAnimation, runCustomWebLayout, skipExits } from './motion.browser.ts';
import { chicoryMotion } from './motion.vite.ts';
import type { MotionAnimation } from './motion.ts';

class Element extends EventTarget {
  style: Record<string, string> = { opacity: '', transform: '', visibility: '', animation: '' };
  attributes = new Map<string, string>();
  children: Element[] = [];
  parentElement: Element | null = null;
  offsetParent: Element | null = null;
  scrollTop = 0;
  scrollLeft = 0;
  isDummy?: boolean;
  dummyClone?: Element;
  removedAfterAnimation?: boolean;
  canvas: Element | null = null;
  rect = { top: 20, left: 40, width: 100, height: 50 };
  root = false;
  onanimationend: (() => void) | null = null;
  get firstChild() { return this.children[0] ?? null; }
  get isConnected(): boolean { return this.root || this.parentElement?.isConnected === true; }
  appendChild(child: Element) {
    child.parentElement?.removeChild(child);
    this.children.push(child); child.parentElement = this; return child;
  }
  removeChild(child: Element) { this.children = this.children.filter(item => item !== child); child.parentElement = null; return child; }
  remove() { this.parentElement?.removeChild(this); }
  closest() { return this.canvas; }
  querySelectorAll(): Element[] { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  cloneNode() { const copy = new Element(); copy.style = { ...this.style }; copy.rect = { ...this.rect }; copy.canvas = this.canvas; return copy; }
  getBoundingClientRect() { return { ...this.rect }; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  override dispatchEvent(event: Event) {
    if (event.type === 'animationend') this.onanimationend?.();
    return super.dispatchEvent(event);
  }
}
function environment() {
  const original = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  let serial = 0;
  const pending = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = callback => { pending.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => { pending.delete(id); };
  globalThis.getComputedStyle = ((element: Element) => ({ opacity: element.style.opacity || '1', borderRadius: '0', backgroundColor: 'rgb(0, 0, 0)', borderLeftWidth: '0', borderTopWidth: '0' })) as never;
  globalThis.window = { innerWidth: 1440, innerHeight: 900 } as never;
  const parent = new Element(); parent.root = true; parent.rect = { top: 10, left: 15, width: 900, height: 700 };
  const canvas = new Element(); canvas.rect = { top: 0, left: 0, width: 720, height: 640 };
  const source = new Element(); source.offsetParent = parent; source.canvas = canvas; parent.appendChild(source);
  return {
    source, parent, canvas,
    frame() { const all = [...pending.values()]; pending.clear(); all.forEach(callback => callback(performance.now() + 1000)); },
    pending: () => pending.size,
    restore() { Object.assign(globalThis, original); },
  };
}
function instant(value: number): MotionAnimation {
  return { onStart(self, initial) { self.current = initial; }, onFrame(self) { self.current = value; return true; } };
}

test('custom entrances use canvas bounds and restore only their own inline styles', () => {
  const env = environment();
  try {
    const source = env.source as unknown as HTMLElement;
    let measured: Record<string, number> = {};
    assert.equal(runCustomWebAnimation({ entering: (values: Record<string, number>) => {
      measured = values;
      return { initialValues: { opacity: 0, transform: [{ translateY: 20 }] }, animations: { opacity: instant(1), transform: [{ translateY: instant(0) }] } };
    } }, source, 1), true);
    assert.equal(measured.windowWidth, 720);
    assert.equal(measured.windowHeight, 640);
    assert.equal(measured.targetOriginX, 25);
    assert.equal(env.source.style.transform, 'translateY(20px)');
    env.frame();
    assert.equal(env.source.style.opacity, '');
    assert.equal(env.source.style.transform, '');
    assert.equal(env.source.style.visibility, 'initial');
    assert.equal(env.pending(), 0);
  } finally { env.restore(); }
});

test('custom exits retain inert DOM until actual completion and provide native observer snapshots', () => {
  const env = environment();
  try {
    const child = new Element(); child.scrollTop = 17; env.source.appendChild(child);
    const snapshots = new WeakMap();
    const completed: boolean[] = [];
    runCustomWebAnimation({ exiting: () => ({ initialValues: { opacity: 1 }, animations: { opacity: instant(0) }, callback: done => completed.push(done) }) }, env.source as never, 2, snapshots);
    const clone = env.source.dummyClone!;
    assert.equal(clone.isDummy, true);
    assert.equal(clone.attributes.get('aria-hidden'), 'true');
    assert.equal(clone.attributes.has('inert'), true);
    assert.equal(clone.style.pointerEvents, 'none');
    assert.equal(clone.firstChild, child);
    assert.equal(child.scrollTop, 17);
    assert.equal(snapshots.get(clone).width, 100);
    assert.equal(clone.style.left, '25px');
    env.parent.removeChild(env.source);
    assert.equal(clone.isConnected, true);
    env.frame();
    assert.deepEqual(completed, [true]);
    assert.equal(clone.isConnected, false);
    assert.equal(clone.removedAfterAnimation, true);
    assert.equal(env.source.dummyClone, undefined);
    assert.equal(env.source.firstChild, child);
  } finally { env.restore(); }
});

test('removing an entering-only view cancels callbacks instead of completing them later', () => {
  const env = environment();
  try {
    const completed: boolean[] = [];
    runCustomWebAnimation({ entering: () => ({ initialValues: { opacity: 0 }, animations: { opacity: instant(1) }, callback: done => completed.push(done) }) }, env.source as never, 1);
    env.source.remove(); env.frame(); env.frame();
    assert.deepEqual(completed, [false]);
    assert.equal(env.pending(), 0);
  } finally { env.restore(); }
});

test('a custom exit cancels an in-progress entry once and native retention cleanup can chain', () => {
  const env = environment();
  try {
    const events: string[] = [];
    runCustomWebAnimation({ entering: () => ({ initialValues: { opacity: 0 }, animations: { opacity: instant(1) }, callback: done => events.push(`enter ${done}`) }) }, env.source as never, 1);
    runCustomWebAnimation({ exiting: () => ({ initialValues: { opacity: 1 }, animations: { opacity: instant(0) }, callback: done => events.push(`exit ${done}`) }) }, env.source as never, 2);
    const clone = env.source.dummyClone!;
    const own = clone.onanimationend;
    clone.onanimationend = () => { events.push('native ancestor cleanup'); own?.(); };
    env.frame(); env.frame();
    assert.deepEqual(events, ['enter false', 'exit true', 'native ancestor cleanup']);
    assert.equal(env.parent.children.includes(clone), false);
  } finally { env.restore(); }
});

test('custom layout callbacks receive current and target geometry and retain flex flow', () => {
  const env = environment();
  try {
    let measured: Record<string, number> = {};
    const before = { left: 10, top: 15, width: 80, height: 40 };
    runCustomWebLayout({ layout: (values: Record<string, number>) => {
      measured = values;
      return {
        initialValues: { originX: values.currentOriginX, width: values.currentWidth },
        animations: { originX: instant(values.targetOriginX), width: instant(values.targetWidth) },
      };
    } }, env.source as never, before);
    assert.equal(measured.currentOriginX, -5);
    assert.equal(measured.targetOriginX, 25);
    assert.equal(env.source.style.transform, 'translateX(-30px)');
    assert.equal(env.source.style.position, undefined);
    env.frame();
    assert.equal(env.source.style.width, '');
    assert.equal(env.source.style.transform, '');
  } finally { env.restore(); }
});

const fading = () => ({ initialValues: { opacity: 1 }, animations: { opacity: instant(0) } });

test('a config that skips exits lets its views go at once, leaving nothing behind', () => {
  const env = environment();
  try {
    skipExits(env.parent, true);
    assert.equal(runCustomWebAnimation({ exiting: fading } as never, env.source as never, 2), true);
    assert.equal(env.source.dummyClone, undefined);
    assert.equal(env.parent.children.length, 1);
    assert.equal(env.pending(), 0);
  } finally { env.restore(); }
});
test('a config that keeps exits, or holds no view, skips nothing', () => {
  const env = environment();
  try {
    skipExits(env.parent, false);
    skipExits(null, true);
    skipExits(undefined, true);
    runCustomWebAnimation({ exiting: fading } as never, env.source as never, 2);
    assert.ok(env.source.dummyClone);
  } finally { env.restore(); }
});
test('an animated view is marked by the element it drew', () => {
  const env = environment();
  try {
    skipExits({ _componentDOMRef: env.source }, true);
    runCustomWebAnimation({ exiting: fading } as never, env.source as never, 2);
    assert.equal(env.source.dummyClone, undefined);
  } finally { env.restore(); }
});
test('skipping exits leaves an entrance alone', () => {
  const env = environment();
  try {
    skipExits(env.parent, true);
    runCustomWebAnimation({ entering: fading } as never, env.source as never, 1);
    assert.equal(env.pending(), 1);
  } finally { env.restore(); }
});

const config = 'node_modules/react-native-reanimated/lib/module/component/LayoutAnimationConfig.js';
const transform = chicoryMotion().transform as unknown as (code: string, id: string) => string | null;

const rise = (distance: number) => (() => ({
  initialValues: { opacity: 0, transform: [{ translateY: distance }] },
  animations: { opacity: instant(1), transform: [{ translateY: instant(0) }] },
}));
// The box follows the pose it is held in, as a browser's does.
const posed = (element: Element, top: number, ...around: Element[]) => {
  element.getBoundingClientRect = () => {
    const offset = [element, ...around].reduce((sum, item) => sum + Number(/translateY\((-?\d+)/.exec(item.style.transform)?.[1] ?? 0), 0);
    return { ...element.rect, top: top + offset };
  };
};

test('a view is read where it comes to rest, while the entrances around it wait to start', () => {
  const env = environment();
  try {
    const outer = env.source;
    const inner = new Element(); inner.offsetParent = env.parent; inner.canvas = env.canvas; outer.appendChild(inner);
    const control = new Element(); inner.appendChild(control);
    runCustomWebAnimation({ entering: rise(12) }, outer as unknown as HTMLElement, 1);
    runCustomWebAnimation({ entering: rise(12) }, inner as unknown as HTMLElement, 1);
    posed(control, 706, inner, outer);
    assert.equal(control.getBoundingClientRect().top, 730);
    assert.equal(restingRect(control as unknown as HTMLElement).top, 706);
    // Nothing painted differently: both poses are back as they were.
    assert.equal(outer.style.transform, 'translateY(12px)');
    assert.equal(inner.style.transform, 'translateY(12px)');
    assert.equal(control.getBoundingClientRect().top, 730);
  } finally { env.restore(); }
});
test('a view with nothing entering around it is read as it stands', () => {
  const env = environment();
  try {
    // A pose that is not an entrance, such as a pane on its spring, still counts.
    env.source.style.transform = 'translateY(40px)';
    const control = new Element(); env.source.appendChild(control);
    posed(control, 100, env.source);
    assert.equal(restingRect(control as unknown as HTMLElement).top, 140);
    assert.equal(env.source.style.transform, 'translateY(40px)');
  } finally { env.restore(); }
});
test('an entrance stops counting once it ends, and if an exit takes over', () => {
  const env = environment();
  try {
    const source = env.source as unknown as HTMLElement;
    runCustomWebAnimation({ entering: rise(12) }, source, 1);
    assert.equal(env.source.hasAttribute('data-chicory-motion-enter'), true);
    env.frame();
    assert.equal(env.source.hasAttribute('data-chicory-motion-enter'), false);

    runCustomWebAnimation({ entering: rise(12) }, source, 1);
    runCustomWebAnimation({ exiting: rise(12) }, source, 2);
    assert.equal(env.source.hasAttribute('data-chicory-motion-enter'), false);
  } finally { env.restore(); }
});
test('the rewrite fits the installed Reanimated, and a version that no longer does stops the build', () => {
  const code = transform(readFileSync(config, 'utf8'), `/app/${config}`);
  assert.match(code ?? '', /setShouldAnimateExiting\(\) \{\n {4}skipExits\(this\._childInstance, this\.props\.skipExiting\);/);
  assert.match(code ?? '', /^import \{ skipExits \} from /);
  assert.throws(() => transform('export default 1;', `/app/${config}`), /needs review/);
});
