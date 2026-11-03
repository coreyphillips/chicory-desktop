import React, {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  ZoomOut,
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  DerivedValue,
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Stop,
} from 'react-native-svg';
import { palette } from '../design/palette';
import { fract, useAwake, useLoop } from '../motion/loops';
import { kick, springStep } from '../motion/springMath';
import { curves, durations, shake, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';

/**
 * The chicory bloom (REDESIGN.md 5): the mark, the loader and the lock bud.
 *
 * `open` is how far the petals have unfolded, from a closed bud (0) to the
 * full flower (1). When it changes each petal springs to it in turn, as the
 * unfold passes it. `mode` is the loop it runs while nothing else happens:
 * a slow breath, the chase that says it is loading, or the ratchet of a
 * refresh. `breath` 'center' keeps the petals still and breathes the centre
 * alone, for a setup still under way (REDESIGN.md 6, setup pending). `tone`
 * follows the network and the wallet's state and crossfades when it
 * changes, and `halo` is the honey ring a pending backup puts around it.
 * `detail` 'mark' drops the veins and draws a plain centre, and is the
 * default below 40pt, where the tips also keep three teeth instead of five.
 *
 * `event` plays when its `key` changes after the bloom has mounted. A burst
 * and a shake play once. A wilt, a fold and a fall hold for as long as the
 * event stays that kind, and a bloom that mounts with one starts in its pose.
 *
 * `opening` is a pull on the petals, from 0 to 1, read on the UI thread so
 * the bloom follows a finger without drawing again. While it is past 0 the
 * petals follow it instead of `open`: they fold, and one more opens on the
 * reveal spring each twelfth of the way, so the flower is whole at 1. Back
 * at 0 they return to `open`. The status row's mark opens this way with a
 * pull on the home pane (REDESIGN.md 6, manual refresh).
 *
 * `lit` makes the flower a count, of the words of a recovery phrase as they
 * are typed (REDESIGN.md 6, Backup and setup). The first twelve light the
 * petals in turn, clockwise from the top, and a second ring behind, half a
 * petal round and a quarter longer, lights from the thirteenth. A petal not
 * yet lit stands dormant and half open, and lights on the reveal spring. The
 * ring behind shows once the first is whole, and past 24 every petal turns
 * radish. Whoever counts plays the burst and the shake.
 *
 * `unfoldOnExit` is how a bloom leaves when its view is taken away, such as
 * the lock's bud as the lock opens (REDESIGN.md 7, R-1): each petal opens
 * from where it stands to the full flower on the reveal spring, as the
 * unfold passes it, and the flower holds open while whatever carries it off
 * moves it, then fades in the last moment of that many milliseconds. Its
 * drawings keep their look rather than fade on the way out. Under Reduce
 * Motion the petals dip out and come back open within a crossfade, and hold
 * still. A count does not leave this way.
 *
 * Each petal is its own view, turned about the centre, around a still SVG:
 * the loops move only transforms and opacity, on the UI thread.
 */
export type BloomMode = 'still' | 'breathe' | 'chase' | 'ratchet';
export type BloomBreath = 'whole' | 'center';
export type BloomTone = 'live' | 'test' | 'dormant';
export type BloomEvent = {
  kind: 'burst' | 'wilt' | 'fold' | 'fall' | 'shake';
  key: number;
};

export interface BloomProps {
  size: number;
  mode?: BloomMode;
  /** What a breath moves: the whole flower, or only its centre. */
  breath?: BloomBreath;
  open?: number;
  tone?: BloomTone;
  halo?: boolean;
  event?: BloomEvent;
  detail?: 'full' | 'mark';
  /** A pull on the petals, from 0 to 1; see above. */
  opening?: DerivedValue<number>;
  /** How many petals a count has lit, from 0 to 24; see above. */
  lit?: number;
  /** How long, in ms, the bloom unfolds as it leaves; see above. */
  unfoldOnExit?: number;
  /** Without one, the bloom is decoration and hidden from screen readers. */
  accessibilityLabel?: string;
}

/*
 * The flower.
 */
export const PETALS = 12;

/** Each petal's length, so the flower is hand-drawn rather than stamped. */
const LENGTHS = [1, 0.96, 0.99, 0.94, 1, 0.97, 0.95, 1, 0.98, 0.95, 0.99, 0.96];

/** The petals' lengths, for a flower drawn elsewhere, such as a receipt's. */
export const PETAL_LENGTHS: readonly number[] = LENGTHS;

/** A petal pointing up from the centre, with a fringed five-tooth tip. */
const PETAL =
  'M-1.6,-8 C-4.2,-18 -9.8,-31 -10.4,-41.5 L-8.3,-44.8 L-6.25,-42.6 L-4.2,-45.6 L-2.1,-43.3 L0,-46 L2.1,-43.3 L4.2,-45.6 L6.25,-42.6 L8.3,-44.8 L10.4,-41.5 C9.8,-31 4.2,-18 1.6,-8 Z';
/** Below 40pt five teeth blur together, so the tip keeps three. */
const PETAL_SMALL =
  'M-1.6,-8 C-4.2,-18 -9.8,-31 -10.4,-41.5 L-6.9,-45 L-3.5,-42.6 L0,-45.8 L3.5,-42.6 L6.9,-45 L10.4,-41.5 C9.8,-31 4.2,-18 1.6,-8 Z';
const VEIN = 'M0,-12 L0,-38';

/**
 * The petal as a drawing, for a flower drawn elsewhere (the receipt's bloom,
 * REDESIGN.md 5, Received celebration): each path points up from the
 * flower's centre on the bloom's 100 box, its base at y -8 and its tip at
 * y -46, within 24 across.
 */
export const PETAL_ART = {
  full: PETAL,
  small: PETAL_SMALL,
  base: 8,
  tip: 46,
  width: 24,
};

/** A petal's resting angle: 30 degrees apart, nudged so none sit square. */
export function petalAngle(i: number) {
  'worklet';
  return 30 * i + (i % 2 ? 2 : 0) - (i % 3 === 0 ? 1.5 : 0);
}

/**
 * Petal `i` at unfold `q`: narrow, short, faint and swept back as a bud,
 * full and square to its angle when open. A burst pushes q past 1.
 */
export function petalState(q: number, i: number) {
  'worklet';
  return {
    scaleX: 0.18 + 0.82 * q,
    scaleY: (0.25 + 0.75 * q) * LENGTHS[i],
    rotate: petalAngle(i) - 14 * (1 - q),
    opacity: Math.min(1, 0.25 + 0.75 * q),
  };
}

/**
 * Petal `i`'s opacity while the chase's head is at `head` (0 to 12): lit
 * where the head is, fading over the four petals behind it.
 */
export function chaseOpacity(head: number, i: number): number {
  'worklet';
  const behind = (((head - i) % PETALS) + PETALS) % PETALS;
  return 0.35 + 0.65 * Math.max(0, 1 - behind / 4);
}

/**
 * Petal `i` under a pull of `opening` (0 to 1): -1 when there is no pull and
 * the petal keeps its own pose, else 1 once the pull has passed its twelfth
 * and 0 until then.
 */
export function pulledPetal(opening: number, i: number): number {
  'worklet';
  if (!(opening > 0)) return -1;
  return Math.floor(Math.min(1, opening) * PETALS) > i ? 1 : 0;
}

/** How far a petal a count has not lit yet stands open. */
const DORMANT_Q = 0.55;
/** The ring a count lights second: half a petal round, and longer. */
const BEHIND_TURN = 15;
const BEHIND_REACH = 1.25;

/**
 * How a count of `lit` lights the flower: the front ring's first petals up
 * to twelve, then the ring behind; past 24 it is over.
 */
export function litRings(lit: number) {
  const count = Math.max(0, Math.floor(lit));
  return {
    front: Math.min(count, PETALS),
    behind: Math.max(0, Math.min(count - PETALS, PETALS)),
    over: count > 2 * PETALS,
  };
}

/** How long a whole unfold takes to reach the last petal. */
const UNFOLD_MS = 420;

/**
 * When petal `i` starts toward `to` from `from`: as the unfold passes i/12,
 * so a full unfold staggers across UNFOLD_MS and a small change hardly at
 * all. Closing runs from the last petal back.
 */
export function petalDelay(i: number, from: number, to: number): number {
  const order = to >= from ? i : PETALS - 1 - i;
  return Math.round(
    (order / PETALS) * UNFOLD_MS * Math.min(1, Math.abs(to - from)),
  );
}

const RATCHET_STEP_MS = 600;
const RATCHET_CYCLE_MS = RATCHET_STEP_MS * PETALS;

/**
 * The bloom's turn, in degrees, `steps` ratchet steps in: 30 degrees a step,
 * each one landing on the snap spring and then holding.
 */
export function ratchetAngle(steps: number): number {
  'worklet';
  const whole = Math.floor(steps);
  return (
    30 *
    (whole +
      springStep(((steps - whole) * RATCHET_STEP_MS) / 1000, springs.snap))
  );
}

/** The wrapper's breath at clock `t`: at rest on each whole cycle. */
export function breathe(t: number) {
  'worklet';
  const depth = (1 - Math.cos(2 * Math.PI * t)) / 2;
  return { scale: 1 + 0.035 * depth, rotate: 1.5 * depth };
}

/**
 * What a breath at clock `t` does to the wrapper and to the centre: the
 * whole flower breathes as one, or the centre alone swells a quarter and
 * settles while the petals hold still. Both rest on each whole cycle.
 */
export function breathPose(t: number, breath: BloomBreath) {
  'worklet';
  if (breath === 'whole') return { wrap: breathe(t), center: 1 };
  const depth = (1 - Math.cos(2 * Math.PI * t)) / 2;
  return { wrap: breathe(0), center: 1 + 0.25 * depth };
}

/** How far petal `i` has fallen at `f`, from 0 to gone. Reduced, it only fades. */
export function fallPose(f: number, i: number, still: boolean) {
  'worklet';
  if (still) return { drop: 0, turn: 0, opacity: 1 - f };
  return { drop: 48 * f, turn: (i % 2 ? 25 : -25) * f, opacity: 1 - f };
}

/** A wilt at `w`: every petal droops 10 degrees and loses 8% of its length. */
export function wiltPose(w: number) {
  'worklet';
  return { turn: 10 * w, length: 1 - 0.08 * w };
}

/**
 * A burst at `e`, from 0 to done: the petals swell past open and back, and a
 * clone of the flower grows to 1.6 and fades out. Reduced, nothing moves:
 * the clone only brightens the flower where it stands, and fades.
 */
export function burstPose(e: number, still = false) {
  'worklet';
  const out = 1 - (1 - e) * (1 - e);
  return {
    // A rise and fall that is exactly nothing at either end.
    swell: still ? 0 : 0.12 * 4 * e * (1 - e),
    cloneScale: still ? 1 : 1 + 0.6 * out,
    cloneOpacity: 0.45 * (1 - e),
  };
}

const CHASE_MS = 1320;
const FOLD_STEP_MS = 40;
const FALL_STEP_MS = 60;
const FALL_MS = 520;
const BURST_MS = 700;
const TINT_MS = 400;
/** The chase dims the loader to this under Reduce Motion, and holds still. */
const HUSHED = 0.6;

/** The ring around a mark with a backup pending, pulsing 1 to .5. */
export function haloOpacity(t: number): number {
  'worklet';
  return 0.75 + 0.25 * Math.cos(2 * Math.PI * t);
}

/*
 * The still drawings each view turns and scales.
 */
type Art = BloomTone | 'wilt' | 'over';

const OUTLINE = { fill: 'none', stroke: palette.slate, strokeWidth: 1.6 };

function petalPaint(art: Art, gradient: string) {
  switch (art) {
    case 'live':
      return { fill: `url(#${gradient})` };
    case 'test':
      return OUTLINE;
    case 'dormant':
      return { fill: palette.husk, stroke: palette.bark, strokeWidth: 1 };
    case 'wilt':
      return { fill: palette.dust };
    case 'over':
      return { fill: palette.radish };
  }
}

const CENTERS = {
  live: {
    center: { fill: palette.stamen },
    anther: palette.stamen,
    pollen: palette.bloomHi,
  },
  test: { center: OUTLINE, anther: palette.slate, pollen: palette.slate },
  dormant: {
    center: { fill: palette.bark },
    anther: palette.bark,
    pollen: palette.husk,
  },
} as const;

/** `n` dots of radius `r` spaced evenly on a circle of `at` around the centre. */
function dots(n: number, at: number, r: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return { x: 50 + at * Math.sin(t), y: 50 - at * Math.cos(t), r };
  });
}
const ANTHERS = dots(8, 9.5, 1.1);
const POLLEN = dots(5, 5, 0.9);

