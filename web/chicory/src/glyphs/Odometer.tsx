import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PixelRatio,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import type { LayoutChangeEvent, TextStyle } from 'react-native';
import Reanimated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { copy } from '../design/copy';
import { mixHex, palette } from '../design/palette';
import { fract, useAwake, useLoop } from '../motion/loops';
import { steady } from '../motion/steady';
import { curves, durations, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import {
  MASK,
  SYMBOL_SCALE,
  TEXT_SYMBOL_SCALE,
  space,
  symbolBeside,
  type as typography,
  unitAffixes,
} from '../theme';
import type { Unit } from '../theme';

/**
 * A rolling amount (REDESIGN.md 5, Odometer). Each digit is a clipped column
 * of "0..9,0" that rolls to the digit's position, keyed by its place value so
 * a digit keeps its column as the amount grows. BTC always shows all eight
 * decimals, with the zeros after the last significant one in dust.
 *
 * A cell is exactly one line of its figures tall, and a rolling digit fades
 * as it slides over the cell's edge, so no part of a neighbouring digit shows
 * above or below it mid-roll.
 *
 * One shared value in sats drives every column on the UI thread, so a roll
 * costs no renders past its first and last. At rest each cell is a single
 * digit; the columns exist only while something moves. A new unit or face
 * lifts the old cells away and rises the new ones in, hiding scrambles the
 * digits before six dots scale in, and a stale amount turns steam while a
 * dip runs across its cells. Under Reduce Motion every change is a short
 * crossfade.
 *
 * The whole odometer is one element to a screen reader; the cells are hidden.
 * Without an `accessibilityLabel` it reads the amount in sats.
 *
 * With `symbol` on, sats are drawn as BIP 177 draws them: the bitcoin sign
 * before the figures, after any sign, and no unit after them (`unitAffixes`).
 * Beside the large figures it is a little smaller and centred on them
 * (`symbolBeside`); in a row or a line it stands on their baseline, its top
 * level with theirs (TEXT_SYMBOL_SCALE). A screen reader still hears sats.
 *
 * The hero sizes itself to fit `room`, the width its container measured,
 * and until it has one the window's width between the page edges. When it
 * steps to another size with the unit unchanged, the figures crossfade over
 * 160ms rather than jump; a new unit brings its cells in at the new size.
 */
export type OdometerVariant =
  | 'hero'
  | 'amount'
  | 'amountDetail'
  | 'line'
  | 'row';

export interface OdometerProps {
  sats: number;
  unit: Unit;
  /** Sats are drawn as `₿2,000` rather than `2,000 sats`. */
  symbol?: boolean;
  masked?: boolean;
  stale?: boolean;
  variant: OdometerVariant;
  color?: string;
  /** Drawn before the digits, and dropped while masked. */
  sign?: '+' | '-' | null;
  /** The width the hero may take, as its container measured it. */
  room?: number;
  /**
   * How long a roll takes, in place of `rollDuration` of the change: for a
   * count whose length is set by what it belongs to, as the received
   * celebration's count-up is (REDESIGN.md 5).
   */
  duration?: number;
  /**
   * Counts up from 0 to `sats` as it mounts, setting out this many ms later
   * on the steady clock (`steady`), as the hero does on its beat of the
   * canvas's build (REDESIGN.md 7, R-1). The count is started on the UI
   * thread as it mounts, so it sets out on its beat however busy the
   * JavaScript thread is then, together with an entrance on the same clock.
   * Read once; hidden, under Reduce Motion or at 0 it simply shows.
   */
  countUp?: number;
  /**
   * The scale its container draws it at, while that shrinks it, as Home's
   * hero shrinks into the mini strip: the unit holds a readable size
   * against it (`unitScaleFor`), and the figures shift so the whole stays
   * centred. Left out, it is drawn as it is set.
   */
  scaled?: SharedValue<number>;
  accessibilityLabel?: string;
}

/** A digit's column, or a separator between columns. */
export type OdometerCell =
  | {
      kind: 'digit';
      key: string;
      /** The power of ten, in sats, this column counts. */
      place: number;
      digit: number;
      /** A trailing zero of a BTC amount, drawn in dust. */
      dim: boolean;
    }
  | {
      kind: 'mark';
      key: string;
      char: ',' | '.';
      /** The place the separator follows, which it shows with. */
      place: number;
    };

/** Eight decimals: a BTC amount's decimal point sits above place 8. */
const BTC_PLACES = 8;

const smoothstep = (t: number) => {
  'worklet';
  return t * t * (3 - 2 * t);
};

/**
 * Where the column for place `k` has rolled to when the amount is `v` sats,
 * in digits: 3 shows a 3, 3.5 is halfway to 4, and 10 is the trailing 0 that
 * wraps back to the top. The ones column follows `v` directly. Every higher
 * column holds still until every place below it shows a 9, then turns while
 * the ones roll from that 9 to 0, in step with the columns between, the way
 * a mechanical counter carries. So a figure mid-roll only ever reads the
 * amount it has reached, or the next one up: 59,877 is 59,877, never 69,877.
 */
export function digitPosition(v: number, k: number): number {
  'worklet';
  const u = 10 ** k;
  const whole = Math.floor(v / u);
  const rem = v - whole * u;
  if (k === 0) return (whole % 10) + rem;
  // The last sat before this place turns over, as the ones go from 9 to 0.
  const carry = Math.min(1, Math.max(0, rem - (u - 1)));
  return (whole % 10) + smoothstep(carry);
}

/** How far column `k` has carried toward its next digit at `v`, 0 to 1. */
function carryOf(v: number, k: number): number {
  'worklet';
  return digitPosition(v, k) - (Math.floor(v / 10 ** k) % 10);
}

/**
 * How much of a rolling column's row `i` shows when the column stands at
 * `pos`: all of it where it fills the cell, less as it slides over the
 * cell's edge, and none once it is a whole row out. The two rows in view
 * always add to one, so a roll crossfades its digits as it slides them.
 */
export function rowFade(i: number, pos: number): number {
  'worklet';
  return 1 - smoothstep(Math.min(1, Math.abs(i - pos)));
}

/**
 * Which of a column's even rows (`parity` 0) or odd rows (1) is in view at
 * `pos`. A cell shows at most two rows, one of each, so a column drawn as
 * two layers, one for each parity, can fade each by its one row in view.
 */
export function rowInView(pos: number, parity: number): number {
  'worklet';
  const top = Math.floor(pos);
  return top % 2 === parity ? top : top + 1;
}

/**
 * The highest place `unit` always draws: the ones in sats, and in BTC the
 * whole bitcoin's, so every decimal shows even while it is 0.
 */
export function floorPlace(unit: Unit): number {
  return unit === 'btc' ? BTC_PLACES : 0;
}

/**
 * Whether place `k` is a leading zero at `v`: above the amount's highest
 * digit, and not one of the places always drawn (`floor`, `floorPlace`).
 * Such a place is blank rather than 0, so a figure mid-roll never reads
 * "065,446": a count up from 0 grows its places as it reaches them, and one
 * rolling in rolls up from blank, as a mechanical counter's does.
 */
export function leadingZero(v: number, k: number, floor: number): boolean {
  'worklet';
  return k > floor && v < 10 ** k;
}

/**
 * How much of row `row` place `k`'s column draws, standing at `pos` while
 * the amount is at `v`: its fade by its distance from the cell
 * (`rowFade`), and nothing for a 0 that is a leading zero, at the top of
 * the column or at its foot.
 */
export function rowInk(
  row: number,
  pos: number,
  v: number,
  k: number,
  floor: number,
): number {
  'worklet';
  if ((row === 0 || row === 10) && leadingZero(v, k, floor)) return 0;
  return rowFade(row, pos);
}

/**
 * How much of place `k`'s figure shows at `v`, its column standing at
 * `pos`: all of it once the place holds a digit, and while it is a leading
 * zero only the digit rolling in over the blank, 0 to 1. The separator that
 * follows the place shows as much (`MarkCell`), so no separator stands
 * before the figure's first digit.
 */
export function placeInk(
  v: number,
  k: number,
  floor: number,
  pos: number,
): number {
  'worklet';
  if (!leadingZero(v, k, floor)) return 1;
  return (
    rowInk(rowInView(pos, 0), pos, v, k, floor) +
    rowInk(rowInView(pos, 1), pos, v, k, floor)
  );
}

/**
 * How far a leading place's cell, and the separator after it, is open for
 * `ink` of its figure: shut while the place is blank, so the figures close
 * up round what they show and the sign keeps to the first digit, and open
 * by the time half the digit rolling in shows, so the cell never cuts much
 * of it.
 */
export function cellOpen(ink: number): number {
  'worklet';
  return smoothstep(Math.min(1, Math.max(0, 2 * ink)));
}

/**
 * A cell's width at `open`, for a figure `figure` points wide: its own at
 * full, none when shut, and a share of the figure between, once the figure
 * has been measured.
 */
export function openWidth(open: number, figure: number): number | 'auto' {
  'worklet';
  if (open >= 1) return 'auto';
  if (open <= 0) return 0;
  return figure > 0 ? figure * open : 'auto';
}

/** A column position folded back into its ten digits. */
function wrap(pos: number): number {
  'worklet';
  return ((pos % 10) + 10) % 10;
}

/**
 * A roll in flight: the amounts it runs between, and for each place how far
 * the column was drawn from digitPosition when the roll set out. Columns
 * below `snap` turn too fast to be seen sliding, and show whole rows.
 */
export interface Roll {
  from: number;
  to: number;
  lead: number[];
  snap?: number;
}

/** A painted frame, in ms. */
const FRAME_MS = 1000 / 60;

/**
 * The most rows a column may pass in a frame, on average across a roll,
 * and still be drawn sliding. Faster, a digit is in view for less than two
 * frames, and a frame catches it halfway out of its cell, where it reads as
 * a digit set high or low rather than as motion (the device pass saw
 * "90,54⁸" in the mini strip); such a column shows whole rows instead.
 */
export const SNAP_RATE = 0.5;

/**
 * The lowest place that is still drawn sliding across a roll of `delta`
 * sats over `duration` ms: every column below it passes more than
 * SNAP_RATE rows a frame.
 */
export function snapBelow(delta: number, duration: number): number {
  const frames = Math.max(1, duration / FRAME_MS);
  let k = 0;
  while (Math.abs(delta) / 10 ** k / frames > SNAP_RATE) k += 1;
  return k;
}

/**
 * Where column `k` is drawn at `v` during `roll`. A roll that takes over from
 * one still under way sets out from where that one had drawn each column,
 * which need not be where digitPosition puts the amount it set out from, as
 * a carry caught halfway. That difference is blended out across the roll:
 * every column sets out from what was showing and lands on the amount's own
 * digit.
 */
export function rollPosition(v: number, k: number, roll: Roll): number {
  'worklet';
  const span = roll.to - roll.from;
  const p = span === 0 ? 1 : Math.min(1, Math.max(0, (v - roll.from) / span));
  const pos = wrap(
    digitPosition(v, k) +
      (1 - p) * (roll.lead[k] ?? 0) -
      p * carryOf(roll.to, k),
  );
  // Too fast to be seen sliding: the nearest whole row, on the line.
  return k < (roll.snap ?? 0) ? Math.round(pos) : pos;
}

/**
 * A roll from `from` to `to`, over `duration` ms when it is known. One that
 * takes over from a roll still under way sets out from where that one had
 * drawn each column, so nothing jumps. Given its length, the columns too
 * fast to be seen sliding show whole rows (`snapBelow`).
 */
export function startRoll(
  from: number,
  to: number,
  previous: Roll | null,
  duration?: number,
): Roll {
  const places = String(Math.ceil(Math.max(from, to))).length + 1;
  const lead = Array.from({ length: places }, (_, k) => {
    const shown = previous
      ? rollPosition(from, k, previous)
      : Math.floor(from / 10 ** k) % 10;
    const off = shown - digitPosition(from, k);
    // The short way round a column's ten digits.
    return off - 10 * Math.round(off / 10);
  });
  return duration === undefined
    ? { from, to, lead }
    : { from, to, lead, snap: snapBelow(to - from, duration) };
}

/**
 * The cells for `sats` in `unit`, left to right. Sats group in threes; BTC
 * has a whole part with no grouping, a point and eight decimals.
 */
export function cellsFor(sats: number, unit: Unit): OdometerCell[] {
  const digits = String(Math.abs(Math.trunc(sats)));
  const cells: OdometerCell[] = [];
  const digit = (place: number, dim = false): OdometerCell => ({
    kind: 'digit',
    key: `d${place}`,
    place,
    digit: Math.floor(Math.abs(sats) / 10 ** place) % 10,
    dim,
  });
  if (unit === 'sats') {
    for (let place = digits.length - 1; place >= 0; place--) {
      cells.push(digit(place));
      if (place > 0 && place % 3 === 0) {
        cells.push({ kind: 'mark', key: `m${place}`, char: ',', place });
      }
    }
    return cells;
  }
  const top = Math.max(BTC_PLACES, digits.length - 1);
  // Decimals below the last significant digit dim; all eight for no amount.
  const trailing = sats
    ? digits.length - digits.replace(/0+$/, '').length
    : BTC_PLACES;
  for (let place = top; place >= 0; place--) {
    cells.push(digit(place, place < BTC_PLACES && place < trailing));
    if (place === BTC_PLACES) {
      cells.push({ kind: 'mark', key: 'point', char: '.', place });
    }
  }
  return cells;
}

/**
 * The cells a roll from `from` to `to` passes through: the target's, plus
 * any leading column only the other end has, so a digit that is going away
 * rolls down to blank before it leaves and one that is arriving rolls up
 * from blank. A leading place stays blank, and its cell and the separator
 * after it shut, while the amount is below it (`leadingZero`, `cellOpen`).
 */
export function rollCells(from: number, to: number, unit: Unit) {
  const target = cellsFor(to, unit);
  const wide = cellsFor(Math.max(Math.abs(from), Math.abs(to)), unit);
  if (wide.length === target.length) return target;
  const kept = new Map(target.map(cell => [cell.key, cell]));
  return wide.map(cell => kept.get(cell.key) ?? cell);
}

/** The hero's sizes, largest first: it takes the first the amount fits. */
export const HERO_SIZES = [64, 56, 48, 40];
/**
 * A tabular figure's advance as a share of its size. The hero picks its
 * size before it draws, so a balance never changes size mid-roll, and this
 * errs a little wide, since the system faces' figures sit just under it.
 */
const FIGURE_EM = 0.6;
/** The unit beside the hero, at heroUnit's 15pt, and the gap before it. */
const UNIT_EM = 0.62;
const UNIT_SIZE = 15;
const UNIT_GAP = 6;
/** The unit to the figures it sits beside, as the line figures have it. */
const UNIT_TO_FIGURE = 15 / 20;

/**
 * How much the unit is scaled against its container's `scaled`, beside
 * figures set at `fontSize`, so it reads as it would beside figures of the
 * size they are drawn at: never over its own 15pt, never smaller than the
 * container would draw it, and otherwise three quarters of the figures, as
 * the unit beside the 20pt line figures is. So the hero's unit keeps 15pt as
 * it shrinks into the mini strip, where the container alone would draw it
 * at 5, and a hero stepped down for a long BTC amount keeps it in step.
 */
export function unitScaleFor(scaled: number, fontSize: number): number {
  'worklet';
  const drawn = UNIT_SIZE * scaled;
  const wanted = Math.min(
    UNIT_SIZE,
    Math.max(drawn, UNIT_TO_FIGURE * fontSize * scaled),
  );
  return drawn > 0 ? wanted / drawn : 1;
}

/**
 * The hero's font size for `figures` digits (and a sign and the bitcoin
 * sign, if any) and `marks` separators beside `suffix`, if any, in `room`
 * points at `scale` times the type size: 64, stepping down to 56, 48 and 40
 * until it fits, and 40 when nothing does. Never `adjustsFontSizeToFit`,
 * which would shrink it per frame.
 *
 * The bitcoin sign is drawn in the figures' face at SYMBOL_SCALE of their
 * size, and counts as that share of a figure. U+20BF is no wider than a
 * zero in the iOS system face or in Android's Roboto 3. Android 11 and
 * earlier, whose Roboto lacks it, draw it from Noto Sans Symbols a little
 * wider, 0.65em, within what FIGURE_EM already allows over the other
 * figures. Either way it takes less room than "sats" and its gap, so a
 * balance in `₿` is never drawn smaller than in sats.
 */
export function heroSize(
  figures: number,
  marks: number,
  suffix: string,
  room: number,
  scale: number,
): number {
  const unit = suffix ? suffix.length * UNIT_EM * UNIT_SIZE + UNIT_GAP : 0;
  const fits = (size: number) => {
    const figure = FIGURE_EM * size + heroSpacing(size);
    return (figures * figure + marks * MARK_EM * size + unit) * scale <= room;
  };
  return HERO_SIZES.find(fits) ?? HERO_SIZES[HERO_SIZES.length - 1];
}

/**
 * A cell's height: one line box of its figures, in whole pixels rounded up
 * as Android sets a line with a line height, so a column's rows step by
 * exactly what the cell shows and nothing of the next row is in it.
 */
export function cellHeight(
  lineHeight: number,
  scale: number,
  ratio: number,
): number {
  return Math.ceil(lineHeight * scale * ratio - 1e-6) / ratio;
}

/** The hero's tracking, which tightens with its size. */
function heroSpacing(size: number): number {
  return ((typography.hero.letterSpacing ?? 0) * size) / HERO_SIZES[0];
}

/** A roll's length: longer for a bigger change, never slow. */
export function rollDuration(delta: number): number {
  return Math.min(
    1100,
    Math.max(280, 280 + 140 * Math.log10(Math.abs(delta) + 1)),
  );
}

export const SCRAMBLE_JUMPS = 4;
const SCRAMBLE_STEP_MS = 40;

/**
 * The digit a column shows `s` jumps into a scramble (0 to 4). Hiding starts
 * on the real digit and jumps four times; showing jumps four times and lands
 * on it. A jump never shows the column's own digit.
 */
export function scrambleDigit(
  digit: number,
  place: number,
  s: number,
  landing: boolean,
): number {
  'worklet';
  const jump = Math.min(SCRAMBLE_JUMPS, Math.max(0, Math.floor(s)));
  if (landing ? jump === SCRAMBLE_JUMPS : jump === 0) return digit;
  return (digit + 1 + ((place * 7 + jump * 3) % 9)) % 10;
}

const DIP_MS = 420;
const DIP_STEP_MS = 60;

/**
 * Cell `index`'s opacity `ms` into the stale shimmer: each cell in turn
 * dips to .65 and back, 60ms after the one before it.
 */
export function staleDip(ms: number, index: number): number {
  'worklet';
  const t = ms - index * DIP_STEP_MS;
  if (t <= 0 || t >= DIP_MS) return 1;
  return 1 - 0.35 * Math.sin((Math.PI * t) / DIP_MS);
}

/**
 * What the cells are doing: at rest, rolling to a new amount, or scrambling
 * on the way to the mask or back from it.
 */
export type OdometerPhase = 'rest' | 'roll' | 'scramble' | 'unscramble';

interface Reading {
  sats: number;
  unit: Unit;
  masked: boolean;
}

/**
 * The phase a change from `before` to `after` starts. A new unit swaps the
 * cells rather than rolling them, and nothing moves under a mask or under
 * Reduce Motion, where the cells crossfade instead.
 */
export function nextPhase(
  before: Reading,
  after: Reading,
  current: OdometerPhase,
  reduced: boolean,
): OdometerPhase {
  if (reduced) return 'rest';
  if (before.masked !== after.masked) {
    return after.masked ? 'scramble' : 'unscramble';
  }
  if (after.masked) return current === 'scramble' ? current : 'rest';
  if (before.unit !== after.unit) return 'rest';
  if (before.sats !== after.sats) {
    return current === 'unscramble' ? current : 'roll';
  }
  return current;
}

const VARIANTS: Record<OdometerVariant, TextStyle> = {
  hero: typography.hero,
  amount: typography.amount,
  amountDetail: typography.amountDetail,
  line: typography.line,
  row: typography.row,
};

/** The hero at each of its sizes, its line height and tracking in step. */
const HERO_AT: Record<number, TextStyle> = Object.fromEntries(
  HERO_SIZES.map(size => [
    size,
    {
      ...typography.hero,
      fontSize: size,
      lineHeight: Math.round(
        ((typography.hero.lineHeight ?? 0) * size) / HERO_SIZES[0],
      ),
      letterSpacing: heroSpacing(size),
    },
  ]),
);

/** Big figures stop growing sooner, so they never outrun the screen. */
const MAX_SCALE: Record<OdometerVariant, number> = {
  hero: 1.2,
  amount: 1.2,
  amountDetail: 1.2,
  line: 1.4,
  row: 1.4,
};

/** A separator is narrower than a digit: .30em. */
const MARK_EM = 0.3;
const STALE_FADE_MS = 600;
const COLUMN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const DOTS = [...MASK];
const CELL_STEP_MS = 12;
const DOT_STEP_MS = 20;
/** How far a cell lifts as it leaves and rises as it arrives. */
const CELL_RISE = 8;

/** A cell arriving: it rises into place on the snap spring. */
function cellIn(index: number, reduced: boolean) {
  if (reduced) return CROSSFADE_IN;
  const delay = index * CELL_STEP_MS;
  const enter: EntryExitAnimationFunction = () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ translateY: CELL_RISE }] },
      animations: {
        opacity: withDelay(
          delay,
          withTiming(1, { duration: durations.enter, easing: curves.enter }),
        ),
        transform: [
          { translateY: withDelay(delay, withSpring(0, springs.snap)) },
        ],
      },
    };
  };
  return enter;
}

