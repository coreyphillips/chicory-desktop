import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import type { WalletSnapshot } from '@beignet/wallet-core';
import { gradients, palette } from '../../design/palette';
import { useAmbientRest } from '../../motion/ambient';
import { REST_CURVE, restEase } from '../../motion/loops';
import { curves } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import type { RegionProps } from '../../stage/Canvas';
import { usePaneActive } from '../../stage/panes/Pane';
import { useTint } from '../../stage/StageContext';
import type { FlashTint } from '../../stage/StageContext';
import { tintTiming } from './motion';
import { useAppActive } from './useAppActive';
import { backdropVisual } from './visual';

export type BackdropProps = Pick<
  RegionProps,
  'snapshot' | 'stale' | 'backup' | 'session' | 'arrived'
>;

const { G0, G1, G2, G3 } = gradients;

/** A stale balance dims the glow and the crema to this. */
const DIMMED = 0.25;

/** How the radish tint comes in and goes out. */
const RADISH_IN = 200;
const RADISH_OUT = 600;

/**
 * One arrival or one failure is often heard twice: from the scene that saw
 * it, and then from the next read of the wallet. A flash within this long of
 * the last of its kind is taken for the same moment and not played again.
 */
const SAME_MOMENT_MS = 3000;

type Stops = ReadonlyArray<{ offset: number; color: string; opacity: number }>;

/** A tint's colour at its strength, fading to nothing. */
const fading = ({ color, opacity }: { color: string; opacity: number }) => [
  { offset: 0, color, opacity },
  { offset: 1, color, opacity: 0 },
];
const HONEY = fading(G3.honey);
const SAGE = fading(G3.sageFlash);
const RADISH = fading(G3.radish);

/** Where the mark sits, as a fraction of the pane, for the honey tint. */
const AT_MARK = { cx: 0.12, cy: 0.06 };
/** Where the hero sits, for the flashes over the balance. */
const AT_HERO = { cx: 0.5, cy: 0.28 };

/**
 * How far past each edge the drifting glows are drawn, so that at the far
 * end of a drift, turned as far as the bloom glow turns, no edge of a layer
 * ever shows inside the pane.
 */
export function glowBleed(width: number, height: number): number {
  const turn = Math.sin((G1.drift.rotate * Math.PI) / 180);
  return Math.ceil(
    G1.drift.x * width +
      G1.drift.y * height +
      (turn * Math.max(width, height)) / 2,
  );
}

/**
 * The ground of the top pane, drawn first so everything else sits on it
 * (REDESIGN.md 3.2). It fills the pane edge to edge, under the status bar
 * too, and takes no touches and says nothing.
 *
 * G0 is a still vertical wash. G1, the bloom glow, drifts on an 18 second
 * sine and turns slowly over 26; G2, the crema, drifts the opposite way on
 * 22. Only the views around them move, by transform and opacity, and never
 * while the pane is covered, the app is away, motion is reduced, or the app
 * has gone untouched long enough for decoration to rest, where each swing
 * slows into the end it was heading for rather than stopping. A stale
 * balance dims both, and a test network turns the glow slate.
 *
 * G3 is the state tint, one at a time, crossfading over 600ms: honey while a
 * backup waits or a payment's outcome is unknown, night while an offline
 * request is open. Over it flash sage when money arrives and radish when a
 * refresh or a payment fails. The scenes on the canvas ask for tints of
 * their own through the stage's tint channel (`useHoldTint`,
 * `useFlashTint`), and the ground draws those too, so a scene never lays a
 * tint of its own over its slot.
 */