function PetalGradient({ id }: { id: string }) {
  return (
    <Defs>
      <LinearGradient
        id={id}
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="-8"
        x2="0"
        y2="-46"
      >
        <Stop offset="0" stopColor={palette.bloomNight} />
        <Stop offset="0.45" stopColor={palette.bloomDeep} />
        <Stop offset="1" stopColor={palette.bloomHi} />
      </LinearGradient>
    </Defs>
  );
}

interface ArtProps {
  size: number;
  art: Art;
  small: boolean;
  full: boolean;
  gradient: string;
}

/** One petal pointing up from the centre of a `size` box, never redrawn. */
const PetalArt = memo(function PetalDrawing({
  size,
  art,
  small,
  full,
  gradient,
}: ArtProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {art === 'live' ? <PetalGradient id={gradient} /> : null}
      <G transform="translate(50 50)">
        <Path d={small ? PETAL_SMALL : PETAL} {...petalPaint(art, gradient)} />
        {full && art === 'live' ? (
          <Path
            d={VEIN}
            stroke={palette.bloomNight}
            strokeOpacity={0.35}
            strokeWidth={0.8}
          />
        ) : null}
      </G>
    </Svg>
  );
});

/** The whole flower, open, as one drawing: the burst's clone. */
const FlowerArt = memo(function FlowerDrawing({
  size,
  art,
  small,
  gradient,
}: ArtProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      {art === 'live' ? <PetalGradient id={gradient} /> : null}
      {LENGTHS.map((length, i) => (
        <Path
          key={i}
          d={small ? PETAL_SMALL : PETAL}
          transform={`translate(50 50) rotate(${petalAngle(
            i,
          )}) scale(1 ${length})`}
          {...petalPaint(art, gradient)}
        />
      ))}
    </Svg>
  );
});

