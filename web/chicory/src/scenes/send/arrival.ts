import type { HostInstance } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { durations } from '../../motion/tokens';
import { motionReduced } from '../../services/motion';
import { PANE_SETTLE_MS } from '../../stage/layout';
import { CONTROL } from './Controls';

/*
 * How a result grows out of the hold it was sent with (REDESIGN.md 6, Send
 * and 7, T7): the ring travels from the hold's centre to where the mark
 * rests, growing from the hold's 88pt to the mark's 120pt on the pane
 * spring, and the comet that ran round the hold runs on round the mark
 * until the face takes over. For a payment that went through, the comet's
 * lap closes into the whole ring, cream fills it, and the check draws.
 */

/** A point in window coordinates. */
export interface Origin {
  x: number;
  y: number;
}

/** What a result's mark grows out of. */
export interface Arrival {
  /** The hold's centre, in window points. */
  from: Origin;
  /** The clock the hold's comet turned on, for the mark's to carry on. */
  clock: SharedValue<number>;
  /** The hold was honey: the payment was committed with warnings. */
  warned: boolean;
}

/** The mark's size, Send's result (ResultMark). */
export const MARK = 120;

/** How big the mark starts, as the hold is to it. */
export const TRAVEL_FROM = CONTROL / MARK;

/** The comet's last lap closing into the ring, as the spring is nearly there. */
export const CLOSE_MS = durations.move;

/** The cream filling the closed ring. */
export const FILL_MS = durations.enter;

/** When the mark looks landed, as the panes look settled. */
export const ARRIVE_MS = PANE_SETTLE_MS;

/** How long after its disc is there the check begins, as it does at rest. */
export const CHECK_LEAD = 120;

/**
 * The mark `t` (0 to 1) of the way from the hold's centre `from` to its
 * resting centre `to`: where it is drawn, from where it rests, and its
 * scale, from the hold's size to its own.
 */
export function travelPose(
  t: number,
  from: Origin,
  to: Origin,
): { translateX: number; translateY: number; scale: number } {
  'worklet';
  const left = 1 - Math.min(1, Math.max(0, t));
  return {
    translateX: (from.x - to.x) * left,
    translateY: (from.y - to.y) * left,
    scale: TRAVEL_FROM + (1 - TRAVEL_FROM) * (1 - left),
  };
}

/** The beats of a landing, in ms from the mark's first frame. */
export interface ArrivalBeats {
  /** The comet's tail closing into the ring; 0 where no ring closes. */
  close: number;
  /** The cream filling the ring; 0 where nothing fills. */
  fill: number;
  /** The face's glyph beginning: the check, the bang, the pause bars. */
  check: number;
  /** The mark landed: the hold's look gives way to the face. */
  arrive: number;
  /** The hold's look gone for good. */
  gone: number;
}

/**
 * When each beat of a landing falls, for a result that is `done` or one of
 * the other faces, which take the hold's look over by a crossfade instead.
 * Under Reduce Motion nothing travels or closes, and the look is gone
 * within a crossfade.
 */
export function arrivalBeats(done: boolean): ArrivalBeats {
  if (motionReduced()) {
    return {
      close: 0,
      fill: 0,
      check: 0,
      arrive: 0,
      gone: durations.crossfade,
    };
  }
  return done
    ? {
        close: CLOSE_MS,
        fill: CLOSE_MS,
        check: CLOSE_MS + CHECK_LEAD,
        arrive: ARRIVE_MS,
        gone: CLOSE_MS + FILL_MS,
      }
    : {
        close: 0,
        fill: 0,
        check: ARRIVE_MS,
        arrive: ARRIVE_MS,
        gone: ARRIVE_MS + durations.crossfade,
      };
}

/** How far apart two readings of the mark may be and still agree. */
const SETTLED_PT = 0.25;

/** The most frames the mark is followed for, about 750ms. */
const WATCH_FRAMES = 45;

/** Whether two readings of the mark agree (SETTLED_PT). */
function samePlace(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return Math.abs(a.x - b.x) <= SETTLED_PT && Math.abs(a.y - b.y) <= SETTLED_PT;
}

/**
 * Reads the centre of `node` in window points, each frame until two
 * readings agree or WATCH_FRAMES have passed, telling `onRead` each reading
 * that differs from the last. Returns a cancel, for a node that goes first.
 */
export function watchCentre(
  node: () => HostInstance | null,
  onRead: (at: Origin) => void,
): () => void {
  let on = true;
  let last: Origin | null = null;
  let frames = 0;
  const read = () => {
    if (!on) return;
    node()?.measureInWindow((x, y, width, height) => {
      if (!on || !width || !height) return;
      const at = { x: x + width / 2, y: y + height / 2 };
      const moved = !last || !samePlace(last, at);
      last = at;
      frames += 1;
      if (!moved) return;
      onRead(at);
      if (frames < WATCH_FRAMES) requestAnimationFrame(read);
    });
  };
  read();
  return () => {
    on = false;
  };
}
