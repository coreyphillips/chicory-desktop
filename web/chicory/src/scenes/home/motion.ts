import { ReduceMotion } from 'react-native-reanimated';
import type { WithTimingConfig } from 'react-native-reanimated';
import { springStep } from '../../motion/springMath';
import { curves, overlap, springs } from '../../motion/tokens';
import {
  HERO_MINI,
  MINI_STRIP,
  PRIMARY_CONTROL,
  STATUS_ROW,
} from '../../stage/layout';

/**
 * Home's motion as plain arithmetic, so each pose is a table test and the
 * animated styles only read the answers on the UI thread. Every function
 * here is a worklet.
 */

/**
 * A colour coming or going over `duration`. It moves nothing through space,
 * so it plays under Reduce Motion too; left to the system setting,
 * Reanimated would jump to the end and the tint would never be seen
 * (REDESIGN.md 8).
 */
export function tintTiming(
  duration: number,
  easing?: WithTimingConfig['easing'],
): WithTimingConfig {
  'worklet';
  // The default is read in the body so the worklet captures it; a default
  // parameter's value is not captured and is undefined on the UI thread.
  return {
    duration,
    easing: easing ?? curves.standard,
    reduceMotion: ReduceMotion.Never,
  };
}

/**
 * A gated action's radish tint, in and out, which stands in for its shake
 * under Reduce Motion: 400ms in all.
 */
export const REFUSED = { in: 80, out: 320 };

/**
 * How far a pull on the home pane travels before letting go refreshes, in
 * points of finger travel.
 */
export const PULL_TRIGGER = 88;

/** How much further the pane gives once the pull is past the trigger. */
const PULL_GIVE = 28;

/**
 * How far the pane follows a pull of `dy` points: half the finger's travel
 * up to the trigger, then less and less, so it never runs away from the
 * top of the screen.
 */
export function pullOffset(dy: number): number {
  'worklet';
  if (dy <= 0) return 0;
  const toTrigger = Math.min(dy, PULL_TRIGGER) / 2;
  const past = Math.max(0, dy - PULL_TRIGGER);
  return toTrigger + PULL_GIVE * (1 - Math.exp(-past / PULL_GIVE));
}

/** How far the pull is toward a refresh, from 0 to 1. */
export function pullProgress(dy: number): number {
  'worklet';
  return Math.min(1, Math.max(0, dy / PULL_TRIGGER));
}

/** The hero's resting box inside the home pane, as it was last laid out. */
export interface HeroFrame {
  y: number;
  height: number;
}

/**
 * Where the mini strip's middle lands, in points below the top of the home
 * pane, which starts under the status row: in the band Send and Receive
 * leave clear there (MINI_STRIP), or, where the sheet's compact stop leaves
 * no band, as under Activity and a payment's detail, in the middle of the
 * status row itself, between the mark and the corner control.
 */
export const MINI_IN_BAND = MINI_STRIP / 2;
export const MINI_IN_ROW = -STATUS_ROW / 2;

/** Where the mini strip lands on the way to `launch`. */
export function miniLanding(launch: Launch): number {
  'worklet';
  return launch === 'none' ? MINI_IN_ROW : MINI_IN_BAND;
}

/**
 * The hero at `hero`, from the full balance (1) to the mini strip (0).
 *
 * It scales from its top edge, and rises as it shrinks, so the mini strip
 * lands centred on `landing` (see MINI_IN_BAND), where no scene's content
 * reaches.
 */
export function heroPose(
  hero: number,
  frame: HeroFrame,
  landing?: number,
): { scale: number; translateY: number } {
  'worklet';
  // Read in the body, where the worklet captures it (see tintTiming).
  const lift =
    frame.y + (HERO_MINI * frame.height) / 2 - (landing ?? MINI_IN_ROW);
  return {
    scale: HERO_MINI + (1 - HERO_MINI) * hero,
    translateY: lift * (hero - 1),
  };
}

/** Where the hero stands in a frame: how far expanded, and where it lands. */
export interface HeroStand {
  hero: number;
  landing: number;
}

/**
 * Which of the hero's two figures is drawn, 0 the total and 1 what can be
 * spent (REDESIGN.md 7, T1): `want` once the move toward it is under way,
 * which it knows by the hero standing somewhere else this frame, `now`,
 * than the frame before, and `shown` until then. So the full balance never
 * changes its figure before anything moves, where it reads as money gone,
 * and the strip never changes it while the scene it belongs to is still
 * drawn whole. `before` is null for the first frame looked at.
 */
export function figureShown(
  shown: number,
  want: number,
  now: HeroStand,
  before: HeroStand | null,
): number {
  'worklet';
  if (shown === want || !before) return shown;
  const moved = now.hero !== before.hero || now.landing !== before.landing;
  return moved ? want : shown;
}

/**
 * The vessel under the hero fades over the first .3 of the way to the mini
 * strip (REDESIGN.md 7, T5), so it is gone before the hero has shrunk much.
 */
export function vesselOpacity(hero: number): number {
  'worklet';
  return Math.min(1, Math.max(0, (hero - 0.7) / 0.3));
}

/** Which action circle opened the scene the canvas is heading to. */
export type Launch = 'none' | 'send' | 'receive';

/**
 * Whether the action row is back from Send or Receive, with the bar at `bar`
 * and, the frame before, at `before`: once it is whole again, or once it
 * falls back on the way, which the canvas never does, since it brings the
 * row home from rest on the pane spring. Only a hand does, as when the
 * sheet's drag takes the row before the canvas has brought it all the way.
 * Either way the circle that opened the scene has come home, and from then
 * on it moves with the row.
 */
