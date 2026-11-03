import React, { memo, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { GLYPHS, GLYPH_LENGTHS, Glyph, strokeFor } from '../design/glyphs';
import type { GlyphName } from '../design/glyphs';
import { palette } from '../design/palette';
import { fract, useAwake, useLoop } from '../motion/loops';
import { kick } from '../motion/springMath';
import { curves, durations, shake, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import type { RingVisual } from '../scenes/activity/visual';
import { radius } from '../theme';
import { haloOpacity } from './Bloom';

export type { RingVisual } from '../scenes/activity/visual';

/**
 * A payment's state as a ring around its glyph (REDESIGN.md 5, StatusRing),
 * at 40pt in a row, 96pt in a detail header and 120pt for a result.
 * `ringVisual` decides what it shows; this draws and moves it. The ring is
 * decoration: the row or control around it carries the words.
 *
 * Layers, back to front: the track, the pattern (a progress arc, an orbit
 * turning once every 1.4s, dashes turning once every 8s, a split, a gap at
 * one o'clock, or expired dashes), the halo that pulses around a held
 * payment, and the glyph.
 *
 * A ring that changes state after it mounts shows the change: completing
 * fills the arc, draws its glyph and pops; failing shakes and draws the
 * cross; an unknown outcome scales the pause bars in under its halo; and
 * expiring fades to dashes. A ring that mounts in a state simply shows it,
 * so a list scrolling past does not replay history.
 *
 * On a test network (`test`) slate stands in for bloom, as it does for the
 * mark (REDESIGN.md 3.1), so a pending payment there never looks like one
 * of real money.
 */
export type RingSize = 40 | 96 | 120;

export interface StatusRingProps {
  size: RingSize;
  visual: RingVisual;
  /** The payment is on a test network. */
  test?: boolean;
}

const TONES: Record<RingVisual['tone'], string> = {
  bloom: palette.bloom,
  sage: palette.sage,
  honey: palette.honey,
  radish: palette.radish,
  dust: palette.dust,
  steam: palette.steam,
};

/** The colour a ring of `tone` is drawn in, on a test network or not. */
export function ringColor(tone: RingVisual['tone'], test = false): string {
  return tone === 'bloom' && test ? palette.slate : TONES[tone];
}

const STROKE: Record<RingSize, number> = { 40: 2.5, 96: 4, 120: 5 };
const GLYPH: Record<RingSize, number> = { 40: 18, 96: 40, 120: 48 };
/** How much of the ring an orbit's arc covers. */
const ORBIT = 0.25;
/** The open ring of an unreadable status: a 30 degree gap at one o'clock. */
const GAP_DEGREES = 30;
const GAP_AT = 30;
const FILL_MS = 360;
const DASH_TURN_MS = durations.dashRotate;
const TINT_MS = 400;

/** A ring's centre, radius, stroke and circumference at `size`. */
export function ringGeometry(size: RingSize) {
  const stroke = STROKE[size];
  const c = size / 2;
  // Room inside the box for the held halo, a stroke further out.
  const r = c - stroke * 2;
  return { c, r, stroke, around: 2 * Math.PI * r };
}

/** Where the badge sits: in the gap for an open ring, else lower right. */
export function badgeAt(size: RingSize, pattern: RingVisual['pattern']) {
  const badge = Math.round(size * 0.3);
  if (pattern !== 'gap') return { left: size - badge, top: size - badge };
  const { c, r } = ringGeometry(size);
  const at = (GAP_AT * Math.PI) / 180;
  return {
    left: c + r * Math.sin(at) - badge / 2,
    top: c - r * Math.cos(at) - badge / 2,
  };
}

/** How much of the ring a state shows filled, for a fill to start from. */
export function filled(visual: RingVisual): number {
  switch (visual.pattern) {
    case 'full':
    case 'held':
      return 1;
    case 'orbit':
      return visual.progress || ORBIT;
    case 'split':
      return visual.split ?? 0;
    default:
      return 0;
  }
}

/** What a ring does on its way into a new state. */
export type RingEntrance = 'none' | 'completed' | 'failed' | 'held' | 'expired';

const sameVisual = (a: RingVisual, b: RingVisual) =>
  a.tone === b.tone &&
  a.pattern === b.pattern &&
  a.glyph === b.glyph &&
  a.badge === b.badge &&
  a.progress === b.progress &&
  a.split === b.split;

const DONE = new Set<RingVisual['tone']>(['sage', 'steam']);

/**
 * The entrance for a change from `before` to `after`. An unknown outcome is
 * checked first, since nothing about it may read as done.
 */
export function ringEntrance(
  before: RingVisual,
  after: RingVisual,
): RingEntrance {
  if (
    before.pattern === after.pattern &&
    before.tone === after.tone &&
    before.glyph === after.glyph
  ) {
    return 'none';
  }
  if (after.pattern === 'held') return 'held';
  if (after.tone === 'radish') return 'failed';
  if (after.pattern === 'expired') return 'expired';
  // Only a known, finished outcome fills and pops: a reused address is a
  // full ring too, in honey, and must not look like a success arriving.
  if (after.pattern === 'full' && DONE.has(after.tone)) return 'completed';
  return 'none';
}

/**
 * Whether the glyph in the ring draws in anew on a change from `before` to
 * `after`: only when it is another glyph. The same glyph stays as it is, so
 * a payment's kind never drops out of its ring while the ring around it
 * fills, as a transfer's `swap` did as its orbit closed.
 */
export function glyphRedraws(before: RingVisual, after: RingVisual): boolean {
  return before.glyph !== after.glyph;
}

export interface StrokePlan {
  delay: number;
  duration: number;
}

/**
 * When each part of `glyph` draws on an entrance. A completed glyph draws
 * once the fill is under way; the cross is two quick strokes, the second
 * 60ms behind the first (REDESIGN.md 4).
 */
export function drawPlan(
  glyph: GlyphName,
  entrance: RingEntrance,
): StrokePlan[] {
  if (glyph === 'cross') {
    return [
      { delay: 0, duration: durations.exit },
      { delay: 60, duration: durations.exit },
    ];
  }
  const start = entrance === 'completed' ? 120 : 0;
  return GLYPHS[glyph].map((_, i) => ({
    delay: start + i * 60,
    duration: durations.draw,
  }));
}

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);
const AnimatedPath = Reanimated.createAnimatedComponent(Path);

/** One pattern hands over to the next; under Reduce Motion, within 160ms. */
const PATTERN_IN = FadeIn.duration(durations.enter).reduceMotion(
  ReduceMotion.Never,
);
const PATTERN_IN_QUICK = FadeIn.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);
const PATTERN_OUT = FadeOut.duration(durations.exit).reduceMotion(
  ReduceMotion.Never,
);