/**
 * How a cell arrives: risen by a swap, or faded if reduced. One a roll
 * brings in comes in shut and blank and opens as the amount reaches its
 * place, on the UI thread with the roll (`cellOpen`), so it has no entrance
 * of its own: a width grown on a clock of its own cut the digit in it to a
 * sliver, and the cells beside it slid across the ones already shown.
 */
function arrival(index: number, rolling: boolean, reduced: boolean) {
  return rolling && !reduced ? undefined : cellIn(index, reduced);
}

/** A cell leaving: it lifts and fades, a beat after the one to its left. */
function cellOut(index: number, reduced: boolean) {
  if (reduced) return CROSSFADE_OUT;
  const delay = index * CELL_STEP_MS;
  const exit: EntryExitAnimationFunction = () => {
    'worklet';
    const config = { duration: durations.exit, easing: curves.exit };
    return {
      initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
      animations: {
        opacity: withDelay(delay, withTiming(0, config)),
        transform: [
          { translateY: withDelay(delay, withTiming(-CELL_RISE, config)) },
        ],
      },
    };
  };
  return exit;
}

/** A mask dot arriving: it scales in on the snap spring. */
function dotIn(index: number, reduced: boolean) {
  if (reduced) return CROSSFADE_IN;
  const delay = index * DOT_STEP_MS;
  const enter: EntryExitAnimationFunction = () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ scale: 0.3 }] },
      animations: {
        opacity: withDelay(
          delay,
          withTiming(1, { duration: durations.exit, easing: curves.enter }),
        ),
        transform: [{ scale: withDelay(delay, withSpring(1, springs.snap)) }],
      },
    };
  };
  return enter;
}

