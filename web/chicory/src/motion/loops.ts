import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import {
  Easing,
  cancelAnimation,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { usePaneActive } from '../stage/panes/Pane';
import { useAmbientRest } from './ambient';
import { curves, durations } from './tokens';
import { useMotionPrefs } from './useMotionPrefs';

/*
 * Endless loops: an orbit, a breath, a halo, a chase (REDESIGN.md 3.5).
 *
 * A loop is a clock that counts cycles and never rewinds: each pose is a
 * periodic function of it, at rest on every whole number. A paused loop
 * picks up exactly where it stopped, and one that ends eases to the nearest
 * whole number, so nothing snaps back. One that decorates, coming to the
 * ambient rest, carries on to the next whole number instead, slowing from
 * its own speed to a stop (`restEase`). Under Jest the clock lands on its
 * next whole number at once, which is the resting pose.
 *
 * Drive only transform and opacity with a clock, on a view around a still
 * drawing.
 */

/** The fractional part of a clock: how far into its current cycle it is. */
export function fract(x: number): number {
  'worklet';
  return x - Math.floor(x);
}

/**
 * A clock read as a loop that goes out and back, such as a breath or a
 * pulse: 0 at every whole cycle, 1 halfway through, on the sine curve both
 * ways. It rests at 0 where the clock rests.
 */
export function wave(clock: number): number {
  'worklet';
  return (1 - Math.cos(2 * Math.PI * clock)) / 2;
}

/**
 * A curve that sets out at twice its average speed and slows to a stop:
 * the square's ease-out.
 */
export const REST_CURVE = Easing.out(Easing.quad);

/**
 * How a clock at `at`, running one whole number every `unit` ms, comes to
 * rest: forward to the next whole number, never back, over as long as sets
 * REST_CURVE off at the clock's own speed. It opens at twice the average
 * speed, so twice the time the rest of the way would take at that speed
 * makes the two meet: the loop slows from where it was going to a stop
 * rather than stopping, and nothing turns backwards. At a whole number it
 * is already at rest.
 */
export function restEase(
  at: number,
  unit: number,
): { to: number; duration: number } {
  const to = Math.ceil(at);
  return { to, duration: 2 * (to - at) * unit };
}

const foreground = () =>
  AppState.currentState !== 'background' &&
  AppState.currentState !== 'inactive';

// One AppState subscription serves every loop on screen, however many rows
// of rings a list draws.
const wakers = new Set<() => void>();
let appState: { remove: () => void } | null = null;
function subscribeAwake(waker: () => void) {
  wakers.add(waker);
  appState ??= AppState.addEventListener('change', () => {
    for (const wake of wakers) wake();
  });
  return () => {
    wakers.delete(waker);
    if (wakers.size === 0) {
      appState?.remove();
      appState = null;
    }
  };
}

/**
 * Whether a loop here would be seen: the app is in front and the pane it is
 * drawn in is in use. Anything else pauses it.
 */
export function useAwake(): boolean {
  const inFront = useSyncExternalStore(subscribeAwake, foreground);
  return usePaneActive() && inFront;
}

/**
 * A clock that counts one cycle every `period` ms while `running`, and eases
 * to rest when it stops. It also rests wherever nobody would see it move:
 * while the app is in the background, while its pane is out of use, and
 * under Reduce Motion, where a loop becomes a still state (REDESIGN.md 8).
 * It is cancelled when its owner unmounts.
 *
 * An `ambient` loop only decorates, and rests too once the app has gone
 * untouched a while, easing into its rest pose (`restEase`), and picks up
 * where it stopped with the next touch (`ambient.ts`, REDESIGN.md 3.5). A
 * loop that says something is under way leaves it false.
 *
 * A loop that turns reads `fract` of it; one that goes out and back, such as
 * a breath, reads `wave` of it, and a whole breath is then one period.
 */
export function useLoop(
  period: number,
  running: boolean,
  ambient = false,
): SharedValue<number> {
  const { reduced } = useMotionPrefs();
  const awake = useAwake();
  const idle = useAmbientRest(ambient);
  const on = running && awake && !reduced && !idle;
  // Seen, and stopping only because decoration rests.
  const resting = running && awake && !reduced && idle;
  const clock = useSharedValue(0);
  useEffect(() => {
    const at = clock.get();
    if (on) {
      clock.set(
        withRepeat(
          withTiming(at + 1, { duration: period, easing: curves.linear }),
          -1,
          false,
        ),
      );
    } else if (resting) {
      const rest = restEase(at, period);
      if (rest.to !== at) {
        clock.set(
          withTiming(rest.to, { duration: rest.duration, easing: REST_CURVE }),
        );
      }
    } else if (at !== Math.round(at)) {
      clock.set(
        withTiming(Math.round(at), {
          duration: durations.exit,
          easing: curves.standard,
        }),
      );
    }
    return () => cancelAnimation(clock);
  }, [clock, period, on, resting]);
  return clock;
}