export function Backdrop({
  snapshot,
  stale,
  backup,
  session,
  arrived,
}: BackdropProps) {
  const { width, height } = useWindowDimensions();
  const live = usePaneActive();
  const awake = useAppActive();
  const { reduced } = useMotionPrefs();
  const resting = useAmbientRest();
  const shown = live && awake && !reduced;
  const running = shown && !resting;
  const bleed = glowBleed(width, height);
  const spill = { top: -bleed, left: -bleed, right: -bleed, bottom: -bleed };
  const asked = useTint();
  const look = backdropVisual({
    snapshot,
    stale,
    backupPending: !!backup?.pending,
    held: asked.held,
  });

  const drift = useSwing(G1.drift.period / 2, running, shown);
  const spin = useSwing(G1.drift.spin / 2, running, shown);
  const crema = useSwing(G2.drift.period / 2, running, shown);
  const glow = useSharedValue(look.dim ? DIMMED : 1);
  const honey = useSharedValue(look.tint === 'honey' ? 1 : 0);
  const night = useSharedValue(look.tint === 'night' ? 1 : 0);
  const sage = useSharedValue(0);
  const radish = useSharedValue(0);

  // Every tint is a colour and nothing more, so each plays under Reduce
  // Motion as well.
  useEffect(() => {
    const fade = tintTiming(G3.crossfade);
    glow.set(withTiming(look.dim ? DIMMED : 1, fade));
    honey.set(withTiming(look.tint === 'honey' ? 1 : 0, fade));
    night.set(withTiming(look.tint === 'night' ? 1 : 0, fade));
  }, [look.dim, look.tint, glow, honey, night]);

  const flashes = useRef({ sage: -Infinity, radish: -Infinity });
  const flash = useCallback(
    (tint: FlashTint) => {
      const now = Date.now();
      if (now - flashes.current[tint] < SAME_MOMENT_MS) return;
      flashes.current[tint] = now;
      if (tint === 'sage') {
        sage.set(
          withSequence(
            withTiming(1, tintTiming(G3.sageFlash.in, curves.enter)),
            withTiming(0, tintTiming(G3.sageFlash.out)),
          ),
        );
        return;
      }
      // In, held, and out again within the tint's 1200ms.
      radish.set(
        withSequence(
          withTiming(1, tintTiming(RADISH_IN, curves.enter)),
          withDelay(
            G3.radish.hold - RADISH_IN - RADISH_OUT,
            withTiming(0, tintTiming(RADISH_OUT)),
            ReduceMotion.Never,
          ),
        ),
      );
    },
    [sage, radish],
  );

  useEffect(() => {
    if (arrived) flash('sage');
  }, [arrived, flash]);
  const failed = useFailures(snapshot, session.error);
  useEffect(() => {
    if (failed) flash('radish');
  }, [failed, flash]);
  // What a scene flashed before the ground was drawn is over; only a flash
  // asked for from now on plays.
  const seen = useRef(asked.flash?.key ?? 0);
  useEffect(() => {
    if (!asked.flash || asked.flash.key === seen.current) return;
    seen.current = asked.flash.key;
    flash(asked.flash.tint);
  }, [asked.flash, flash]);

  const g1 = useAnimatedStyle(() => {
    const swing = 2 * swingAt(drift.get()) - 1;
    return {
      opacity: glow.get(),
      transform: [
        { translateX: swing * G1.drift.x * width },
        { translateY: swing * G1.drift.y * height },
        { rotate: `${swingAt(spin.get()) * G1.drift.rotate}deg` },
      ],
    };
  }, [width, height]);
  const g2 = useAnimatedStyle(() => {
    const swing = 1 - 2 * swingAt(crema.get());
    return {
      opacity: glow.get(),
      transform: [
        { translateX: swing * G1.drift.x * width },
        { translateY: swing * G1.drift.y * height },
      ],
    };
  }, [width, height]);
  const honeyStyle = useAnimatedStyle(() => ({ opacity: honey.get() }));
  const nightStyle = useAnimatedStyle(() => ({
    opacity: night.get() * G3.night.opacity,
  }));
  const sageStyle = useAnimatedStyle(() => ({ opacity: sage.get() }));
  const radishStyle = useAnimatedStyle(() => ({ opacity: radish.get() }));

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.ground}
    >
      <Wash width={width} height={height} />
      <Reanimated.View style={[styles.layer, spill, g1]}>
        <Glow
          width={width + 2 * bleed}
          height={height + 2 * bleed}
          cx={bleed + G1.cx * width}
          cy={bleed + G1.cy * height}
          radius={G1.r * width}
          stops={look.glow === 'slate' ? G1.test : G1.stops}
        />
      </Reanimated.View>
      <Reanimated.View style={[styles.layer, spill, g2]}>
        <Glow
          width={width + 2 * bleed}
          height={height + 2 * bleed}
          cx={bleed + G2.cx * width}
          cy={bleed + G2.cy * height}
          radius={G2.r * width}
          stops={G2.stops}
        />
      </Reanimated.View>
      <Tint
        style={honeyStyle}
        width={width}
        height={height}
        at={AT_MARK}
        stops={HONEY}
      />
      <Reanimated.View style={[styles.layer, styles.night, nightStyle]} />
      <Tint
        style={sageStyle}
        width={width}
        height={height}
        at={AT_HERO}
        stops={SAGE}
      />
      <Tint
        style={radishStyle}
        width={width}
        height={height}
        at={AT_HERO}
        stops={RADISH}
      />
    </View>
  );
}

