import { createContext } from 'react';
import { withSpring, withTiming } from 'react-native-reanimated';
import type {
  EntryAnimationsValues,
  EntryExitAnimationFunction,
  ExitAnimationsValues,
  SharedValue,
} from 'react-native-reanimated';
import type { Activity } from '@beignet/wallet-core';
import { riseIn, sceneIn, sceneOut } from '../../motion/presets';
import { curves, durations, overlap, springs } from '../../motion/tokens';
import { motionReduced } from '../../services/motion';
import { SLOT_PADDING } from '../../stage/layout';
import type { Rect } from '../../stage/scene';
import { radius, space, type as typography } from '../../theme';
import {
  NOTE_GAP,
  ROW_BAND,
  ROW_GAP,
  ROW_OPEN,
  ROW_RING,
  attentionOf,
} from '../activity/model';
import { amountVisual } from '../activity/visual';

/**
 * A payment's detail growing out of its row and folding back into it
 * (REDESIGN.md 7, T4), as layout animations and the frame math under them.
 *
 * A layout animation is handed its view's frame in its parent's coordinates.
 * On the new architecture its "global" origin is that same frame, not the
 * window's, so nothing here reads it: where the card and its header sit in
 * the window comes from where the canvas puts the card and how the detail
 * lays out its top.
 */

/**
 * The card grows out of its row over this long: the 320ms T4 gives the
 * ring and amount to fly, inside the 340ms transition lock the card holds.
 */
export const EXPAND_MS = durations.move;
/** A row's corners, which the card starts from and folds back to. */
export const ROW_RADIUS = radius.md;
/** The card's corners once it has grown. */
export const CARD_RADIUS = radius.pane;

