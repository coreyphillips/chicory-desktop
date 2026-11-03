import { defineAnimation } from 'react-native-reanimated';

/*
 * Motion that is seen whole, however long a frame takes to paint.
 *
 * An animation counts time by the frames' own clock, so a frame that takes
 * 250ms to paint, as the one that mounts a scene can, moves everything
 * 250ms along at once: a move is half done by the first frame anyone sees
 * of it, a 160ms crossfade is over before it shows, and a beat of the
 * canvas's build falls before the canvas is on screen. A steady animation
 * counts only painted frames, each at most FRAME_CAP_MS, so after a long
 * frame it carries on from where it was seen rather than from where the
 * clock says it would be. At a steady frame rate it runs exactly as the
 * animation it wraps.
 */

/** The most one painted frame moves a steady animation along: two frames. */
export const FRAME_CAP_MS = 34;

/**
 * A steady clock after a frame painted at `now`: `clock` was its time as of
 * the frame painted at `last`, and it moves on by the time between them, up
 * to FRAME_CAP_MS.
 */
export function steadyClock(clock: number, last: number, now: number): number {
  'worklet';
  return clock + Math.min(FRAME_CAP_MS, Math.max(0, now - last));
}

/** An animation as Reanimated runs it, as far as a steady one needs. */
interface Running {
  onStart: (
    animation: Running,
    value: unknown,
    now: number,
    previous: Running | null,
  ) => void;
  onFrame: (animation: Running, now: number) => boolean;
  current?: unknown;
  velocity?: number;
  callback?: (finished?: boolean) => void;
  reduceMotion?: boolean;
  /** A steady animation's own: what it wraps, and its clock. */
  steadyInner?: Running;
  steadyClock?: number;
  steadyLast?: number;
}

/**
 * `animation`, run on a steady clock (see above). It takes and gives what
 * the animation does: wrap a `withTiming`, a `withSpring` or a `withDelay`
 * where it is assigned, from a component or inside a layout animation.
 * One that follows another steady animation on the same value picks up
 * that one's clock, so a spring handed on mid-move keeps its speed. Under
 * Jest an animation is already its final value, which passes through.
 */
export function steady<T>(animation: T): T {
  'worklet';
  if (
    animation === null ||
    (typeof animation !== 'object' && typeof animation !== 'function')
  ) {
    return animation;
  }
  return defineAnimation(animation as never, () => {
    'worklet';
    // From the JS thread an animation arrives as the function that makes
    // it, as withDelay takes one.
    const inner: Running =
      typeof animation === 'function'
        ? (animation as unknown as () => Running)()
        : (animation as unknown as Running);

    function onStart(
      self: Running,
      value: unknown,
      now: number,
      previous: Running | null,
    ): void {
      const before = previous === self ? null : previous;
      const clock = before?.steadyClock ?? now;
      self.steadyClock = clock;
      self.steadyLast = now;
      if (inner.reduceMotion === undefined) {
        inner.reduceMotion = self.reduceMotion;
      }
      inner.onStart(inner, value, clock, before?.steadyInner ?? before);
      self.current = inner.current;
    }

    function onFrame(self: Running, now: number): boolean {
      const clock = steadyClock(
        self.steadyClock ?? now,
        self.steadyLast ?? now,
        now,
      );
      self.steadyClock = clock;
      self.steadyLast = now;
      const finished = inner.onFrame(inner, clock);
      self.current = inner.current;
      self.velocity = inner.velocity;
      return finished;
    }

    const callback = (finished?: boolean): void => {
      if (inner.callback) inner.callback(finished);
    };

    return {
      isHigherOrder: true,
      onStart,
      onFrame,
      callback,
      current: inner.current,
      steadyInner: inner,
      steadyClock: 0,
      steadyLast: 0,
      reduceMotion: undefined,
    } as never;
  }) as T;
}