/** The figures crossfade as the hero steps to another size. */
const STEP_IN = FadeIn.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);
const STEP_OUT = FadeOut.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);

/**
 * Whether the figures crossfade on the way from one size to the next: only
 * for a step with the face unchanged (the unit, and whether the bitcoin
 * sign stands before it), whose cells would otherwise jump, and only
 * between sizes fitted to the same room, so the first measure does not fade
 * the hero in again. A new face swaps the cells instead.
 */
export function stepsSize(
  before: { face: string; size: number; measured: boolean },
  after: { face: string; size: number; measured: boolean },
): boolean {
  return (
    before.face === after.face &&
    before.measured === after.measured &&
    before.size !== after.size
  );
}

/** Reduce Motion: values swap with a 120ms crossfade. */
const CROSSFADE_MS = 120;
const CROSSFADE_IN = FadeIn.duration(CROSSFADE_MS).reduceMotion(
  ReduceMotion.Never,
);
const CROSSFADE_OUT = FadeOut.duration(CROSSFADE_MS).reduceMotion(
  ReduceMotion.Never,
);

/** What every cell of one odometer shares. */
interface Rig {
  v: SharedValue<number>;
  roll: SharedValue<Roll>;
  s: SharedValue<number>;
  shimmer: SharedValue<number>;
  /** A figure's width, as the ones cell was laid out, once it has been. */
  figure: SharedValue<number>;
  /** The highest place always drawn (`floorPlace`). */
  floor: number;
  /** The ink, which turns steam when stale. */
  ink: object;
  text: TextStyle[];
  height: number;
  markWidth: number;
  maxScale: number;
  reduced: boolean;
}

