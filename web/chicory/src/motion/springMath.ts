import { withSpring } from 'react-native-reanimated';

/*
 * Spring arithmetic, for poses computed on the UI thread from a clock rather
 * than run as an animation: the ratchet's steps, and the pops that start
 * from rest with a kick instead of a target.
 */

/** A spring from tokens.ts, as the arithmetic reads it. */
export interface Spring {
  damping: number;
  stiffness: number;
  mass: number;
}

function natural({ damping, stiffness, mass }: Spring) {
  'worklet';
  return {
    w0: Math.sqrt(stiffness / mass),
    zeta: damping / (2 * Math.sqrt(stiffness * mass)),
  };
}

/**
 * Where a spring let go at 0 toward 1 is after `seconds`: the shape of one
 * snap. A spring damped past critical is drawn as critical, which it is
 * within a hair for the springs in tokens.ts.
 */
export function springStep(seconds: number, config: Spring): number {
  'worklet';
  if (seconds <= 0) return 0;
  const { w0, zeta } = natural(config);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * w0 * seconds) *
        (Math.cos(wd * seconds) + ((zeta * w0) / wd) * Math.sin(wd * seconds))
    );
  }
  return 1 - Math.exp(-w0 * seconds) * (1 + w0 * seconds);
}

/**
 * The starting velocity that throws a spring at rest out to `peak` before
 * it swings back: a pop that is all spring, with no target to reach first.
 */
export function kickVelocity(peak: number, config: Spring): number {
  const { w0, zeta } = natural(config);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const top = Math.atan2(wd, zeta * w0) / wd;
    return (peak * wd) / (Math.exp(-zeta * w0 * top) * Math.sin(wd * top));
  }
  return peak * w0 * Math.E;
}

/** A pop out to `peak` times the size and back, all on `config`. */
export function kick(peak: number, config: Spring) {
  return withSpring(1, { ...config, velocity: kickVelocity(peak, config) });
}
