import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { GestureResponderEvent, LayoutChangeEvent } from 'react-native';
import Reanimated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import type { WalletRecord } from '@beignet/wallet-core';
import { copy } from '../design/copy';
import { GLYPHS, Glyph, strokeFor } from '../design/glyphs';
import type { GlyphName, GlyphPart } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { alpha, mixHex, palette } from '../design/palette';
import { fract, useAwake, useLoop, wave } from '../motion/loops';
import { curves, durations, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { unreachableSats, vesselVisual } from '../scenes/home/visual';
import type { VesselVisual } from '../scenes/home/visual';
import { Unplugged } from '../scenes/send/LoopingGlyphs';
import { usePaneActive } from '../stage/panes/Pane';
import { radius, space, type as typography } from '../theme';
import type { Unit } from '../theme';
import { inlineAmount } from './InlineAmount';
import { Whisper } from './Whisper';

/**
 * The pill under the hero: what can be spent now, solid, beside what is on
 * its way, as glass (REDESIGN.md 5, Vessel). `vesselVisual` decides how it
 * looks; this draws and moves that.
 *
 * It is a hairline while everything is spendable and swells when money is
 * in flight or out of reach. Light sweeps the glass, seeds bob in it below
 * the channel floor, and the glyph on its right end names why the money
 * waits. Money in a channel that is not connected, more than a reserve
 * explains (`unreachableSats`), takes the left end as a honey hatch, with
 * the unplug on that end drifting while it lasts. When money moves into
 * the channel the solid part grows into the glass and a cream ripple runs
 * along the seam. A tap opens it wide enough to show both figures for
 * three seconds, which a screen reader already has in the label.
 *
 * `stale` dims it with the hero. A hidden balance hides the split too, since
 * the proportion alone says something.
 *
 * On a test network slate stands in for bloom, in the solid part, the glass
 * and the glyph, so play money never looks like real money.
 *
 * Why the money waits is said as well as drawn: the label reads the split,
 * the value names the wait, and a long press on the glyph whispers it
 * (REDESIGN.md rule 3).
 */
export interface VesselProps {
  availableSats: number;
  pendingSats: number;
  /**
   * The whole balance. What it holds past what can be sent and what is
   * arriving is out of reach, once a reserve cannot explain it.
   */
  totalSats?: number;
  lfbw?: WalletRecord['lfbw'];
  /**
   * Whether the primary is connected. Only a disconnection says the money
   * out of reach is in a channel that is away (`VesselVisual['reach']`).
   */
  connected?: boolean;
  unit: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  masked?: boolean;
  stale?: boolean;
  /** A test network's wallet: slate stands in for bloom (REDESIGN.md 3.1). */
  test?: boolean;
}

/** Glass is a colour at 35%, as the arriving bloom glass is (REDESIGN.md 3.1). */
const FILLS: Record<VesselVisual['fill'], string> = {
  glass: palette.glass,
  seeds: alpha(palette.dust, 0.18),
  honey: alpha(palette.honey, 0.35),
  radish: alpha(palette.radish, 0.35),
  sage: palette.sageWash,
};

/**
 * Why the money waits, in words, after the engine's own notes on the
 * wallet's funding (`copy.home.vesselWait`). Figures are left to the label.
 */
export const WAIT_WORDS = copy.home.vesselWait;

/**
 * What the vessel's look says, in words: each glyph and glass names its
 * wait, and plain glass is money on its way. Nothing while everything is
 * spendable.
 */
export function vesselWords(visual: VesselVisual): string | null {
  switch (visual.glyph) {
    case 'refresh':
      return WAIT_WORDS.failed;
    case 'rewind':
      return visual.tone === 'sage'
        ? WAIT_WORDS.reverted
        : WAIT_WORDS.conflicted;
    case 'gauge':
      return WAIT_WORDS.feeWait;
    case 'inflow':
      return WAIT_WORDS.unpaired;
    case 'clock':
      return WAIT_WORDS.confirming;
    case 'sprout':
      return WAIT_WORDS.moving;
  }
  if (visual.fill === 'seeds') return WAIT_WORDS.belowFloor;
  // A pill swollen only by money out of reach has no glass to name.
  const glass = 1 - visual.solid - visual.unreachable;
  return visual.weight === 'swollen' && glass > 1e-9
    ? WAIT_WORDS.arriving
    : null;
}

const TONES: Record<VesselVisual['tone'], string> = {
  bloom: palette.bloom,
  honey: palette.honey,
  radish: palette.radish,
  sage: palette.sage,
  dust: palette.dust,
};

// Cream at 25%: there, but nothing to look at.
const HAIRLINE = alpha(palette.cream, 0.25);

/**
 * The arriving glass on a test network. Slate is grey, and at the 35% bloom
 * glass takes it read as the empty track of a progress bar rather than money
 * on its way, so the vessel draws it stronger.
 */
export const SLATE_GLASS = alpha(palette.slate, 0.55);

/** The glass for `look` on a network, slate standing in for bloom on a test one. */
export function glassFill(look: VesselVisual['fill'], test: boolean): string {
  return look === 'glass' && test ? SLATE_GLASS : FILLS[look];
}

/** The out-of-reach hatch: honey while unplugged, dust while held back. */
const AWAY_TONES = {
  unplugged: { stroke: palette.honey, wash: alpha(palette.honey, 0.14) },
  held: { stroke: palette.dust, wash: alpha(palette.dust, 0.12) },
};

/** The pill's height, from nothing in flight to opened by a tap. */
export const HEIGHTS = { hairline: 2, swollen: 8, open: 28 };
const OPEN_MS = 3000;
/** The size the opened vessel's figures are set at. */
const FIGURE_SIZE = typography.meta.fontSize;
/** A tap that travels further than this was a drag, not a tap. */
const TAP_SLOP = 10;
/** The pill is thin, so its touch area reaches the 48pt minimum around it. */
const REACH = { top: 20, bottom: 20 };

/** Where the seam falls on a pill `width` wide, split `solid` to spendable. */
export function segmentWidths(solid: number, width: number) {
  'worklet';
  const share = Math.min(1, Math.max(0, solid));
  const spendable = Math.round(share * width);
  return { solid: spendable, arriving: width - spendable };
}

const SHEEN_WIDTH = 48;
/** The sheen's brightest cream, at its middle. */
export const SHEEN_PEAK = 0.55;
/** The sheen's pace for each look: the usual sweep, half speed, or back. */
const SHEEN_MS = { sweep: durations.sheen, slow: durations.sheen * 2 };

/**
 * The sheen's left edge `p` of the way through a sweep across the glass,
 * which runs from the seam at `start` to the pill's end at `end`: in from
 * behind the solid part and out past the end, or back the other way when
 * `reversed`.
 */
export function sheenX(
  p: number,
  start: number,
  end: number,
  reversed: boolean,
): number {
  'worklet';
  const travel = end - start + SHEEN_WIDTH;
  return reversed ? end - p * travel : start - SHEEN_WIDTH + p * travel;
}

const SEEDS = 5;
const SEED = 3;

/**
 * Seed `k`'s centre, as a share of the pill, spread evenly over the glass,
 * which starts `start` of the way along.
 */
export function seedSpots(start: number, count = SEEDS): number[] {
  return Array.from(
    { length: count },
    (_, k) => start + ((1 - start) * (k + 0.5)) / count,
  );
}

/**
 * Where each part of a pill `width` wide sits, with `away` of it out of
 * reach at the left end, then `solid` of it spendable, then the glass to
 * the right end: the out-of-reach part's clip (`awayShift`, from its place
 * off to the left), where the spendable part starts (`solidAt`), and the
 * seam between it and the glass (`seam`).
 */
export function segmentPlaces(away: number, solid: number, width: number) {
  'worklet';
  const reach = Math.min(1, Math.max(0, away));
  const spend = Math.min(1 - reach, Math.max(0, solid));
  return {
    awayShift: (reach - 1) * width,
    solidAt: reach * width,
    seam: (reach + spend) * width,
    glass: 1 - reach - spend,
  };
}

/** How high seed `k` of `count` has bobbed at clock `t`: 1pt, out of step. */
export function seedBob(t: number, k: number, count?: number): number {
  'worklet';
  // A worklet captures what its body reads, not what its parameter defaults
  // read, so the default lives here: as `count = SEEDS` it crashed on the UI
  // thread, where SEEDS was never captured.
  const seeds = count ?? SEEDS;
  return Math.sin(2 * Math.PI * (t + k / seeds));
}

const RIPPLE_MS = 700;

/**
 * How long the pill keeps its split look once everything in flight has
 * moved into the channel (REDESIGN.md 5, Channelize), so the solid segment
 * is seen growing across it on the soft spring before it settles to the
 * hairline.
 */
export const CHANNELIZE_MS = 600;

/**
 * Whether a change of the balance from `before` to `after` is money moving
 * into the channel: less arriving, and more that can be spent.
 */
export function channelized(
  before: { availableSats: number; pendingSats: number },
  after: { availableSats: number; pendingSats: number },
): boolean {
  return (
    after.pendingSats < before.pendingSats &&
    after.availableSats > before.availableSats
  );
}

/** How long the pill takes to dim when the balance goes stale. */
const STALE_MS = 600;

/** The ripple at `r`, from 0 to done: a cream band that widens and fades. */
export function ripplePose(r: number) {
  'worklet';
  return { opacity: 0.6 * (1 - r), scale: 1 + 3 * r };
}

/** The glyph over the pill pops in on the reveal spring. */
const glyphIn: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.6 }] },
    animations: {
      opacity: withTiming(1, {
        duration: durations.enter,
        easing: curves.enter,
      }),
      transform: [{ scale: withSpring(1, springs.reveal) }],
    },
  };
};
const GLYPH_OUT = FadeOut.duration(durations.exit).reduceMotion(
  ReduceMotion.Never,
);
const FIGURES_IN = FadeIn.duration(durations.enter).reduceMotion(
  ReduceMotion.Never,
);
const FIGURES_OUT = FadeOut.duration(durations.exit).reduceMotion(
  ReduceMotion.Never,
);