type Motion = 'still' | 'roll' | 'scramble' | 'unscramble';

function useShimmer(shimmer: SharedValue<number>, index: number) {
  return useAnimatedStyle(
    () => ({
      opacity: staleDip(fract(shimmer.get()) * durations.shimmer, index),
    }),
    [index],
  );
}

/**
 * A cell's width while a roll brings its place in or takes it away: shut
 * while the place is a leading zero, opening as its digit rolls in
 * (`cellOpen`), and its own otherwise, so the cells beside it close up on
 * the UI thread, frame by frame with the roll, and no two are ever drawn
 * over one another. `set` is a separator's width, which it has open; a
 * digit's is a figure's, which the ones cell measures.
 */
function useOpening(rig: Rig, place: number, rolling: boolean, set?: number) {
  const { v, roll, figure, floor } = rig;
  const mark = set ?? 0;
  return useAnimatedStyle(() => {
    if (!rolling || place <= floor) return { width: mark > 0 ? mark : 'auto' };
    const at = v.get();
    const open = cellOpen(
      placeInk(at, place, floor, rollPosition(at, place, roll.get())),
    );
    return { width: mark > 0 ? mark * open : openWidth(open, figure.get()) };
  }, [rolling, place, floor, mark]);
}

/**
 * A column's rows of one parity, even (0) or odd (1), with a gap where each
 * row of the other parity sits, rolled to where the column stands and faded
 * by its one row in view.
 */