type Geometry = ReturnType<typeof ringGeometry>;

function circleOf({ c, r, stroke }: Geometry, color: string) {
  return {
    cx: c,
    cy: c,
    r,
    fill: 'none',
    stroke: color,
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
  };
}

/** An arc from twelve o'clock, clockwise, that fills to `share`. */
function Arc({
  share,
  from,
  geometry,
  color,
  reduced,
}: {
  share: number;
  from: number;
  geometry: Geometry;
  color: string;
  reduced: boolean;
}) {
  const p = useSharedValue(from);
  useEffect(() => {
    if (p.get() === share) return;
    cancelAnimation(p);
    p.set(
      reduced
        ? share
        : withTiming(share, { duration: FILL_MS, easing: curves.standard }),
    );
  }, [p, share, reduced]);
  const { around, c } = geometry;
  const props = useAnimatedProps(() => ({
    strokeDashoffset: around * (1 - Math.min(1, Math.max(0, p.get()))),
  }));
  return (
    <Svg style={StyleSheet.absoluteFill}>
      <AnimatedCircle
        {...circleOf(geometry, color)}
        strokeDasharray={[around, around]}
        strokeDashoffset={around * (1 - from)}
        transform={`rotate(-90 ${c} ${c})`}
        animatedProps={props}
      />
    </Svg>
  );
}

