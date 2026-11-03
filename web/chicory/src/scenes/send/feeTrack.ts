import type { FeeRates } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { MIN_TARGET, space } from '../../theme';

/**
 * The fee rate slider's maths (REDESIGN.md 6, Send): where a rate sits on
 * the track and which rate a point on it is, the thumb's geometry, a screen
 * reader's steps, and the words for a rate against the engine's estimates.
 * Pure, so the parts the finger drives run on the UI thread and the rest is
 * a table test.
 */

/** The row's height: the least touch target (REDESIGN.md 3.4). */
export const ROW = MIN_TARGET;
/** The thumb: the Offline switch's knob, carrying the gauge at GLYPH. */
export const THUMB = 28;
export const GLYPH = 16;
/** The track's and the fill's line. */
export const TRACK = 2;
/** A mark on the track at one of the engine's estimates. */
export const MARK = 6;
/**
 * Where the track starts: after the sum's rail column and its gap, so its
 * left end lines up with the signs above it.
 */
export const TRACK_START = 24 + space.sm;
/** A short sum still gives the thumb room to travel. */
export const ROW_MIN_WIDTH = 200;
/** Past either end the thumb follows the finger this far: the sheet's band. */
export const RUBBER = 0.35;
/** A touch this close to the thumb's centre takes hold of it. */
export const GRAB = THUMB / 2 + 6;
/** The husk ring round the thumb while it is held back, as Receive rings a 28pt control. */
export const QUIET_RING = Math.max(2, Math.round(THUMB / 22));
/** The needle's heading from twelve at the track's start, and how far it sweeps to the end. */
export const NEEDLE_FROM = -75;
export const NEEDLE_SWEEP = 150;
/** The heading the gauge glyph is drawn with: its needle points up and to the right. */
export const NEEDLE_DRAWN = 45;
/** Two frames: at most one tick in this long, however fast a drag crosses whole rates. */
export const TICK_GAP_MS = 34;
/** A screen reader crosses the range in about this many steps. */
export const STEP_SPAN = 40;

export function clamp01(value: number): number {
  'worklet';
  return Math.min(1, Math.max(0, value));
}

/**
 * The distinct whole rates the track is pinned to, sorted: the range's ends
 * and the estimates inside them. A range with no room (`max` at or under
 * `min`) has one anchor, and the slider draws itself quiet.
 */
export function feeAnchors(rates: FeeRates, min: number, max: number): number[] {
  const lo = Math.round(min);
  const hi = Math.round(max);
  if (!(hi > lo)) return [lo];
  const inside = (rate: number) =>
    Math.min(hi, Math.max(lo, Math.round(rate)));
  return [
    ...new Set([lo, inside(rates.slow), inside(rates.normal), inside(rates.fast), hi]),
  ].sort((a, b) => a - b);
}

/**
 * Where `rate` sits on the track, 0 to 1: the anchors are spaced evenly and
 * the rate runs linearly between neighbours, so with five anchors normal is
 * at the centre, slow a quarter in, fast three quarters, and the last
 * quarter is the headroom above fast.
 */
export function positionOf(rate: number, anchors: number[]): number {
  'worklet';
  const last = anchors.length - 1;
  if (last < 1) return 0;
  if (rate <= anchors[0]) return 0;
  if (rate >= anchors[last]) return 1;
  let i = 0;
  while (rate > anchors[i + 1]) i += 1;
  const span = anchors[i + 1] - anchors[i];
  return (i + (span > 0 ? (rate - anchors[i]) / span : 0)) / last;
}

/** The whole rate at `position`, the inverse of positionOf. */
export function rateAt(position: number, anchors: number[]): number {
  'worklet';
  const last = anchors.length - 1;
  if (last < 1) return anchors.length ? anchors[0] : 1;
  const scaled = clamp01(position) * last;
  const i = Math.min(last - 1, Math.floor(scaled));
  return Math.round(anchors[i] + (anchors[i + 1] - anchors[i]) * (scaled - i));
}