const ColumnRows = memo(function DigitColumnRows({
  parity,
  place,
  digit,
  dim,
  motion,
  rig,
}: {
  parity: number;
  place: number;
  digit: number;
  dim: boolean;
  motion: Motion;
  rig: Rig;
}) {
  const { v, roll, s, height, floor } = rig;
  const style = useAnimatedStyle(() => {
    const rolling = motion === 'roll';
    const at = v.get();
    const pos = rolling
      ? rollPosition(at, place, roll.get())
      : scrambleDigit(digit, place, s.get(), motion === 'unscramble');
    const row = rowInView(pos, parity);
    return {
      // A leading zero is blank: a digit rolls in over nothing.
      opacity: rolling ? rowInk(row, pos, at, place, floor) : rowFade(row, pos),
      transform: [{ translateY: -pos * height }],
    };
  }, [parity, motion, place, digit, height, floor]);
  return (
    <Reanimated.View style={[parity ? styles.over : undefined, style]}>
      {COLUMN.map((d, i) =>
        i % 2 === parity ? (
          <Reanimated.Text
            key={i}
            style={[...rig.text, { height }, dim ? styles.dim : rig.ink]}
            maxFontSizeMultiplier={rig.maxScale}
          >
            {d}
          </Reanimated.Text>
        ) : (
          <View key={i} style={{ height }} />
        ),
      )}
    </Reanimated.View>
  );
});