const CenterArt = memo(function CenterDrawing({
  size,
  tone,
  full,
}: {
  size: number;
  tone: BloomTone;
  full: boolean;
}) {
  const colors = CENTERS[tone];
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle cx="50" cy="50" r={full ? 7.5 : 8} {...colors.center} />
      {full
        ? [...ANTHERS, ...POLLEN].map((dot, i) => (
            <Circle
              key={i}
              cx={dot.x}
              cy={dot.y}
              r={dot.r}
              fill={i < ANTHERS.length ? colors.anther : colors.pollen}
            />
          ))
        : null}
    </Svg>
  );
});

/** A hairline ring just outside the petals' reach, at least 1.5pt wide. */
const HaloArt = memo(function HaloDrawing({ size }: { size: number }) {
  const width = Math.max(2, 150 / size);
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Circle
        cx="50"
        cy="50"
        r={50 - width / 2}
        fill="none"
        stroke={palette.honey}
        strokeWidth={width}
      />
    </Svg>
  );
});

/**
 * A change of tone or a wilt fades the old drawing out under the new; under
 * Reduce Motion, within a crossfade's 160ms.
 */
const ART = {
  in: FadeIn.duration(durations.draw).reduceMotion(ReduceMotion.Never),
  out: FadeOut.duration(durations.draw).reduceMotion(ReduceMotion.Never),
};
const ART_QUICK = {
  in: FadeIn.duration(durations.crossfade).reduceMotion(ReduceMotion.Never),
  out: FadeOut.duration(durations.crossfade).reduceMotion(ReduceMotion.Never),
};
const HALO_IN = FadeIn.duration(durations.enter).reduceMotion(
  ReduceMotion.Never,
);
/** A saved backup's halo shrinks into the mark; reduced, it only fades. */
const HALO_SHRINK = ZoomOut.duration(durations.move);
const HALO_FADE = FadeOut.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);