/** Turns its content once every `period` while `running`. */
function Turning({
  period,
  running,
  children,
}: {
  period: number;
  running: boolean;
  children: ReactNode;
}) {
  const clock = useLoop(period, running);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${360 * fract(clock.get())}deg` }],
  }));
  return (
    <Reanimated.View style={[StyleSheet.absoluteFill, style]}>
      {children}
    </Reanimated.View>
  );
}

/** The held payment's halo: a ring just outside, pulsing 1 to .5. */
function Halo({
  geometry,
  color,
  running,
}: {
  geometry: Geometry;
  color: string;
  running: boolean;
}) {
  const clock = useLoop(durations.halo, running);
  const style = useAnimatedStyle(() => ({ opacity: haloOpacity(clock.get()) }));
  const { r, stroke } = geometry;
  return (
    <Reanimated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg style={StyleSheet.absoluteFill}>
        <Circle
          {...circleOf(geometry, color)}
          r={r + stroke * 1.4}
          strokeWidth={stroke * 0.8}
          strokeOpacity={0.45}
        />
      </Svg>
    </Reanimated.View>
  );
}

function PatternLayer({
  visual,
  geometry,
  color,
  from,
  moving,
  reduced,
}: {
  visual: RingVisual;
  geometry: Geometry;
  color: string;
  from: number;
  moving: boolean;
  reduced: boolean;
}) {
  const { around, c, stroke } = geometry;
  const circle = circleOf(geometry, color);
  const dashes = [stroke * 1.2, stroke * 2];
  switch (visual.pattern) {
    case 'full':
      return (
        <Arc
          share={1}
          from={from}
          geometry={geometry}
          color={color}
          reduced={reduced}
        />
      );
    case 'orbit':
      return (
        <>
          {visual.progress ? (
            <Arc
              share={visual.progress}
              from={visual.progress}
              geometry={geometry}
              color={color}
              reduced={reduced}
            />
          ) : null}
          <Turning period={durations.orbit} running={moving}>
            <Svg style={StyleSheet.absoluteFill}>
              <Circle
                {...circle}
                strokeDasharray={[around * ORBIT, around]}
                transform={`rotate(-90 ${c} ${c})`}
              />
            </Svg>
          </Turning>
        </>
      );
    case 'dashed':
      return (
        <Turning period={DASH_TURN_MS} running={moving}>
          <Svg style={StyleSheet.absoluteFill}>
            <Circle {...circle} strokeDasharray={dashes} />
          </Svg>
        </Turning>
      );
    case 'split':
      return (
        <>
          <Svg style={StyleSheet.absoluteFill}>
            <Circle
              {...circle}
              stroke={palette.honey}
              strokeDasharray={dashes}
            />
          </Svg>
          <Arc
            share={visual.split ?? 0}
            from={visual.split ?? 0}
            geometry={geometry}
            color={color}
            reduced={reduced}
          />
        </>
      );
    case 'held':
      return (
        <Svg style={StyleSheet.absoluteFill}>
          <Circle {...circle} />
        </Svg>
      );
    case 'gap':
      return (
        <Svg style={StyleSheet.absoluteFill}>
          <Circle
            {...circle}
            strokeDasharray={[(around * (360 - GAP_DEGREES)) / 360, around]}
            transform={`rotate(${GAP_AT + GAP_DEGREES / 2 - 90} ${c} ${c})`}
          />
        </Svg>
      );
    case 'expired':
      return (
        <Svg style={StyleSheet.absoluteFill}>
          <Circle {...circle} strokeDasharray={[3, 5]} opacity={0.55} />
        </Svg>
      );
  }
}

/** A glyph part that draws itself along its length, once. */
function DrawnPart({
  d,
  length,
  plan,
}: {
  d: string;
  length: number;
  plan: StrokePlan;
}) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(
      withDelay(
        plan.delay,
        withTiming(1, { duration: plan.duration, easing: curves.enter }),
      ),
    );
  }, [t, plan.delay, plan.duration]);
  const props = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - t.get()),
  }));
  return (
    <AnimatedPath
      d={d}
      strokeDasharray={[length, length]}
      animatedProps={props}
    />
  );
}

/** A glyph part that grows from its middle on the reveal spring, once. */
function GrownPart({
  d,
  index,
  size,
  color,
}: {
  d: string;
  index: number;
  size: number;
  color: string;
}) {
  const g = useSharedValue(0);
  useEffect(() => {
    g.set(withDelay(index * 60, withSpring(1, springs.reveal)));
  }, [g, index]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: g.get() }] }));
  return (
    <Reanimated.View style={[StyleSheet.absoluteFill, style]}>
      <GlyphSvg size={size} color={color}>
        <Path d={d} />
      </GlyphSvg>
    </Reanimated.View>
  );
}

function GlyphSvg({
  size,
  color,
  children,
}: {
  size: number;
  color: string;
  children: ReactNode;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

/**
 * The glyph in the ring: still, unless the ring has just changed state and
 * motion is allowed, when it draws or grows in.
 */
const RingGlyph = memo(function StatusGlyph({
  name,
  size,
  color,
  entrance,
}: {
  name: GlyphName;
  size: number;
  color: string;
  entrance: RingEntrance;
}) {
  const parts = GLYPHS[name];
  if (entrance === 'held') {
    return (
      <View style={{ width: size, height: size }}>
        {parts.map((part, i) => (
          <GrownPart
            key={part.id}
            d={part.d}
            index={i}
            size={size}
            color={color}
          />
        ))}
      </View>
    );
  }
  if (entrance === 'completed' || entrance === 'failed') {
    const plan = drawPlan(name, entrance);
    return (
      <GlyphSvg size={size} color={color}>
        {parts.map((part, i) => (
          <DrawnPart
            key={part.id}
            d={part.d}
            length={GLYPH_LENGTHS[name][i]}
            plan={plan[i]}
          />
        ))}
      </GlyphSvg>
    );
  }
  return <Glyph name={name} size={size} color={color} />;
});

export function StatusRing({ size, visual, test = false }: StatusRingProps) {
  const { reduced } = useMotionPrefs();
  const awake = useAwake();

  // The state last drawn, and how the ring came into the one it is in. A
  // change is read during the render that brings it, so the new state's
  // first frame is already its entrance.
  const [seen, setSeen] = useState({
    visual,
    entrance: 'none' as RingEntrance,
    play: 0,
    // How many times the glyph has been drawn anew, and how it came in the
    // last time: it plays an entrance only as a glyph the ring did not have.
    drawn: 0,
    glyphIn: 'none' as RingEntrance,
    from: filled(visual),
  });
  let now = seen;
  if (!sameVisual(seen.visual, visual)) {
    const entering = ringEntrance(seen.visual, visual);
    const redraws = glyphRedraws(seen.visual, visual);
    now = {
      visual,
      entrance: entering,
      play: seen.play + 1,
      drawn: seen.drawn + (redraws ? 1 : 0),
      glyphIn: redraws ? entering : seen.glyphIn,
      from: filled(seen.visual),
    };
    setSeen(now);
  }
  const { entrance, play, drawn, glyphIn, from } = now;

  const grow = useSharedValue(1);
  const nudge = useSharedValue(0);
  const tint = useSharedValue(0);
  useEffect(() => {
    if (play === 0) return;
    if (entrance === 'completed' && !reduced) {
      grow.set(withDelay(FILL_MS, kick(0.08, springs.reveal)));
    }
    if (entrance === 'failed') {
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
  }, [play, entrance, reduced, grow, nudge, tint]);

  const rootStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: nudge.get() }, { scale: grow.get() }],
  }));
  const tintStyle = useAnimatedStyle(() => ({ opacity: tint.get() }));

  const geometry = ringGeometry(size);
  const color = ringColor(visual.tone, test);
  const moving = awake && !reduced;
  const glyphSize = GLYPH[size];
  const badge = visual.badge;
  const badgeSize = Math.round(size * 0.3);
  return (
    <Reanimated.View
      style={[{ width: size, height: size }, rootStyle]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <LayoutAnimationConfig skipEntering>
        {reduced ? (
          <Reanimated.View
            pointerEvents="none"
            style={[styles.tint, { borderRadius: size / 2 }, tintStyle]}
          />
        ) : null}
        <Svg width={size} height={size}>
          <Circle {...circleOf(geometry, palette.husk)} />
        </Svg>
        {visual.pattern === 'held' ? (
          <Halo geometry={geometry} color={color} running={moving} />
        ) : null}
        <Reanimated.View
          key={`${visual.pattern}:${visual.tone}`}
          entering={reduced ? PATTERN_IN_QUICK : PATTERN_IN}
          exiting={PATTERN_OUT}
          style={StyleSheet.absoluteFill}
        >
          <PatternLayer
            visual={visual}
            geometry={geometry}
            color={color}
            from={entrance === 'completed' && !reduced ? from : filled(visual)}
            moving={moving}
            reduced={reduced}
          />
        </Reanimated.View>
        <View style={styles.center}>
          <RingGlyph
            key={`${visual.glyph}:${drawn}`}
            name={visual.glyph}
            size={glyphSize}
            color={color}
            entrance={reduced ? 'none' : glyphIn}
          />
        </View>
        {badge ? (
          <View
            style={[
              styles.badge,
              badgeAt(size, visual.pattern),
              { width: badgeSize, height: badgeSize },
            ]}
          >
            <Glyph name={badge} size={badgeSize} color={color} />
          </View>
        ) : null}
      </LayoutAnimationConfig>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    borderRadius: radius.round,
    backgroundColor: palette.roast,
  },
  // Reduce Motion's stand-in for a shake: a radish wash behind the ring.
  tint: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.radishSoft,
  },
});