/**
 * A digit's column while it moves: the even rows in the cell's flow, which
 * size it, and the odd rows over them.
 */
function Column(props: {
  place: number;
  digit: number;
  dim: boolean;
  motion: Motion;
  rig: Rig;
}) {
  return (
    <>
      <ColumnRows parity={0} {...props} />
      <ColumnRows parity={1} {...props} />
    </>
  );
}

const DigitCell = memo(function OdometerDigit({
  place,
  digit,
  dim,
  index,
  motion,
  rig,
}: {
  place: number;
  digit: number;
  dim: boolean;
  index: number;
  motion: Motion;
  rig: Rig;
}) {
  const wave = useShimmer(rig.shimmer, index);
  const opens = useOpening(rig, place, motion === 'roll');
  // The ones are always drawn, so they measure a figure's width for the
  // cells that open (`openWidth`).
  const { figure } = rig;
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => figure.set(event.nativeEvent.layout.width),
    [figure],
  );
  return (
    <Reanimated.View
      entering={arrival(index, motion === 'roll', rig.reduced)}
      exiting={cellOut(index, rig.reduced)}
      onLayout={place === 0 ? onLayout : undefined}
      style={[styles.cell, { height: rig.height }, wave, opens]}
    >
      {motion === 'still' ? (
        <Reanimated.Text
          style={[
            ...rig.text,
            { height: rig.height },
            dim ? styles.dim : rig.ink,
          ]}
          maxFontSizeMultiplier={rig.maxScale}
        >
          {digit}
        </Reanimated.Text>
      ) : (
        <Column
          place={place}
          digit={digit}
          dim={dim}
          motion={motion}
          rig={rig}
        />
      )}
    </Reanimated.View>
  );
});

const MarkCell = memo(function OdometerMark({
  char,
  place,
  index,
  rolling,
  rig,
}: {
  char: string;
  /** The place the separator follows, which it shows with. */
  place: number;
  index: number;
  rolling: boolean;
  rig: Rig;
}) {
  const wave = useShimmer(rig.shimmer, index);
  const opens = useOpening(rig, place, rolling, rig.markWidth);
  const { v, roll, floor } = rig;
  const shows = useAnimatedStyle(() => {
    if (!rolling || place <= floor) return { opacity: 1 };
    const at = v.get();
    return {
      opacity: placeInk(at, place, floor, rollPosition(at, place, roll.get())),
    };
  }, [rolling, place, floor]);
  return (
    <Reanimated.View
      entering={arrival(index, rolling, rig.reduced)}
      exiting={cellOut(index, rig.reduced)}
      style={[
        styles.cell,
        { height: rig.height, width: rig.markWidth },
        wave,
        opens,
      ]}
    >
      <Reanimated.Text
        style={[...rig.text, styles.mark, rig.ink, shows]}
        maxFontSizeMultiplier={rig.maxScale}
      >
        {char}
      </Reanimated.Text>
    </Reanimated.View>
  );
});

const DotCell = memo(function OdometerDot({
  index,
  rig,
}: {
  index: number;
  rig: Rig;
}) {
  return (
    <Reanimated.View
      entering={dotIn(index, rig.reduced)}
      exiting={rig.reduced ? CROSSFADE_OUT : cellOut(0, false)}
      style={[styles.cell, { height: rig.height }]}
    >
      <Reanimated.Text
        style={[...rig.text, rig.ink]}
        maxFontSizeMultiplier={rig.maxScale}
      >
        {DOTS[index]}
      </Reanimated.Text>
    </Reanimated.View>
  );
});