/*
 * A bloom that leaves by unfolding (`unfoldOnExit`). Each part times its own
 * way out and lasts the whole stay, since a part whose exit ends first is
 * taken away while the rest still moves. Every step runs whatever the Reduce
 * Motion setting, which chooses the steps instead.
 */
const NEVER = ReduceMotion.Never;

/** How long the last fade of a leaving bloom takes. */
const leaveFade = (reduced: boolean) =>
  reduced ? durations.crossfade : durations.exit;

/**
 * Petal `i` leaving by unfolding: from where it stands at `from` to the full
 * flower on the reveal spring, as the unfold passes it, then open until it
 * fades at the end of `ms`. Under Reduce Motion it dips out and comes back
 * open within a crossfade, and holds still.
 */
export function unfoldExit(
  i: number,
  from: number,
  ms: number,
  reduced: boolean,
): EntryExitAnimationFunction {
  const start = petalState(from, i);
  const end = petalState(1, i);
  const delay = reduced ? durations.crossfade / 2 : petalDelay(i, from, 1);
  const fade = leaveFade(reduced);
  return () => {
    'worklet';
    const pose = (at: typeof start) => [
      { rotate: `${at.rotate}deg` },
      { scaleX: at.scaleX },
      { scaleY: at.scaleY },
    ];
    // Reduced, the pose swaps while the petal is out of sight.
    const open = <T extends number | string>(to: T) =>
      withDelay(
        delay,
        reduced
          ? withTiming(to, { duration: 0, reduceMotion: NEVER })
          : withSpring(to, { ...springs.reveal, reduceMotion: NEVER }),
        NEVER,
      );
    const shown = reduced
      ? withSequence(
          NEVER,
          withTiming(0, { duration: delay, reduceMotion: NEVER }),
          withTiming(end.opacity, { duration: delay, reduceMotion: NEVER }),
        )
      : withDelay(
          delay,
          withTiming(end.opacity, {
            duration: durations.enter,
            easing: curves.enter,
            reduceMotion: NEVER,
          }),
          NEVER,
        );
    const opened = reduced ? 2 * delay : delay + durations.enter;
    return {
      initialValues: { opacity: start.opacity, transform: pose(start) },
      animations: {
        opacity: withSequence(
          NEVER,
          shown,
          withDelay(
            Math.max(0, ms - opened - fade),
            withTiming(0, {
              duration: fade,
              easing: curves.exit,
              reduceMotion: NEVER,
            }),
            NEVER,
          ),
        ),
        transform: [
          { rotate: open(`${end.rotate}deg`) },
          { scaleX: open(end.scaleX) },
          { scaleY: open(end.scaleY) },
        ],
      },
    };
  };
}