/** The minute hand's turn while the money waits on a confirmation. */
const CLOCK_MS = 6000;
/** The fee gauge's needle sweeps each way in this long while fees are high. */
const GAUGE_MS = 3000;
/** A refresh turns once in this long while its retry is pending. */
const RETRY_MS = 900;
/** A refresh with nothing pending, or a rewind, turns once as it appears. */
const TURN_MS = 500;
const GLYPH_SIZE = 16;
/** Between the pill's end and the glyph on it. */
const CAP_GAP = 6;

/**
 * The glyphs over the pill that move (REDESIGN.md 4): the part that moves,
 * and the point of the 24 grid it moves about. The clock's minute hand turns
 * about its centre and the gauge's needle about its hub; a refresh or a
 * rewind turns whole, and a sprout grows from its root.
 */
const MOVES: Partial<Record<GlyphName, { part?: string; origin: string }>> = {
  clock: { part: 'minute', origin: '50% 50%' },
  gauge: { part: 'needle', origin: `50% ${(13 / 24) * 100}%` },
  refresh: { origin: '50% 50%' },
  rewind: { origin: '50% 50%' },
  sprout: { origin: `50% ${(21 / 24) * 100}%` },
};

/**
 * How long one cycle of `name`'s loop takes, for a glyph that keeps moving
 * while its wait lasts (REDESIGN.md 4): the clock's minute hand once every
 * 6s, the gauge's needle back and up again, 3s each way, and a refresh
 * once every 900ms while its retry is pending. Null for a glyph that moves
 * once as it appears.
 */