export function Odometer({
  sats,
  unit,
  symbol = false,
  masked = false,
  stale = false,
  variant,
  color = palette.cream,
  sign = null,
  room,
  duration,
  countUp,
  scaled,
  accessibilityLabel,
}: OdometerProps) {
  const { reduced } = useMotionPrefs();
  const awake = useAwake();
  const { fontScale, width } = useWindowDimensions();

  // A count up as it mounts is a roll from 0 from the first frame, its
  // columns drawn at 0 until it sets out.
  const [counts] = useState(
    () => countUp !== undefined && !masked && !reduced && sats !== 0,
  );
  // Where the cells were last asked to be, and what they are doing about
  // it. A change is read during the render that brings it, so the first
  // frame of a roll already draws columns rather than the new digits.
  const [seen, setSeen] = useState(() => ({
    sats,
    unit,
    masked,
    phase: (counts ? 'roll' : 'rest') as OdometerPhase,
    // The widest amount the current roll has passed through.
    span: Math.abs(sats),
  }));
  let now = seen;
  if (seen.sats !== sats || seen.unit !== unit || seen.masked !== masked) {
    const phase = nextPhase(seen, { sats, unit, masked }, seen.phase, reduced);
    const from = seen.phase === 'roll' ? seen.span : Math.abs(seen.sats);
    const span =
      phase === 'roll' ? Math.max(from, Math.abs(sats)) : Math.abs(sats);
    now = { sats, unit, masked, phase, span };
    setSeen(now);
  }
  const { phase, span } = now;
  const settle = useCallback(
    () =>
      setSeen(last => ({ ...last, phase: 'rest', span: Math.abs(last.sats) })),
    [],
  );

  // The columns count the amount's size; a sign is drawn on its own.
  const target = Math.abs(sats);
  const v = useSharedValue(counts ? 0 : target);
  const roll = useSharedValue<Roll>({ from: target, to: target, lead: [] });
  const rolling = useRef<Roll | null>(null);
  // How long the count as it mounts waits to set out, used by its roll.
  const wait = useRef(counts ? countUp ?? 0 : 0);
  useEffect(() => {
    cancelAnimation(v);
    const delay = wait.current;
    wait.current = 0;
    if (phase !== 'roll') {
      rolling.current = null;
      v.set(target);
      return;
    }
    const from = v.get();
    const length = duration ?? rollDuration(target - from);
    const next = startRoll(from, target, rolling.current, length);
    rolling.current = next;
    roll.set(next);
    const run = withTiming(
      target,
      {
        duration: length,
        easing: curves.standard,
      },
      done => {
        'worklet';
        if (done) scheduleOnRN(settle);
      },
    );
    v.set(delay > 0 ? steady(withDelay(delay, run)) : run);
  }, [v, roll, phase, target, settle, duration]);

  const s = useSharedValue(0);
  useEffect(() => {
    if (phase !== 'scramble' && phase !== 'unscramble') return;
    cancelAnimation(s);
    s.set(0);
    s.set(
      withTiming(
        SCRAMBLE_JUMPS,
        {
          duration: SCRAMBLE_JUMPS * SCRAMBLE_STEP_MS,
          easing: curves.linear,
        },
        done => {
          'worklet';
          if (done) scheduleOnRN(settle);
        },
      ),
    );
  }, [s, phase, settle]);

  const dull = useSharedValue(stale ? 1 : 0);
  useEffect(() => {
    if (dull.get() === (stale ? 1 : 0)) return;
    dull.set(
      withTiming(stale ? 1 : 0, {
        duration: STALE_FADE_MS,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [dull, stale]);
  const ink = useAnimatedStyle(
    () => ({ color: mixHex(color, palette.steam, dull.get()) }),
    [color],
  );
  const shimmer = useLoop(durations.shimmer, stale && awake && !reduced);

  const dots = masked && phase !== 'scramble';
  // A masked amount is its dots alone: a sign would say which way it went.
  // Its unit stays, before the dots or after them, as it says nothing.
  const signed = masked ? null : sign;
  const { prefix, suffix } = unitAffixes(unit, symbol);
  // What the cells are drawn in: a tap from sats to ₿ swaps them as one to
  // BTC does, rather than sliding the same cells over to make room.
  const face = `${prefix}${unit}`;
  const motion: Motion = phase === 'rest' ? 'still' : phase;
  const cells =
    phase === 'roll' ? rollCells(span, sats, unit) : cellsFor(sats, unit);

  const maxScale = MAX_SCALE[variant];
  const scale = Math.min(fontScale, maxScale);
  // The hero sizes itself to what it draws, across the page between its
  // edges. A roll draws its widest end throughout, so it never resizes
  // midway, and a mask is sized as its six dots, so a hidden balance does
  // not give away how long it is.
  const marks = dots ? 0 : cells.filter(cell => cell.kind === 'mark').length;
  const figures =
    (dots ? DOTS.length : cells.length - marks) +
    (signed ? 1 : 0) +
    prefix.length * SYMBOL_SCALE;
  const measured = room !== undefined;
  const fitted = heroSize(
    figures,
    marks,
    suffix,
    room ?? width - 2 * space.xl,
    scale,
  );
  const base = variant === 'hero' ? HERO_AT[fitted] : VARIANTS[variant];
  // Each step to another size in the same face keys the figures afresh, so
  // the old ones fade out as the new ones fade in.
  const size = base.fontSize ?? 0;
  // In the figures' line box. In a row or a line it stands on their baseline,
  // its top level with theirs; beside large figures it is centred on them
  // and drawn in to their spacing, but not beside the mask's dots.
  const textual = variant === 'row' || variant === 'line';
  const share = textual ? TEXT_SYMBOL_SCALE : SYMBOL_SCALE;
  const symbolStyle = [
    textual
      ? { fontSize: size * share }
      : symbolBeside(size, base.lineHeight ?? size, scale, !dots),
    { letterSpacing: (base.letterSpacing ?? 0) * share },
  ];
  const [step, setStep] = useState({ face, size, measured, count: 0 });
  if (step.face !== face || step.size !== size || step.measured !== measured) {
    const next = { face, size, measured };
    setStep({
      ...next,
      count: step.count + (stepsSize(step, next) ? 1 : 0),
    });
  }
  const received = variant === 'row' && sign === '+';
  const figure = useSharedValue(0);
  const floor = floorPlace(unit);
  const rig = useMemo<Rig>(
    () => ({
      v,
      roll,
      s,
      shimmer,
      figure,
      floor,
      ink,
      text: received
        ? [base, styles.figure, styles.received]
        : [base, styles.figure],
      height: cellHeight(base.lineHeight ?? 0, scale, PixelRatio.get()),
      markWidth: MARK_EM * (base.fontSize ?? 0) * scale,
      maxScale,
      reduced,
    }),
    [
      v,
      roll,
      s,
      shimmer,
      figure,
      floor,
      ink,
      base,
      received,
      scale,
      maxScale,
      reduced,
    ],
  );
  // Under Reduce Motion a changed digit is a new cell, so it crossfades
  // with the old one in place instead of changing under the eye.
  const keyOf = (cell: OdometerCell) =>
    `${face}${cell.key}${
      reduced && cell.kind === 'digit' ? `:${cell.digit}` : ''
    }`;

  // Shrunk by its container, the unit holds a readable size, grown about
  // its left end near its baseline, and the whole shifts left by half of
  // what the unit grew, so it stays centred. The bitcoin sign is one of the
  // figures, and shrinks with them.
  const unitWidth = useSharedValue(0);
  const counter = useAnimatedStyle(() => {
    if (!scaled) return {};
    return { transform: [{ scale: unitScaleFor(scaled.get(), size) }] };
  }, [scaled, size]);
  const centred = useAnimatedStyle(() => {
    if (!scaled) return {};
    const grown = suffix ? unitScaleFor(scaled.get(), size) - 1 : 0;
    return { transform: [{ translateX: (-unitWidth.get() * grown) / 2 }] };
  }, [scaled, size, suffix]);
  const unitText = suffix ? (
    <Reanimated.Text
      key={unit}
      entering={cellIn(0, reduced)}
      exiting={cellOut(0, reduced)}
      style={[typography.heroUnit, styles.unit]}
      maxFontSizeMultiplier={maxScale}
    >
      {suffix}
    </Reanimated.Text>
  ) : null;

  const label =
    accessibilityLabel ??
    (masked ? copy.amount.hidden : copy.amount.spoken(sats));
  // The hero keeps the line box of its largest size whatever size it steps
  // to, its figures centred in it, so what sits under it never moves.
  const box =
    variant === 'hero'
      ? {
          minHeight: cellHeight(
            HERO_AT[HERO_SIZES[0]].lineHeight ?? 0,
            scale,
            PixelRatio.get(),
          ),
        }
      : null;
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={box ? [styles.box, box] : styles.row}
    >
      <Reanimated.View
        style={[styles.row, centred]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <LayoutAnimationConfig skipEntering>
          <Reanimated.View
            key={`size${step.count}`}
            entering={STEP_IN}
            exiting={STEP_OUT}
            style={styles.cells}
          >
            {/* One child, so only the size's own fade plays as it goes: a
                config over several children wraps each in its own, and each
                cell that left would skip its lift and vanish. */}
            <LayoutAnimationConfig skipEntering skipExiting>
              <View collapsable={false} style={styles.cells}>
                {signed ? (
                  <Reanimated.Text
                    style={[...rig.text, ink]}
                    maxFontSizeMultiplier={maxScale}
                  >
                    {signed === '-' ? '−' : '+'}
                  </Reanimated.Text>
                ) : null}
                {prefix ? (
                  <Reanimated.Text
                    entering={cellIn(0, reduced)}
                    exiting={cellOut(0, reduced)}
                    style={[...rig.text, ...symbolStyle, ink]}
                    maxFontSizeMultiplier={maxScale}
                  >
                    {prefix}
                  </Reanimated.Text>
                ) : null}
                {dots
                  ? DOTS.map((_, i) => (
                      <DotCell key={`mask${i}`} index={i} rig={rig} />
                    ))
                  : cells.map((cell, i) =>
                      cell.kind === 'digit' ? (
                        <DigitCell
                          key={keyOf(cell)}
                          place={cell.place}
                          digit={cell.digit}
                          dim={cell.dim}
                          index={i}
                          motion={motion}
                          rig={rig}
                        />
                      ) : (
                        <MarkCell
                          key={keyOf(cell)}
                          char={cell.char}
                          place={cell.place}
                          index={i}
                          rolling={phase === 'roll'}
                          rig={rig}
                        />
                      ),
                    )}
              </View>
            </LayoutAnimationConfig>
          </Reanimated.View>
          {scaled && unitText ? (
            <Reanimated.View
              onLayout={event => unitWidth.set(event.nativeEvent.layout.width)}
              style={[styles.unitBox, counter]}
            >
              {unitText}
            </Reanimated.View>
          ) : (
            unitText
          )}
        </LayoutAnimationConfig>
      </Reanimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  box: { flexDirection: 'row', alignItems: 'center' },
  cells: { flexDirection: 'row' },
  cell: { overflow: 'hidden' },
  // A figure's line box and nothing more: no font padding over it on
  // Android, and its glyphs in the middle of it.
  figure: { includeFontPadding: false, textAlignVertical: 'center' },
  over: { position: 'absolute', top: 0, left: 0, right: 0 },
  mark: { textAlign: 'center' },
  received: { fontWeight: '600' },
  dim: { color: palette.dust },
  unit: { color: palette.steam },
  // About where the unit's baseline sits in its 20pt line, so it grows up
  // and to the right from the line the figures stand on.
  unitBox: { transformOrigin: '0% 77%' },
});