/**
 * The centre of a bloom leaving by unfolding: it stays as it is and fades at
 * the end of `ms`, with the petals.
 */
function holdExit(ms: number, reduced: boolean): EntryExitAnimationFunction {
  const fade = leaveFade(reduced);
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 1 },
      animations: {
        opacity: withDelay(
          Math.max(0, ms - fade),
          withTiming(0, {
            duration: fade,
            easing: curves.exit,
            reduceMotion: NEVER,
          }),
          NEVER,
        ),
      },
    };
  };
}

interface Drives {
  burst: SharedValue<number>;
  wilt: SharedValue<number>;
  chase: SharedValue<number>;
  chasing: SharedValue<number>;
}

interface PetalProps extends ArtProps {
  i: number;
  open: number;
  /** Turned this far from the petal's own angle, for the ring behind. */
  turn?: number;
  /** How long the petal is against the flower's reach. */
  reach?: number;
  /** A counted petal opens on its own, not in the unfold's stagger. */
  solo?: boolean;
  opening?: DerivedValue<number>;
  folded: boolean;
  fallen: boolean;
  reduced: boolean;
  hush: number;
  drives: Drives;
  /** How long the petal unfolds as the bloom leaves, if it leaves so. */
  unfoldOnExit?: number;
}

const Petal = memo(function BloomPetal({
  i,
  open,
  turn = 0,
  reach = 1,
  solo = false,
  opening,
  folded,
  fallen,
  reduced,
  hush,
  drives,
  unfoldOnExit,
  ...art
}: PetalProps) {
  const q = useSharedValue(folded ? 0 : open);
  const fall = useSharedValue(fallen ? 1 : 0);
  // Under a pull: how open this petal is, and how much the pull, rather
  // than `open`, decides its pose.
  const pulled = useSharedValue(0);
  const held = useSharedValue(0);
  useAnimatedReaction(
    () => pulledPetal(opening ? opening.get() : 0, i),
    (step, before) => {
      if (step === before) return;
      const to = (target: number) =>
        reduced ? target : withSpring(target, springs.reveal);
      if (step < 0) {
        held.set(to(0));
        return;
      }
      held.set(to(1));
      pulled.set(to(step));
    },
    [opening, i, reduced],
  );

  useEffect(() => {
    const target = folded ? 0 : open;
    const from = q.get();
    cancelAnimation(q);
    if (reduced || from === target) {
      q.set(target);
      return;
    }
    const delay = folded
      ? (PETALS - 1 - i) * FOLD_STEP_MS
      : solo
      ? 0
      : petalDelay(i, from, target);
    q.set(withDelay(delay, withSpring(target, springs.reveal)));
  }, [q, i, open, folded, reduced, solo]);

  useEffect(() => {
    if (fall.get() === (fallen ? 1 : 0)) return;
    cancelAnimation(fall);
    // Reduced, the petals only fade, together and within a crossfade.
    const timing = withTiming(fallen ? 1 : 0, {
      duration: reduced
        ? durations.crossfade
        : fallen
        ? FALL_MS
        : durations.enter,
      easing: fallen ? curves.exit : curves.enter,
      reduceMotion: ReduceMotion.Never,
    });
    fall.set(fallen && !reduced ? withDelay(i * FALL_STEP_MS, timing) : timing);
  }, [fall, i, fallen, reduced]);

  const { burst, wilt, chase, chasing } = drives;
  const style = useAnimatedStyle(() => {
    const base = q.get() + (pulled.get() - q.get()) * held.get();
    const pose = petalState(base + burstPose(burst.get(), reduced).swell, i);
    const droop = wiltPose(wilt.get());
    const drop = fallPose(fall.get(), i, reduced);
    const lit =
      1 + (chaseOpacity(PETALS * fract(chase.get()), i) - 1) * chasing.get();
    return {
      opacity: pose.opacity * lit * hush * drop.opacity,
      transform: [
        { translateY: drop.drop },
        { rotate: `${pose.rotate + turn + droop.turn + drop.turn}deg` },
        { scaleX: pose.scaleX * reach },
        { scaleY: pose.scaleY * droop.length * reach },
      ],
    };
  }, [i, reduced, hush, turn, reach]);

  const fade = reduced ? ART_QUICK : ART;
  // Leaving by unfolding, the drawing keeps its look while the petal opens.
  const leaving = unfoldOnExit !== undefined;
  return (
    <Reanimated.View
      exiting={
        leaving
          ? unfoldExit(i, folded ? 0 : open, unfoldOnExit, reduced)
          : undefined
      }
      style={[StyleSheet.absoluteFill, style]}
    >
      <Reanimated.View
        key={art.art}
        entering={fade.in}
        exiting={leaving ? undefined : fade.out}
        style={StyleSheet.absoluteFill}
      >
        <PetalArt {...art} />
      </Reanimated.View>
    </Reanimated.View>
  );
});

