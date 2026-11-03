import { SHARE_STEP } from '../../services/autoPayPreference';
import { GRAB, THUMB, clamp01 } from '../send/feeTrack';

/**
 * The auto-pay limit slider's maths (REDESIGN.md 5, ShareSlider): a share
 * of the balance from 0 to 100% in detents of SHARE_STEP, where it sits on
 * the track and which share a point on it is, and a screen reader's steps.
 * The fee rate slider's row, thumb, rubber band and marks (`feeTrack`),
 * on a track that starts at the row's own edge rather than after the sum's
 * rail column. Pure, so the parts the finger drives run on the UI thread
 * and the rest is a table test.
 */

/** The marks on the track: a quarter, a half and three quarters. */
export const SHARE_MARKS = [0.25, 0.5, 0.75];

/** How far the thumb's centre travels across a row `width` wide. */
export function shareTravel(width: number): number {
  'worklet';
  return Math.max(1, width - THUMB);
}

/** The thumb's centre, from the row's left edge, at `position`. */
export function shareCentre(position: number, width: number): number {
  'worklet';
  return THUMB / 2 + position * shareTravel(width);
}

/** The position under a touch `x` from the row's left edge. */
export function shareAtX(x: number, width: number): number {
  'worklet';
  return clamp01((x - THUMB / 2) / shareTravel(width));
}

/** Whether a touch at `x` takes hold of the thumb. */
export function shareGrabs(
  x: number,
  position: number,
  width: number,
): boolean {
  'worklet';
  return Math.abs(x - shareCentre(position, width)) <= GRAB;
}

/** The share, a whole detent, at `position` on the track. */
export function shareAt(position: number): number {
  'worklet';
  return Math.round((clamp01(position) * 100) / SHARE_STEP) * SHARE_STEP;
}

/** Where `share` sits on the track, 0 to 1. */
export function positionOfShare(share: number): number {
  'worklet';
  return clamp01(share / 100);
}

/** A screen reader's step: one detent up or down, held to 0 and 100. */
export function stepShare(share: number, direction: 1 | -1): number {
  return Math.min(100, Math.max(0, share + direction * SHARE_STEP));
}