/** A frame in the coordinates of a view's parent, as layout animations take it. */
export interface Frame {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * The frame, in the parent's coordinates, that lies over `rect` in the
 * window's, for a view whose frame `origin` sits at `global` in the window.
 * For the card, `global` is where the canvas rests it (`CardRest`).
 */
export function frameOver(
  rect: Rect,
  origin: { x: number; y: number },
  global: { x: number; y: number },
): Frame {
  'worklet';
  return {
    originX: origin.x + rect.x - global.x,
    originY: origin.y + rect.y - global.y,
    width: rect.width,
    height: rect.height,
  };
}

const MOVE = { duration: EXPAND_MS, easing: curves.standard };

/**
 * Where the canvas rests a payment's card, in window coordinates: the top
 * left of the slot it keeps at the sheet's compact stop, and the canvas's
 * width, which the card fills.
 */
export interface CardRest {
  x: number;
  y: number;
  width: number;
}

/**
 * The card arriving: from the row's rect, corners and all, to where the
 * canvas places it, `card`. Without a rect or a place, or under Reduce
 * Motion, it fades in.
 */
export function expandFrom(
  rect: Rect | null,
  card: CardRest | null,
): EntryExitAnimationFunction {
  if (!rect || !card || motionReduced()) return sceneIn();
  return (values: EntryAnimationsValues) => {
    'worklet';
    const start = frameOver(
      rect,
      { x: values.targetOriginX, y: values.targetOriginY },
      card,
    );
    return {
      initialValues: { ...start, borderRadius: ROW_RADIUS },
      animations: {
        originX: withTiming(values.targetOriginX, MOVE),
        originY: withTiming(values.targetOriginY, MOVE),
        width: withTiming(values.targetWidth, MOVE),
        height: withTiming(values.targetHeight, MOVE),
        borderRadius: withTiming(CARD_RADIUS, MOVE),
      },
    };
  };
}

const FOLD = { duration: durations.move, easing: curves.standard };
const FADE = { duration: durations.exit, easing: curves.exit };
const ENTER = { duration: durations.enter, easing: curves.enter };

/**
 * The card leaving `card`, where it rests: back into the row `back` holds
 * when it leaves, fading as it lands, or simply fading when there is no row
 * to go to. `back` is read as the card leaves, so it can follow a row that
 * moved while the card was open.
 */
export function collapseTo(
  back: SharedValue<Rect | null>,
  card: CardRest,
): EntryExitAnimationFunction {
  if (motionReduced()) return sceneOut();
  return (values: ExitAnimationsValues) => {
    'worklet';
    const rect = back.get();
    if (!rect) {
      return {
        initialValues: { opacity: 1 },
        animations: { opacity: withTiming(0, FADE) },
      };
    }
    const end = frameOver(
      rect,
      { x: values.currentOriginX, y: values.currentOriginY },
      card,
    );
    return {
      initialValues: {
        originX: values.currentOriginX,
        originY: values.currentOriginY,
        width: values.currentWidth,
        height: values.currentHeight,
        borderRadius: CARD_RADIUS,
        opacity: 1,
      },
      animations: {
        originX: withTiming(end.originX, FOLD),
        originY: withTiming(end.originY, FOLD),
        width: withTiming(end.width, FOLD),
        height: withTiming(end.height, FOLD),
        borderRadius: withTiming(ROW_RADIUS, FOLD),
        opacity: withTiming(0, FOLD),
      },
    };
  };
}

/** The detail header's ring, and its infinity for a request of any amount. */
export const HEADER_RING = 96;
export const HEADER_OPEN = 48;
/** The room over the ring, and between it and the amount, in the header. */
export const HEADER_PAD = space.xs;
export const HEADER_GAP = space.sm;

/**
 * How far below the card's top edge the header's ring and amount sit, both
 * centred across it. The detail is the first thing in its slot's scroll,
 * whose content starts `SLOT_PADDING.top` down, and the header is the first
 * thing in the detail.
 */
export const HEADER_TOPS = {
  ring: SLOT_PADDING.top + HEADER_PAD,
  amount: SLOT_PADDING.top + HEADER_PAD + HEADER_RING + HEADER_GAP,
};

/** A point in window coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Where a detail's card grows from and where it comes to rest, both in
 * window coordinates: the tapped row's rect, and the slot the canvas keeps
 * at the compact stop. The header flies out of the row inside it. Null, or
 * no provider, when the card only fades.
 */
export interface Flight {
  from: Rect;
  card: CardRest;
}

export const DetailFlight = createContext<Flight | null>(null);

/**
 * Where the row in `from` drew what flies to the header: the centre of its
 * ring, and the left end of its amount at the amount's middle. A pinned row
 * pads its content by the band's reach, and a note under the amount lifts it.
 */
export function rowParts(
  from: Rect,
  { banded, note }: { banded: boolean; note: boolean },
): { ring: Point; amount: Point } {
  const left = from.x + (banded ? ROW_BAND : 0);
  const middle = from.y + from.height / 2;
  const lift = note ? (typography.meta.lineHeight + NOTE_GAP) / 2 : 0;
  return {
    ring: { x: left + ROW_RING / 2, y: middle },
    amount: { x: left + ROW_RING + ROW_GAP, y: middle - lift },
  };
}

/** How a flying view starts: its offset from its place, and its scale. */
export interface Launch {
  translateX: number;
  translateY: number;
  scale: number;
}

/**
 * Where a view in the card starts its flight, as a transform from its place:
 * over `start` at `scale`, centred on it, or with its left end on it when
 * `anchor` is 'left'. `target` is the view's final frame in window
 * coordinates (`restingFrame`).
 *
 * The card carries the view as it grows. Run back to nothing on the card's
 * own clock and curve, the transform gives back the card's travel as it goes,
 * so the view flies straight from `start` to its place.
 */
export function launch(
  target: Frame,
  flight: Flight,
  start: Point,
  scale: number,
  anchor: 'center' | 'left',
): Launch {
  'worklet';
  // Its centre as the card starts, laid out where it will end in the card.
  const x = flight.from.x + target.originX - flight.card.x + target.width / 2;
  const y = flight.from.y + target.originY - flight.card.y + target.height / 2;
  const to = anchor === 'left' ? start.x + (target.width * scale) / 2 : start.x;
  return { translateX: to - x, translateY: start.y - y, scale };
}

/**
 * Where a part of the header `width` by `height` rests in the window: centred
 * across the card, `top` below its top edge (`HEADER_TOPS`).
 */
export function restingFrame(
  card: CardRest,
  top: number,
  width: number,
  height: number,
): Frame {
  'worklet';
  return {
    originX: card.x + (card.width - width) / 2,
    originY: card.y + top,
    width,
    height,
  };
}

/**
 * How long the amount waits in its row, still where it was drawn, before it
 * flies: a sibling's stagger (REDESIGN.md 3.5), which lets the ring, which
 * starts beside it and lands above it, lift clear of it first. Flown at once
 * the two crossed, the amount over the ring's lower half (P10, 22-t4-sheet
 * frames 102-106).
 */
export const AMOUNT_HOLD = overlap.staggerMax;

/**
 * How far along its timing a view the card carries is at `x` (0 to 1 of the
 * card's time), for it to hold still in the window for the first `hold` of
 * that time and then fly straight to its place on `curve`, landing with the
 * card. The card moves on `curve` too, and `ratio` is how far it travels on
 * this axis over the view's start offset there (`launch`): until the view
 * sets off, its transform gives back all the card has carried it.
 */
export function heldEase(
  x: number,
  ratio: number,
  hold: number,
  curve: (u: number) => number,
): number {
  'worklet';
  const own = x <= hold ? 0 : curve((x - hold) / (1 - hold));
  return own + ratio * (curve(x) - own);
}

/**
 * One part of the header flying in from `start`; see `launch`. With `hold`
 * it waits that many ms where it starts, then flies, arriving with the card.
 */
function flyIn(
  flight: Flight,
  top: number,
  start: Point,
  scale: number,
  anchor: 'center' | 'left',
  hold: number,
): EntryExitAnimationFunction {
  return (values: EntryAnimationsValues) => {
    'worklet';
    const from = launch(
      restingFrame(flight.card, top, values.targetWidth, values.targetHeight),
      flight,
      start,
      scale,
      anchor,
    );
    const curve = curves.standard.factory();
    const share = hold / EXPAND_MS;
    // An axis the view has no start offset on has nothing to give back the
    // card's travel with, so it flies on the card's own clock.
    const along = (offset: number, travel: number) => {
      if (!share || Math.abs(offset) < 1) return withTiming(0, MOVE);
      const ratio = travel / offset;
      const easing = (u: number) => {
        'worklet';
        return heldEase(u, ratio, share, curve);
      };
      return withTiming(0, { duration: EXPAND_MS, easing });
    };
    const grows = (u: number) => {
      'worklet';
      return heldEase(u, 0, share, curve);
    };
    return {
      initialValues: {
        transform: [
          { translateX: from.translateX },
          { translateY: from.translateY },
          { scale: from.scale },
        ],
      },
      animations: {
        transform: [
          {
            translateX: along(from.translateX, flight.card.x - flight.from.x),
          },
          {
            translateY: along(from.translateY, flight.card.y - flight.from.y),
          },
          {
            scale: share
              ? withTiming(1, { duration: EXPAND_MS, easing: grows })
              : withTiming(1, MOVE),
          },
        ],
      },
    };
  };
}

/**
 * The header ring without a row to leave: it grows from a row ring's size to
 * its own where it stands, on the pane spring. Under Reduce Motion it fades.
 */
function ringIn(): EntryExitAnimationFunction {
  if (motionReduced()) return sceneIn();
  return () => {
    'worklet';
    return {
      initialValues: {
        opacity: 0,
        transform: [{ scale: ROW_RING / HEADER_RING }],
      },
      animations: {
        opacity: withTiming(1, ENTER),
        transform: [{ scale: withSpring(1, springs.pane) }],
      },
    };
  };
}

/**
 * How a detail's header arrives (REDESIGN.md 7, T4). Out of a row, the ring
 * and the amount fly from where the row drew them to their places, growing
 * from the row's sizes on the way, while the card grows around them; the
 * amount waits `AMOUNT_HOLD` for the ring to lift clear of it, so the two
 * never cross. Otherwise the ring grows where it stands and the amount comes
 * with the card. Under Reduce Motion nothing flies.
 */
export function headerIn(
  flight: Flight | null,
  item: Activity,
): { ring: EntryExitAnimationFunction; amount?: EntryExitAnimationFunction } {
  if (!flight || motionReduced()) return { ring: ringIn() };
  const parts = rowParts(flight.from, {
    banded: attentionOf(item) !== null,
    note: !!item.description,
  });
  const figure = amountVisual(item).open
    ? ROW_OPEN / HEADER_OPEN
    : typography.row.fontSize / typography.amountDetail.fontSize;
  return {
    ring: flyIn(
      flight,
      HEADER_TOPS.ring,
      parts.ring,
      ROW_RING / HEADER_RING,
      'center',
      0,
    ),
    amount: flyIn(
      flight,
      HEADER_TOPS.amount,
      parts.amount,
      figure,
      'left',
      AMOUNT_HOLD,
    ),
  };
}

/** When the first line starts in, and how far apart the rest follow. */
const LINES_AT = 120;
const LINE_GAP = 40;

/** The `index`th line under the header, rising in after the ones above. */
export function lineIn(index: number): EntryExitAnimationFunction {
  return riseIn(undefined, LINES_AT + index * LINE_GAP);
}
