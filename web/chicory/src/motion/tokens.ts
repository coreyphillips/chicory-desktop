import { Easing, withSequence, withTiming } from 'react-native-reanimated';
import type { WithSpringConfig } from 'react-native-reanimated';

/**
 * The redesign's motion vocabulary (REDESIGN.md 3.5). Every spring, curve and
 * duration in the app comes from here, so two things that move for the same
 * reason move the same way.
 */

/** Physical springs, named for what they move. */
export const springs = {
  /** Presses, releases, keys, chips and ratchet steps. */
  snap: { damping: 26, stiffness: 420, mass: 0.9 },
  /** The sheet, shared elements and reveals. */
  pane: { damping: 30, stiffness: 260, mass: 1 },
  /** Pop-ins, petal unfolds, bursts and the check's scale. */
  reveal: { damping: 18, stiffness: 180, mass: 1 },
  /** Liquid levels and re-saturation. */
  soft: { damping: 22, stiffness: 120, mass: 1 },
  /** The bloom centre's pop, and nothing else. */
  boing: { damping: 10, stiffness: 300, mass: 0.6 },
} satisfies Record<string, WithSpringConfig>;

/**
 * Timing curves. Enter is fast-out, slow-in, so new content lands softly;
 * exit accelerates away, so old content never lingers under the new.
 */
export const curves = {
  standard: Easing.bezier(0.4, 0, 0.2, 1),
  enter: Easing.bezier(0.05, 0.7, 0.1, 1),
  exit: Easing.bezier(0.3, 0, 0.8, 0.15),
  /** Orbits, countdowns and sheen: anything that must not appear to ease. */
  linear: Easing.linear,
  /** Breathe and pulse. */
  sine: Easing.inOut(Easing.sin),
};

/** Milliseconds. Loops (orbit to shimmer) are per cycle. */
export const durations = {
  tick: 90,
  exit: 140,
  /** The ceiling for any reduced-motion crossfade. */
  crossfade: 160,
  enter: 220,
  move: 320,
  draw: 420,
  celebrate: 900,
  orbit: 1400,
  halo: 1600,
  pulse: 1800,
  sheen: 2400,
  shimmer: 2600,
  breathe: 4200,
  dashRotate: 8000,
  /**
   * Hold to send. Engine warnings lengthen it, so a payment that was warned
   * about takes a moment longer to commit.
   */
  hold: 700,
  holdWarning: 1000,
};

/**
 * How one view hands over to the next: the outgoing content exits at t0, the
 * pane spring starts at t0, and the incoming content enters `enterDelay`
 * later, rising `rise` points. Siblings stagger between `staggerMin` and
 * `staggerMax` apart. Together these keep a change under 350ms.
 */
export const overlap = {
  enterDelay: 80,
  rise: 12,
  staggerMin: 25,
  staggerMax: 40,
};

/** translateX keyframes for a refusal: a short, damped no. */
export const SHAKE = [0, -8, 8, -5, 5, -2, 0];
export const SHAKE_STEP = 55;

/**
 * The shake as one Reanimated sequence, 330ms in all. Assign it to a
 * translateX shared value. Reduced motion swaps the shake for a radish tint
 * (REDESIGN.md 8), which is the caller's to draw.
 */
export function shake() {
  'worklet';
  return withSequence(
    ...SHAKE.slice(1).map(x =>
      withTiming(x, { duration: SHAKE_STEP, easing: curves.linear }),
    ),
  );
}
