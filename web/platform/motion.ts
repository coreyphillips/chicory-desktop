/**
 * Execute the animation objects produced by the pinned Reanimated runtime.
 * The browser and native app therefore use the same timing, spring, delay,
 * sequence and steady-clock calculations instead of approximating them in CSS.
 */
export type MotionStyle = Record<string, unknown>;
export interface MotionAnimation {
  onStart: (animation: MotionAnimation, value: unknown, now: number, previous: MotionAnimation | null) => void;
  onFrame: (animation: MotionAnimation, now: number) => boolean;
  current?: unknown;
  callback?: (finished: boolean) => void;
  finished?: boolean;
  cancelled?: boolean;
}
export interface MotionDescription {
  initialValues: MotionStyle;
  animations: MotionStyle;
  callback?: (finished: boolean) => void;
}
export interface MotionScheduler {
  now: () => number;
  request: (callback: (now: number) => void) => number;
  cancel: (id: number) => void;
}
export interface MotionController {
  cancel: () => void;
  animationAt: (path: (string | number)[]) => MotionAnimation | null;
}
type Branch = { path: (string | number)[]; animation: MotionAnimation; complete: boolean };

export function isCustomLayoutConfig(config: unknown): config is (values: Record<string, number>) => MotionDescription {
  // Predefined builders and Keyframe objects retain Reanimated's web path.
  return typeof config === 'function' &&
    !('presetName' in config) && !('build' in config);
}
export function isMotionAnimation(value: unknown): value is MotionAnimation {
  return !!value && typeof value === 'object' &&
    typeof (value as MotionAnimation).onStart === 'function' &&
    typeof (value as MotionAnimation).onFrame === 'function';
}
function valueAt(value: unknown, path: (string | number)[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
function cloneStyle(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneStyle);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneStyle(item)]));
  return value;
}
function assignAt(root: MotionStyle, path: (string | number)[], value: unknown): void {
  let into: Record<string | number, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!into[key] || typeof into[key] !== 'object') into[key] = typeof path[i + 1] === 'number' ? [] : {};
    into = into[key] as Record<string | number, unknown>;
  }
  into[path[path.length - 1]] = value;
}

/**
 * A callback is delivered once, either on completion or cancellation. An old
 * frame cannot mutate a replacement animation after its frame was cancelled.
 */
export function runMotion(
  description: MotionDescription,
  write: (style: MotionStyle) => void,
  scheduler: MotionScheduler,
  options: { base?: MotionStyle; previous?: MotionController; done?: (finished: boolean) => void } = {},
): MotionController {
  const branches: Branch[] = [];
  const style = cloneStyle(description.initialValues ?? {}) as MotionStyle;
  let frame: number | null = null;
  let ended = false;
  const start = scheduler.now();
  function visit(value: unknown, path: (string | number)[]) {
    if (typeof value === 'function') value = (value as () => unknown)();
    if (isMotionAnimation(value)) {
      const property = String(path[path.length - 1]);
      const fallback = property.startsWith('scale') || property === 'opacity' ? 1 : property.startsWith('rotate') || property.startsWith('skew') ? '0deg' : 0;
      const previous = options.previous?.animationAt(path) ?? null;
      const initial = valueAt(description.initialValues, path) ?? previous?.current ?? valueAt(options.base, path) ?? fallback;
      // Preserve native spring velocity and the app's steady clock when a
      // layout change interrupts another animation on the same property.
      value.onStart(value, initial, start, previous);
      branches.push({ path, animation: value, complete: false });
      assignAt(style, path, value.current ?? initial);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    } else assignAt(style, path, value);
  }
  const complete = (finished: boolean) => {
    if (ended) return;
    ended = true;
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
    let callbackError: unknown;
    if (!finished) for (const branch of branches) {
      if (branch.complete) continue;
      branch.complete = true;
      branch.animation.cancelled = true;
      try { branch.animation.callback?.(false); }
      catch (error) { callbackError ??= error; }
    }
    try { description.callback?.(finished); }
    finally { options.done?.(finished); }
    if (callbackError) throw callbackError;
  };
  const tick = (now: number) => {
    if (ended) return;
    try {
      let allDone = true;
      for (const branch of branches) {
        if (!branch.complete) {
          const done = branch.animation.onFrame(branch.animation, now);
          assignAt(style, branch.path, branch.animation.current);
          if (done) {
            branch.complete = true;
            branch.animation.finished = true;
            branch.animation.callback?.(true);
          }
        }
        if (!branch.complete) allDone = false;
      }
      write(cloneStyle(style) as MotionStyle);
      if (allDone) complete(true);
      else frame = scheduler.request(tick);
    } catch (error) {
      try { complete(false); }
      finally { throw error; }
    }
  };
  try {
    for (const [key, value] of Object.entries(description.animations ?? {})) visit(value, [key]);
    write(cloneStyle(style) as MotionStyle);
    frame = scheduler.request(tick);
  } catch (error) {
    complete(false);
    throw error;
  }
  return {
    cancel: () => complete(false),
    animationAt: path => branches.find(branch => branch.path.length === path.length && branch.path.every((key, index) => key === path[index]))?.animation ?? null,
  };
}