export function glyphLoop(name: GlyphName, retry: boolean): number | null {
  switch (name) {
    case 'clock':
      return CLOCK_MS;
    case 'gauge':
      return 2 * GAUGE_MS;
    case 'refresh':
      return retry ? RETRY_MS : null;
    default:
      return null;
  }
}

/**
 * Where the moving part of `name` is at `t`: for a loop, a clock that counts
 * its cycles; for the rest, how far their one move has run, from 0 to 1.
 * The minute hand goes round; the gauge's needle dips back 30 degrees and
 * sweeps up again, at rest as it is drawn; a refresh turns forward, a rewind
 * back, and a sprout grows to full size.
 */
export function glyphPose(name: GlyphName, t: number) {
  'worklet';
  switch (name) {
    case 'clock':
      return { rotate: 360 * fract(t), scale: 1 };
    case 'gauge':
      return { rotate: -30 * wave(t), scale: 1 };
    case 'refresh':
      return { rotate: 360 * t, scale: 1 };
    case 'rewind':
      return { rotate: -360 * t, scale: 1 };
    case 'sprout':
      return { rotate: 0, scale: t };
    default:
      return { rotate: 0, scale: 1 };
  }
}

/** Some of a glyph's parts, drawn as Glyph draws the whole. */
function PartsArt({ parts, color }: { parts: GlyphPart[]; color: string }) {
  return (
    <Svg
      width={GLYPH_SIZE}
      height={GLYPH_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeFor(GLYPH_SIZE)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {parts.map(part => (
        <Path key={part.id} d={part.d} />
      ))}
    </Svg>
  );
}

/**
 * The glyph that names the wait. Its moving part is a view of its own
 * around a still drawing, so only a transform runs; under Reduce Motion, or
 * out of sight, it holds still.
 */
function WaitGlyph({
  name,
  color,
  retry,
  awake,
  reduced,
}: {
  name: GlyphName;
  color: string;
  retry: boolean;
  awake: boolean;
  reduced: boolean;
}) {
  const move = MOVES[name];
  // A loop's clock rests where it would not be seen: in the background, in
  // a pane out of use, and under Reduce Motion, where the glyph is still.
  // A clock or a gauge only decorates a long wait, and rests with the
  // ambient clock; a retry is under way, and keeps turning.
  const period = glyphLoop(name, retry);
  const looping = period !== null;
  const clock = useLoop(
    period ?? CLOCK_MS,
    looping && awake && !reduced,
    name !== 'refresh',
  );
  const once = useSharedValue(move && !reduced && !looping ? 0 : 1);
  useEffect(() => {
    if (!move || reduced || looping) {
      once.set(1);
      return;
    }
    once.set(
      name === 'sprout'
        ? withSpring(1, springs.reveal)
        : withTiming(1, { duration: TURN_MS, easing: curves.standard }),
    );
  }, [once, move, reduced, name, looping]);
  const style = useAnimatedStyle(() => {
    const pose = glyphPose(name, looping ? clock.get() : once.get());
    return {
      transform: [{ rotate: `${pose.rotate}deg` }, { scale: pose.scale }],
    };
  }, [name, looping]);
  if (!move) return <Glyph name={name} size={GLYPH_SIZE} color={color} />;
  const parts: GlyphPart[] = [...GLYPHS[name]];
  const moving = (part: GlyphPart) => !move.part || part.id === move.part;
  const still = parts.filter(part => !moving(part));
  return (
    <View style={styles.glyphBox}>
      {still.length > 0 ? <PartsArt parts={still} color={color} /> : null}
      <Reanimated.View
        style={[
          StyleSheet.absoluteFill,
          { transformOrigin: move.origin },
          style,
        ]}
      >
        <PartsArt parts={parts.filter(moving)} color={color} />
      </Reanimated.View>
    </View>
  );
}

/**
 * How tall the pill's art is drawn: the open pill's height, whatever height
 * the pill is passing through, and the pill clips it. The pill's height is
 * animated on the UI thread, and an SVG sized by a percentage of it keeps
 * the height it was first drawn at: out of reach drawn as the hairline
 * swelled stayed a band 2pt tall along the top of the 8pt pill.
 */
export const ART_HEIGHT = HEIGHTS.open;

/** How far apart the hatch's stripes are, across them, in points. */
export const HATCH_GAP = 4;

/** How wide each stripe of the hatch is drawn, in points. */
const HATCH_LINE = 1.5;

/** Two places, enough for a point drawn at 3x. */
const place = (value: number) => Math.round(value * 100) / 100;

/**
 * The hatch's stripes, `gap` points apart across them, as a path over a
 * box `width` by `height`: each a line at 45 degrees rising to the right,
 * from past the box's bottom edge to past its top, so the ends of every
 * stripe, whatever their cap, lie outside the box, which clips them. The
 * stripes are placed from the box's left edge, so a clip that grows or
 * shrinks over them never moves them.
 *
 * Drawn as lines rather than a pattern tile: iOS drew a rotated tile's
 * stripe as a speck in each tile's corner, and the hatch read as dots on a
 * grid (P14).
 */
export function hatchPath(width: number, height: number, gap: number): string {
  // Stripes at 45 degrees `gap` apart meet an edge `gap * sqrt 2` apart.
  const step = gap * Math.SQRT2;
  // Past each end by more than half the stripe's width.
  const over = HATCH_LINE;
  const first = -Math.ceil(height / step) * step;
  const parts: string[] = [];
  for (let x = first; x <= width + over; x += step) {
    parts.push(
      `M${place(x - over)} ${place(height + over)}L${place(
        x + height + over,
      )} ${place(-over)}`,
    );
  }
  return parts.join('');
}

/**
 * Stripes at 45 degrees in `color` across `width`, at the art's height, for
 * the out-of-reach share and the arriving glass's still hatch.
 */
export function Stripes({ width, color }: { width: number; color: string }) {
  return (
    <Path
      d={hatchPath(width, ART_HEIGHT, HATCH_GAP)}
      fill="none"
      stroke={color}
      strokeWidth={HATCH_LINE}
    />
  );
}

/** Under Reduce Motion the glass holds a still 45 degree hatch instead. */
function Hatch({ width }: { width: number }) {
  return (
    <Svg width={width} height={ART_HEIGHT}>
      <Stripes width={width} color={HAIRLINE} />
    </Svg>
  );
}

/**
 * The money out of reach: stripes over a faint wash, honey while the
 * primary is away and dust while it is held back, drawn `width` wide and
 * still while the clip around it moves.
 */
function AwayArt({
  width,
  reach,
}: {
  width: number;
  reach: 'unplugged' | 'held';
}) {
  const tone = AWAY_TONES[reach];
  return (
    <Svg width={width} height={ART_HEIGHT}>
      <Rect width="100%" height="100%" fill={tone.wash} />
      <Stripes width={width} color={tone.stroke} />
    </Svg>
  );
}

function SheenArt() {
  return (
    <Svg width={SHEEN_WIDTH} height={ART_HEIGHT}>
      <Defs>
        <LinearGradient id="vesselSheen" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={palette.cream} stopOpacity={0} />
          <Stop
            offset="0.5"
            stopColor={palette.cream}
            stopOpacity={SHEEN_PEAK}
          />
          <Stop offset="1" stopColor={palette.cream} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#vesselSheen)" />
    </Svg>
  );
}

function Seed({
  k,
  at,
  bob,
}: {
  k: number;
  at: number;
  bob: SharedValue<number>;
}) {
  const style = useAnimatedStyle(
    () => ({ transform: [{ translateY: seedBob(bob.get(), k) }] }),
    [k],
  );
  return (
    <Reanimated.View style={[styles.seed, { left: at - SEED / 2 }, style]} />
  );
}

export function Vessel({
  availableSats,
  pendingSats,
  totalSats,
  lfbw,
  connected = true,
  unit,
  symbol = false,
  masked = false,
  stale = false,
  test = false,
}: VesselProps) {
  const { reduced } = useMotionPrefs();
  const awake = useAwake();
  const active = usePaneActive();
  const balance = { availableSats, pendingSats, totalSats };
  const visual = vesselVisual(balance, lfbw, connected);
  const away = unreachableSats(balance);
  // Everything in flight moving into the channel at once would take the
  // pill straight to its hairline, and the solid segment's growth would
  // never show. So the pill holds its split look, and the arriving part's
  // look, for CHANNELIZE_MS while the solid grows across it (`held`). A
  // change is read during the render that brings it, so the first frame
  // already holds.
  const [channel, setChannel] = useState({
    availableSats,
    pendingSats,
    visual,
    held: null as { visual: VesselVisual; key: number } | null,
  });
  let now = channel;
  if (
    channel.availableSats !== availableSats ||
    channel.pendingSats !== pendingSats
  ) {
    const into =
      channel.visual.weight === 'swollen' &&
      visual.weight === 'hairline' &&
      channelized(channel, { availableSats, pendingSats }) &&
      !masked &&
      !reduced;
    now = {
      availableSats,
      pendingSats,
      visual,
      held: into
        ? { visual: channel.visual, key: (channel.held?.key ?? 0) + 1 }
        : channel.held,
    };
    setChannel(now);
  }
  const held = masked ? null : now.held;
  useEffect(() => {
    if (!held) return;
    const settle = setTimeout(
      () =>
        setChannel(last =>
          last.held?.key === held.key ? { ...last, held: null } : last,
        ),
      CHANNELIZE_MS,
    );
    return () => clearTimeout(settle);
  }, [held]);
  // What the arriving part looked like before it moved, while held.
  const was = held?.visual ?? visual;
  const look = was.fill;
  // Slate in place of bloom on a test network.
  const spendable = test ? palette.slate : palette.bloom;
  const fill = glassFill(look, test);
  const split = (visual.weight === 'swollen' || !!held) && !masked;
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);
  const opened = open && !masked;

  const height = opened
    ? HEIGHTS.open
    : split
    ? HEIGHTS.swollen
    : HEIGHTS.hairline;
  const tall = useSharedValue(height);
  useEffect(() => {
    if (tall.get() === height) return;
    tall.set(
      reduced
        ? withTiming(height, {
            duration: durations.crossfade,
            reduceMotion: ReduceMotion.Never,
          })
        : withSpring(height, opened ? springs.pane : springs.soft),
    );
  }, [tall, height, opened, reduced]);

  // The spendable share, and whether the solid part shows at all. Held, it
  // grows across the whole pill.
  const solid = split && !held ? visual.solid : 1;
  const share = useSharedValue(solid);
  useEffect(() => {
    if (share.get() === solid) return;
    share.set(reduced ? solid : withSpring(solid, springs.soft));
  }, [share, solid, reduced]);
  // The share out of reach, at the left end, which gives way to the
  // spendable part as its channel comes back.
  const unreachable = split && !held ? visual.unreachable : 0;
  const reach = useSharedValue(unreachable);
  useEffect(() => {
    if (reach.get() === unreachable) return;
    reach.set(reduced ? unreachable : withSpring(unreachable, springs.soft));
  }, [reach, unreachable, reduced]);
  // The glass and the hairline trade places as money starts and stops
  // moving.
  const glass = split ? 1 : 0;
  const glassShown = useSharedValue(glass);
  useEffect(() => {
    if (glassShown.get() === glass) return;
    glassShown.set(
      withTiming(glass, {
        duration: reduced ? durations.crossfade : durations.enter,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [glassShown, glass, reduced]);
  // Opened, the solid part steps back so cream figures read over it.
  const shown = split ? (opened ? 0.4 : 1) : 0;
  const solidShown = useSharedValue(shown);
  useEffect(() => {
    if (solidShown.get() === shown) return;
    solidShown.set(
      withTiming(shown, {
        duration: durations.enter,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [solidShown, shown]);

  // Money moving into the channel: the arriving part shrinks while the
  // spendable part grows, and a ripple runs along the seam.
  const ripple = useSharedValue(1);
  const last = useRef({ availableSats, pendingSats });
  useEffect(() => {
    const before = last.current;
    last.current = { availableSats, pendingSats };
    const moved =
      pendingSats < before.pendingSats && availableSats > before.availableSats;
    if (!moved || masked || reduced) return;
    ripple.set(0);
    ripple.set(withTiming(1, { duration: RIPPLE_MS, easing: curves.enter }));
  }, [ripple, availableSats, pendingSats, masked, reduced]);

  const dim = useSharedValue(stale ? 1 : 0);
  useEffect(() => {
    if (dim.get() === (stale ? 1 : 0)) return;
    dim.set(
      withTiming(stale ? 1 : 0, {
        duration: STALE_MS,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [dim, stale]);

  const sheening = split && visual.sheen !== 'none' && !stale;
  // The sheen and the seeds only decorate, and rest with the ambient clock.
  const sheen = useLoop(
    visual.sheen === 'slow' ? SHEEN_MS.slow : SHEEN_MS.sweep,
    sheening && awake && !reduced && width > 0,
    true,
  );
  const seeds = split && look === 'seeds';
  const bob = useLoop(durations.pulse, seeds && awake && !reduced, true);
  const reversed = visual.sheen === 'reversed';

  // The pill grows about the middle of its row, over its neighbours rather
  // than pushing them.
  const pillStyle = useAnimatedStyle(() => ({
    top: (HEIGHTS.swollen - tall.get()) / 2,
    height: tall.get(),
  }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: 1 - 0.45 * dim.get() }));
  const hairlineStyle = useAnimatedStyle(() => ({
    opacity: 1 - glassShown.get(),
  }));
  const arrivingStyle = useAnimatedStyle(() => ({
    opacity: glassShown.get(),
    transform: [
      { scaleX: segmentPlaces(reach.get(), share.get(), width).glass },
    ],
  }));
  const solidStyle = useAnimatedStyle(
    () => ({
      opacity: solidShown.get(),
      backgroundColor: mixHex(spendable, palette.steam, dim.get()),
      transform: [
        { translateX: segmentPlaces(reach.get(), share.get(), width).solidAt },
        { scaleX: share.get() },
      ],
    }),
    [spendable, width],
  );
  // The out-of-reach part is a clip that slides in from the left over a
  // hatch that holds still, so its stripes never stretch.
  const awayClip = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX: segmentPlaces(reach.get(), share.get(), width).awayShift,
        },
      ],
    }),
    [width],
  );
  const awayStill = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX: -segmentPlaces(reach.get(), share.get(), width).awayShift,
        },
      ],
    }),
    [width],
  );
  const sheenStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX: sheenX(
            fract(sheen.get()),
            segmentPlaces(reach.get(), share.get(), width).seam,
            width,
            reversed,
          ),
        },
      ],
    }),
    [width, reversed],
  );
  const rippleStyle = useAnimatedStyle(() => {
    const pose = ripplePose(ripple.get());
    return {
      opacity: pose.opacity,
      transform: [
        {
          translateX:
            segmentPlaces(reach.get(), share.get(), width).seam -
            SHEEN_WIDTH / 4,
        },
        { scaleX: pose.scale },
      ],
    };
  }, [width]);

  // A tap opens the pill for a moment. Its figures are already in the label,
  // so this is for the eye alone and adds no control for a screen reader.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useRef({ x: 0, y: 0 });
  const onGrant = useCallback((event: GestureResponderEvent) => {
    start.current = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
    };
  }, []);
  const onRelease = useCallback((event: GestureResponderEvent) => {
    const dx = event.nativeEvent.pageX - start.current.x;
    const dy = event.nativeEvent.pageY - start.current.y;
    if (Math.hypot(dx, dy) > TAP_SLOP) return;
    haptics.tick();
    setOpen(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), OPEN_MS);
  }, []);
  const tappable = active && !masked;

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const glyph = visual.glyph && !masked && !opened ? visual.glyph : null;
  // Money out of reach wears the unplug on the pill's left end while the
  // primary is away. Held back with the primary connected, it wears nothing:
  // the totals cannot say why (`VesselVisual['reach']`).
  const unplugged = visual.reach === 'unplugged' && !masked && !opened;
  // A hidden balance hides the wait with the split. The value names what
  // is out of reach first, then why the rest waits.
  const wait = masked ? null : vesselWords(visual);
  const reachWords =
    masked || !away
      ? null
      : visual.reach === 'unplugged'
      ? copy.home.outOfReach
      : copy.home.heldBack;
  const words = [reachWords, wait].filter(Boolean).join(' ') || null;
  const tone = visual.tone === 'bloom' ? spendable : TONES[visual.tone];
  const available = inlineAmount(availableSats, unit, symbol, FIGURE_SIZE);
  const arriving = inlineAmount(pendingSats, unit, symbol, FIGURE_SIZE);
  return (
    <View
      accessible
      accessibilityLabel={
        masked
          ? copy.home.balanceHidden
          : copy.home.split(availableSats, pendingSats, away)
      }
      accessibilityValue={words ? { text: words } : undefined}
      hitSlop={REACH}
      onLayout={onLayout}
      onStartShouldSetResponder={tappable ? () => true : undefined}
      onResponderGrant={tappable ? onGrant : undefined}
      onResponderRelease={tappable ? onRelease : undefined}
      style={styles.root}
    >
      <LayoutAnimationConfig skipEntering>
        <Reanimated.View style={[styles.pill, pillStyle, dimStyle]}>
          <Reanimated.View style={[styles.hairline, hairlineStyle]} />
          <Reanimated.View
            style={[styles.arriving, { backgroundColor: fill }, arrivingStyle]}
          />
          {split && visual.unreachable > 0 && width > 0 ? (
            <Reanimated.View style={[styles.away, awayClip]}>
              <Reanimated.View style={[styles.away, awayStill]}>
                <AwayArt width={width} reach={visual.reach ?? 'held'} />
              </Reanimated.View>
            </Reanimated.View>
          ) : null}
          {split && reduced && visual.fill !== 'seeds' && width > 0 ? (
            <View
              style={[
                styles.glass,
                {
                  left: segmentWidths(visual.unreachable + visual.solid, width)
                    .solid,
                },
              ]}
            >
              <Hatch
                width={
                  segmentWidths(visual.unreachable + visual.solid, width)
                    .arriving
                }
              />
            </View>
          ) : null}
          {sheening && !reduced && width > 0 ? (
            <Reanimated.View style={[styles.sheen, sheenStyle]}>
              <SheenArt />
            </Reanimated.View>
          ) : null}
          {seeds && !opened && width > 0
            ? seedSpots(was.unreachable + was.solid).map((spot, k) => (
                <Seed key={k} k={k} at={spot * width} bob={bob} />
              ))
            : null}
          <Reanimated.View style={[styles.solid, solidStyle]} />
          {width > 0 ? (
            <Reanimated.View
              pointerEvents="none"
              style={[styles.ripple, rippleStyle]}
            />
          ) : null}
          {opened ? (
            <Reanimated.View
              entering={FIGURES_IN}
              exiting={FIGURES_OUT}
              style={styles.figures}
            >
              <Text style={styles.figure} maxFontSizeMultiplier={1.4}>
                {available}
              </Text>
              {pendingSats > 0 ? (
                <Text style={styles.figure} maxFontSizeMultiplier={1.4}>
                  {arriving}
                </Text>
              ) : null}
            </Reanimated.View>
          ) : null}
        </Reanimated.View>
        {unplugged ? (
          <Reanimated.View
            key="unplug"
            entering={reduced ? FIGURES_IN : glyphIn}
            exiting={GLYPH_OUT}
            style={[styles.cap, styles.start, dimStyle]}
          >
            <Whisper label={copy.home.outOfReach}>
              <Unplugged size={GLYPH_SIZE} color={palette.honey} />
            </Whisper>
          </Reanimated.View>
        ) : null}
        {glyph ? (
          <Reanimated.View
            key={glyph}
            entering={reduced ? FIGURES_IN : glyphIn}
            exiting={GLYPH_OUT}
            style={[styles.cap, styles.end, dimStyle]}
          >
            <Whisper label={wait ?? ''} enabled={!!wait}>
              <View
                style={
                  visual.retry
                    ? [styles.retry, { borderColor: tone }]
                    : undefined
                }
              >
                <WaitGlyph
                  name={glyph}
                  color={tone}
                  retry={visual.retry}
                  awake={awake}
                  reduced={reduced}
                />
              </View>
            </Whisper>
          </Reanimated.View>
        ) : null}
      </LayoutAnimationConfig>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { height: HEIGHTS.swollen },
  pill: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderRadius: radius.round,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  hairline: { ...StyleSheet.absoluteFill, backgroundColor: HAIRLINE },
  // Square edged: the pill's own rounding shapes both ends, and the seam
  // between the parts stays straight. Each part grows from its own end.
  solid: {
    ...StyleSheet.absoluteFill,
    transformOrigin: 'left center',
  },
  arriving: {
    ...StyleSheet.absoluteFill,
    transformOrigin: 'right center',
  },
  glass: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  away: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  sheen: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  seed: {
    position: 'absolute',
    top: (HEIGHTS.swollen - SEED) / 2,
    width: SEED,
    height: SEED,
    borderRadius: SEED / 2,
    backgroundColor: palette.dust,
  },
  ripple: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: SHEEN_WIDTH / 2,
    backgroundColor: palette.cream,
  },
  figures: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
  },
  figure: { ...typography.meta, color: palette.cream },
  // A glyph sits on an end of the pill, on its middle line, just past it, in
  // the room the vessel's inset leaves (HOME.vesselInset): the wait on the
  // right end by the glass, the unplug on the left by what is out of reach.
  cap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  end: { left: '100%', marginLeft: CAP_GAP },
  start: { right: '100%', marginRight: CAP_GAP },
  glyphBox: { width: GLYPH_SIZE, height: GLYPH_SIZE },
  retry: { borderWidth: 1.5, borderRadius: radius.round, padding: 2 },
});