/** The marks' positions: slow, normal and fast, merged where they coincide. */
export function markPositions(rates: FeeRates, anchors: number[]): number[] {
  const at = [rates.slow, rates.normal, rates.fast].map(rate =>
    positionOf(rate, anchors),
  );
  return [...new Set(at)].sort((a, b) => a - b);
}

/** How far the thumb's centre travels across a row `width` wide. */
export function travelOf(width: number): number {
  'worklet';
  return Math.max(1, width - TRACK_START - THUMB);
}

/** The thumb's centre, from the row's left edge, at `position`. */
export function thumbCentre(position: number, width: number): number {
  'worklet';
  return TRACK_START + THUMB / 2 + position * travelOf(width);
}

/** The position under a touch `x` from the row's left edge. */
export function positionAtX(x: number, width: number): number {
  'worklet';
  return clamp01((x - TRACK_START - THUMB / 2) / travelOf(width));
}

/** Whether a touch at `x` takes hold of the thumb. */
export function grabs(x: number, position: number, width: number): boolean {
  'worklet';
  return Math.abs(x - thumbCentre(position, width)) <= GRAB;
}

/** Past either end the thumb follows the finger at RUBBER of the overshoot. */
export function rubber(raw: number): number {
  'worklet';
  if (raw < 0) return raw * RUBBER;
  if (raw > 1) return 1 + (raw - 1) * RUBBER;
  return raw;
}

/** How many marks the thumb is at or past. */
export function marksPassed(position: number, marks: number[]): number {
  'worklet';
  let count = 0;
  for (let i = 0; i < marks.length; i += 1) {
    if (position >= marks[i]) count += 1;
  }
  return count;
}

/**
 * The needle's turn from its drawn pose, in degrees, for the thumb at
 * `position`: low at the slow end, straight up at the centre, high at the
 * fast end.
 */
export function needleRotate(position: number): number {
  'worklet';
  return NEEDLE_FROM + NEEDLE_SWEEP * clamp01(position) - NEEDLE_DRAWN;
}

/**
 * One screen-reader step from `rate`: one sat per virtual byte on a short
 * range, and on a wide one enough that the range is crossed in about
 * STEP_SPAN steps. A step that would pass an anchor lands on it, so slow,
 * normal and fast are always reachable. Clamped to the range, so at an end
 * the rate is returned unchanged.
 */
export function stepRate(
  rate: number,
  direction: 1 | -1,
  anchors: number[],
): number {
  const lo = anchors[0];
  const hi = anchors[anchors.length - 1];
  const stride = Math.max(1, Math.round((hi - lo) / STEP_SPAN));
  let next = Math.round(rate) + direction * stride;
  for (const anchor of anchors) {
    const between =
      direction > 0
        ? anchor > rate && anchor < next
        : anchor < rate && anchor > next;
    if (between) next = anchor;
  }
  return Math.min(hi, Math.max(lo, next));
}

export type FeeZone =
  | 'belowSlow'
  | 'slow'
  | 'betweenSlowAndNormal'
  | 'normal'
  | 'betweenNormalAndFast'
  | 'fast'
  | 'aboveFast';

/**
 * Where `rate` stands against the estimates. A rate equal to more than one
 * of them is normal first, then fast, then slow.
 */
export function feeZone(rate: number, rates: FeeRates): FeeZone {
  if (rate === rates.normal) return 'normal';
  if (rate === rates.fast) return 'fast';
  if (rate === rates.slow) return 'slow';
  if (rate < rates.slow) return 'belowSlow';
  if (rate < rates.normal) return 'betweenSlowAndNormal';
  if (rate < rates.fast) return 'betweenNormalAndFast';
  return 'aboveFast';
}

/** The value a screen reader hears: the zone, the rate, and the fee it gives. */
export function feeSpoken(rate: number, feeSats: number, rates: FeeRates): string {
  return copy.send.feeRateValue(
    rate,
    feeSats,
    copy.send.feeZones[feeZone(rate, rates)],
  );
}