export function rowBack(bar: number, before: number | null): boolean {
  'worklet';
  return bar >= 1 || (before !== null && bar < before);
}

/** The Send and Receive circles are 56pt; the scene's own control is 88. */
const LAUNCH_FROM = 56;

/**
 * How far the tapped circle drops toward the bottom as it goes, when where
 * it lands is not known, as when Home is drawn off the canvas.
 */
export const LAUNCH_DROP = 96;

/** A circle's pose in the action row. */
export interface CirclePose {
  scale: number;
  translateX: number;
  translateY: number;
}

const AT_REST: CirclePose = { scale: 1, translateX: 0, translateY: 0 };

const clamp01 = (x: number) => {
  'worklet';
  return Math.min(1, Math.max(0, x));
};

/**
 * How much of its way the tapped circle has gone when the row is `away`
 * gone: a smoothstep of the pane spring's own progress, so it sets out a
 * little behind the panes and lands well ahead of the spring's long tail,
 * the same both ways. Going to the scene it is on the control, within half
 * a point, about 300ms after the panes set out, where the spring alone would
 * take 420; coming home it is back in the row as the other two settle, so
 * the three land together.
 */
export function launchTravel(away: number): number {
  'worklet';
  const a = clamp01(away);
  return a * a * (3 - 2 * a);
}

/** How near the control the circle counts as landed on it, in points. */
export const LANDED_PT = 0.5;

/**
 * Whether the tapped circle, `distance` points from the control it lands on
 * when it sets out, is on it at `away`: the hand-over starts there, when it
 * has arrived, rather than on a clock (REDESIGN.md 7, T1).
 */
export function landedAt(away: number, distance: number): boolean {
  'worklet';
  return (1 - launchTravel(away)) * distance <= LANDED_PT;
}

/**
 * The scale the tapped circle's glyph is drawn at inside the circle, `m` of
 * the way to the control. The glyph is drawn once, at the size it lands at:
 * the control's `to` points, the control drawn at `scale`, with the
 * control's stroke. The circle grows from `size` into the control, drawn at
 * `scale`, and carries the glyph with it, so the glyph is shrunk against
 * that growth, and on screen it grows from `glyph` points at home to the
 * control's glyph, in step with the circle. Its whole scale on screen is
 * never above 1: a drawing is only ever shrunk, never a bitmap enlarged
 * into a soft, heavy line, and its line keeps the control's weight for its
 * size all the way, the control's own once it lands.
 */
export function glyphScale(
  m: number,
  glyph: number,
  size: number,
  to: number,
  scale: number,
): number {
  'worklet';
  const t = clamp01(m);
  const landed = to * scale;
  const shown = glyph + (landed - glyph) * t;
  const grown = 1 + ((PRIMARY_CONTROL * scale) / size - 1) * t;
  return shown / (landed * grown);
}

/** One frame at 60fps, in ms. */
const FRAME_MS = 1000 / 60;

/**
 * How far along the pane spring the circles not tapped are gone: where it
 * is a frame before the scene's content sets out (`overlap.enterDelay`),
 * about 28% of the way at 63ms, so they are never drawn over what arrives
 * (REDESIGN.md 7, T1). At two thirds, 140ms, they still showed at a third
 * across Send's amount and Receive's chips.
 */
export const OTHERS_GONE = springStep(
  (overlap.enterDelay - FRAME_MS) / 1000,
  springs.pane,
);

/** The last share of the way, over which the tapped circle hands over. */
const HANDOVER = 0.3;

/**
 * One circle's opacity as the row goes away, `away` running from 0 at home
 * to 1 once it has gone. With nothing launching it is the row's own fade,
 * which the sheet's drag shapes (T5). On the way to Send or Receive the
 * circles not tapped are gone before the scene's content enters (T1,
 * `OTHERS_GONE`), and the tapped one stays
 * whole while it travels and grows. On the canvas it stays whole where it
 * lands, standing in for the scene's own control, until `handover` (0 to 1)
 * says the control has come in over it; drawn on its own it hands over
 * across the last 30% of the way. Coming back, each comes in the same way
 * in reverse.
 */
export function circleOpacity(
  away: number,
  tapped: boolean,
  launch: Launch,
  handover?: number,
): number {
  'worklet';
  if (launch === 'none') return clamp01(1 - away);
  if (tapped) {
    return handover === undefined
      ? clamp01((1 - away) / HANDOVER)
      : clamp01(1 - handover);
  }
  return clamp01(1 - away / OTHERS_GONE);
}

/**
 * One circle of the action row while the row fades on the way to Send or
 * Receive (REDESIGN.md 7, T1 and T2). `away` runs from 0 at home to 1 once
 * the row has gone. The tapped circle travels to the bottom centre, where
 * the scene draws its own 88pt control, `toCentre` points across and `drop`
 * points down, and grows from 56 to `size` (88, or as the control is drawn)
 * into it, on `launchTravel`; the others shrink to .8, done by the time the
 * row is half gone. With nothing launching the row is at rest.
 */
export function launchPose(
  away: number,
  tapped: boolean,
  launch: Launch,
  toCentre = 0,
  drop?: number,
  size?: number,
): CirclePose {
  'worklet';
  if (launch === 'none') return AT_REST;
  if (tapped) {
    // Read in the body, where the worklet captures it (see tintTiming).
    const t = launchTravel(away);
    const grown = (size ?? PRIMARY_CONTROL) / LAUNCH_FROM - 1;
    return {
      scale: 1 + grown * t,
      translateX: toCentre * t,
      translateY: (drop ?? LAUNCH_DROP) * t,
    };
  }
  return {
    scale: 1 - 0.2 * Math.min(1, away * 2.2),
    translateX: 0,
    translateY: 0,
  };
}