/**
 * Where a swing stands, from 0 to 1, when its clock reads `clock`: the clock
 * counts one way across a unit, so the swing is at an end on each whole
 * number, still there, and halfway at each half, at its fastest.
 */
export function swingAt(clock: number): number {
  'worklet';
  return (1 - Math.cos(Math.PI * clock)) / 2;
}

/**
 * The clock of a swing from 0 to 1 and back on a sine, `half` milliseconds
 * each way, while `running` (see swingAt). It rests in the middle until it
 * first runs. When decoration rests while it is `seen`, the swing carries on
 * to the end it was heading for, slowing from its own speed (`restEase`),
 * and starts again from there, where it was still; stopped for anything
 * else, it holds where it is.
 */
function useSwing(
  half: number,
  running: boolean,
  seen: boolean,
): SharedValue<number> {
  const clock = useSharedValue(0.5);
  useEffect(() => {
    const at = clock.get();
    if (running) {
      clock.set(
        withRepeat(
          withTiming(at + 2, { duration: 2 * half, easing: curves.linear }),
          -1,
          false,
        ),
      );
    } else if (seen) {
      const rest = restEase(at, half);
      if (rest.to !== at) {
        clock.set(
          withTiming(rest.to, { duration: rest.duration, easing: REST_CURVE }),
        );
      }
    }
    return () => cancelAnimation(clock);
  }, [half, running, seen, clock]);
  return clock;
}

/**
 * A count that goes up by one each time something fails in front of the
 * user: a refresh that stops working, or a payment that turns failed
 * between one read and the next. The first read of a wallet sets what is
 * already there.
 */
function useFailures(snapshot: WalletSnapshot, error: string): number {
  const [count, setCount] = useState(0);
  const last = useRef<{ wallet: string; failed: Set<string> } | null>(null);
  const hadError = useRef(!!error);
  useEffect(() => {
    const failed = new Set(
      snapshot.activity
        .filter(item => item.status === 'failed')
        .map(item => item.id),
    );
    const before = last.current;
    last.current = { wallet: snapshot.wallet.id, failed };
    if (!before || before.wallet !== snapshot.wallet.id) return;
    if ([...failed].some(id => !before.failed.has(id))) {
      setCount(value => value + 1);
    }
  }, [snapshot]);
  useEffect(() => {
    const was = hadError.current;
    hadError.current = !!error;
    if (error && !was) setCount(value => value + 1);
  }, [error]);
  return count;
}

/** G0: the still wash, a touch of violet at the top down to roast. */
const Wash = memo(function WashSvg({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const id = `wash${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          {stopsOf(G0.stops)}
        </LinearGradient>
      </Defs>
      <Rect width={width} height={height} fill={`url(#${id})`} />
    </Svg>
  );
});

/** A radial glow `radius` points wide, centred `cx`, `cy` points in. */
const Glow = memo(function GlowSvg({
  width,
  height,
  cx,
  cy,
  radius,
  stops,
}: {
  width: number;
  height: number;
  cx: number;
  cy: number;
  radius: number;
  stops: Stops;
}) {
  const id = `glow${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <Svg width={width} height={height}>
      <Defs>
        <RadialGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          cx={cx}
          cy={cy}
          r={radius}
        >
          {stopsOf(stops)}
        </RadialGradient>
      </Defs>
      <Rect width={width} height={height} fill={`url(#${id})`} />
    </Svg>
  );
});

/** One G3 tint, fading out from `at`, shown as far as `style` lets it. */
function Tint({
  style,
  width,
  height,
  at,
  stops,
}: {
  style: ReturnType<typeof useAnimatedStyle>;
  width: number;
  height: number;
  at: { cx: number; cy: number };
  stops: Stops;
}) {
  return (
    <Reanimated.View style={[styles.layer, style]}>
      <Glow
        width={width}
        height={height}
        cx={at.cx * width}
        cy={at.cy * height}
        radius={0.9 * width}
        stops={stops}
      />
    </Reanimated.View>
  );
}

/** The stops of a gradient, as react-native-svg takes them. */
const stopsOf = (stops: Stops) =>
  stops.map(stop => (
    <Stop
      key={stop.offset}
      offset={stop.offset}
      stopColor={stop.color}
      stopOpacity={stop.opacity}
    />
  ));

const styles = StyleSheet.create({
  ground: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.roast,
    overflow: 'hidden',
  },
  layer: StyleSheet.absoluteFill,
  // Night is a flat wash; its strength is the most its layer's opacity
  // reaches.
  night: { backgroundColor: G3.night.color },
});