export function Bloom({
  size,
  mode = 'still',
  breath = 'whole',
  open = 1,
  tone = 'live',
  halo = false,
  event,
  detail = size < 40 ? 'mark' : 'full',
  opening,
  lit,
  unfoldOnExit,
  accessibilityLabel,
}: BloomProps) {
  const { reduced } = useMotionPrefs();
  const awake = useAwake();
  // SVG ids are document-wide on some renderers, so each bloom names its own.
  const gradient = `petal${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const unfold = Math.min(1, Math.max(0, open));
  const full = detail === 'full';
  const small = size < 40;
  const kind = event?.kind;
  const wilted = kind === 'wilt';
  const art: Art = wilted ? 'wilt' : tone;
  // A count draws its front ring short enough for the ring behind to fit.
  const rings = lit === undefined ? null : litRings(lit);
  const reach = rings ? 1 / BEHIND_REACH : 1;
  const counted = (on: boolean): { open: number; art: Art } => ({
    open: on ? unfold : Math.min(unfold, DORMANT_Q),
    art: !on ? 'dormant' : rings?.over && !wilted ? 'over' : art,
  });
  const behindShown = rings?.front === PETALS ? 1 : 0;
  const behind = useSharedValue(behindShown);
  useEffect(() => {
    if (behind.get() === behindShown) return;
    behind.set(
      withTiming(behindShown, {
        duration: reduced ? durations.crossfade : durations.enter,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [behind, behindShown, reduced]);

  // Loops. A breath and a halo only decorate, and rest with the ambient
  // clock; the chase and the ratchet say something is under way.
  const inhale = useLoop(
    durations.breathe,
    mode === 'breathe' && awake && !reduced,
    true,
  );
  const chase = useLoop(CHASE_MS, mode === 'chase' && awake && !reduced);
  // How much of the chase shows, so starting and stopping it fades.
  const chaseShown = mode === 'chase' && !reduced ? 1 : 0;
  const chasing = useSharedValue(chaseShown);
  useEffect(() => {
    if (chasing.get() === chaseShown) return;
    chasing.set(
      withTiming(chaseShown, {
        duration: durations.enter,
        easing: curves.standard,
      }),
    );
  }, [chasing, chaseShown]);
  const turn = useSharedValue(0);
  const ratcheting = mode === 'ratchet' && awake && !reduced;
  useEffect(() => {
    const at = turn.get();
    if (ratcheting) {
      turn.set(
        withRepeat(
          withTiming(at + 1, {
            duration: RATCHET_CYCLE_MS,
            easing: curves.linear,
          }),
          -1,
          false,
        ),
      );
    } else {
      // Finish the step under way rather than spin back.
      const steps = at * PETALS;
      const rest = Math.ceil(steps);
      if (rest !== steps) {
        turn.set(
          withTiming(rest / PETALS, {
            duration: (rest - steps) * RATCHET_STEP_MS,
            easing: curves.linear,
          }),
        );
      }
    }
    return () => cancelAnimation(turn);
  }, [turn, ratcheting]);
  const glow = useLoop(durations.halo, halo && awake && !reduced, true);

  // Events.
  const burst = useSharedValue(1);
  const wilt = useSharedValue(wilted ? 1 : 0);
  const nudge = useSharedValue(0);
  const center = useSharedValue(1);
  const tint = useSharedValue(0);
  const [bursting, setBursting] = useState(false);
  const played = useRef(event?.key);
  useEffect(() => {
    if (!kind || event?.key === played.current) return;
    played.current = event?.key;
    if (kind === 'burst') {
      setBursting(true);
      burst.set(0);
      burst.set(
        withTiming(
          1,
          {
            duration: reduced ? durations.crossfade : BURST_MS,
            easing: curves.standard,
            reduceMotion: ReduceMotion.Never,
          },
          done => {
            'worklet';
            if (done) scheduleOnRN(setBursting, false);
          },
        ),
      );
      if (!reduced) center.set(kick(0.3, springs.boing));
    }
    if (kind === 'shake' || kind === 'wilt') {
      if (reduced) {
        tint.set(
          withSequence(
            withTiming(1, {
              duration: TINT_MS / 3,
              reduceMotion: ReduceMotion.Never,
            }),
            withTiming(0, {
              duration: (TINT_MS * 2) / 3,
              reduceMotion: ReduceMotion.Never,
            }),
          ),
        );
      } else {
        nudge.set(shake());
      }
    }
  }, [kind, event?.key, reduced, burst, center, nudge, tint]);
  useEffect(() => {
    const to = wilted ? 1 : 0;
    if (wilt.get() === to) return;
    // Reduced, the petals take the droop at once; the dust crossfades in.
    wilt.set(
      reduced
        ? to
        : withTiming(to, { duration: durations.draw, easing: curves.standard }),
    );
  }, [wilt, wilted, reduced]);

  const wrapStyle = useAnimatedStyle(() => {
    const b = breathPose(inhale.get(), breath).wrap;
    return {
      transform: [
        { translateX: nudge.get() },
        { rotate: `${b.rotate + ratchetAngle(PETALS * turn.get())}deg` },
        { scale: b.scale },
      ],
    };
  }, [breath]);
  const centerStyle = useAnimatedStyle(
    () => ({
      transform: [
        { scale: center.get() * breathPose(inhale.get(), breath).center },
      ],
    }),
    [breath],
  );
  const cloneStyle = useAnimatedStyle(() => {
    const b = burstPose(burst.get(), reduced);
    return {
      opacity: b.cloneOpacity,
      transform: [{ scale: b.cloneScale * reach }],
    };
  }, [reduced, reach]);
  const behindStyle = useAnimatedStyle(() => ({ opacity: behind.get() }));
  const haloStyle = useAnimatedStyle(() => ({
    opacity: haloOpacity(glow.get()),
  }));
  const tintStyle = useAnimatedStyle(() => ({ opacity: tint.get() }));

  // Shared values keep their identity, so the petals see one object and
  // skip the renders that only concern the bloom.
  const drives = useMemo<Drives>(
    () => ({ burst, wilt, chase, chasing }),
    [burst, wilt, chase, chasing],
  );
  const hush = reduced && mode === 'chase' ? HUSHED : 1;
  const labelled = !!accessibilityLabel;
  const artProps = { size, art, small, full, gradient };
  // A count keeps to its own petals and never leaves by unfolding.
  const leave = rings ? undefined : unfoldOnExit;
  const held = leave === undefined ? undefined : holdExit(leave, reduced);
  return (
    <View
      accessible={labelled}
      accessibilityRole={labelled ? 'image' : 'none'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={
        labelled && mode === 'chase' ? { busy: true } : undefined
      }
      accessibilityElementsHidden={!labelled}
      importantForAccessibility={labelled ? 'yes' : 'no-hide-descendants'}
      style={{ width: size, height: size }}
    >
      <LayoutAnimationConfig skipEntering>
        {halo ? (
          <Reanimated.View
            entering={HALO_IN}
            exiting={reduced ? HALO_FADE : HALO_SHRINK}
            style={[StyleSheet.absoluteFill, haloStyle]}
          >
            <HaloArt size={size} />
          </Reanimated.View>
        ) : null}
        {reduced ? (
          <Reanimated.View
            pointerEvents="none"
            style={[styles.tint, { borderRadius: size / 2 }, tintStyle]}
          />
        ) : null}
        <Reanimated.View style={[StyleSheet.absoluteFill, wrapStyle]}>
          {rings ? (
            <Reanimated.View style={[StyleSheet.absoluteFill, behindStyle]}>
              {LENGTHS.map((_, i) => (
                <Petal
                  key={i}
                  i={i}
                  turn={BEHIND_TURN}
                  solo
                  folded={kind === 'fold'}
                  fallen={kind === 'fall'}
                  reduced={reduced}
                  hush={hush}
                  drives={drives}
                  {...artProps}
                  {...counted(i < rings.behind)}
                />
              ))}
            </Reanimated.View>
          ) : null}
          {LENGTHS.map((_, i) => (
            <Petal
              key={i}
              i={i}
              open={unfold}
              opening={opening}
              folded={kind === 'fold'}
              fallen={kind === 'fall'}
              reduced={reduced}
              hush={hush}
              drives={drives}
              unfoldOnExit={leave}
              {...artProps}
              {...(rings
                ? { reach, solo: true, ...counted(i < rings.front) }
                : null)}
            />
          ))}
          <Reanimated.View style={[StyleSheet.absoluteFill, centerStyle]}>
            <Reanimated.View
              key={tone}
              entering={reduced ? ART_QUICK.in : ART.in}
              exiting={held ?? (reduced ? ART_QUICK.out : ART.out)}
              style={StyleSheet.absoluteFill}
            >
              <CenterArt size={size} tone={tone} full={full} />
            </Reanimated.View>
          </Reanimated.View>
        </Reanimated.View>
        {bursting ? (
          <Reanimated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, cloneStyle]}
          >
            <FlowerArt {...artProps} />
          </Reanimated.View>
        ) : null}
      </LayoutAnimationConfig>
    </View>
  );
}

const styles = StyleSheet.create({
  // Reduce Motion's stand-in for a shake: a radish wash behind the flower.
  tint: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.radishSoft,
  },
});
