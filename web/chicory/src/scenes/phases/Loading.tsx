import React, { useEffect, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import {
  PixelRatio,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import type { HostInstance } from 'react-native';
import Reanimated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryAnimationsValues,
  EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Network } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { useFocus } from '../../motion/focus';
import { fadeOut, riseIn, stagger } from '../../motion/presets';
import { curves, durations, overlap, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { motionReduced } from '../../services/motion';
import { DAY_HEIGHT, ROW_GAP, ROW_HEIGHT, ROW_RING } from '../activity/model';
import { GRIP_HEIGHT } from '../activity/sheet';
import {
  HOME,
  PANE_SETTLE_MS,
  STATUS_ROW,
  heroBox,
  stops,
} from '../../stage/layout';
import { CORNER_REACH, CORNER_TARGET } from '../../stage/panes/CornerControl';
import type { Rect } from '../../stage/scene';
import { radius, space, type as typography } from '../../theme';
import { takeHandOff } from './handoff';
import { GlyphButton, useRunning } from './parts';
import { bloomTone, flightFrom, SIZES, WAVE } from './visual';

/**
 * The wallet page before its first figures, drawn as the canvas will be and
 * where the canvas will be (REDESIGN.md 6, loading): the mark in the status
 * row, with the wallet's name, five husk dots breathing in a wave where the
 * balance will stand, the vessel's hairline under them, the actions as husk
 * outlines that cannot be used yet, and skeleton rows in the sheet. Every
 * part sits where the canvas draws its own, from the same measures
 * (`HOME`, `stops`, `STATUS_ROW`), so the live canvas that replaces it
 * builds in over it without anything jumping (R-3). The lock stands where
 * the canvas's corner control will, since a wallet that never answers must
 * still be closable, so nothing the wallet is still doing disables it. A
 * recovery phrase still to save puts its `tile` beside the mark, where the
 * canvas puts it.
 *
 * Like the canvas it runs edge to edge, under the system bars, and keeps its
 * content clear of them itself.
 *
 * A wallet chosen in the picker a moment ago brings its mark with it: the
 * mark flies from that row to the status row, still chasing, and comes to
 * rest as it lands (R-2).
 */
export function OpeningWallet({
  name,
  network,
  onDisconnect,
  tile,
}: {
  name?: string;
  network: Network;
  onDisconnect: () => void;
  /** The shield tile of a recovery phrase still to save, if one is. */
  tile?: ReactNode;
}) {
  const { reduced } = useMotionPrefs();
  // Taken once, as the page mounts; a hand-off is only good for one arrival.
  const [origin] = useState(takeHandOff);
  const flying = !!origin && !reduced;
  const [landed, setLanded] = useState(!flying);
  useEffect(() => {
    if (landed) return;
    const settle = setTimeout(() => setLanded(true), PANE_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [landed]);
  const focus = useFocus();
  const insets = useSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  const at = stops(height, insets);
  const belowStatus = insets.top + STATUS_ROW;
  const [page] = useState(() => ({
    entering: riseIn(overlap.rise, flying ? 0 : overlap.enterDelay),
    // It leaves as the canvas builds in over it, fading in place: a page
    // that shrank or moved as it went would not line up with what replaces
    // it.
    exiting: fadeOut(),
  }));
  return (
    <Reanimated.View
      entering={page.entering}
      exiting={page.exiting}
      style={[
        styles.page,
        { marginLeft: insets.left, marginRight: insets.right },
      ]}
    >
      <View
        style={[styles.status, { paddingTop: insets.top, height: belowStatus }]}
      >
        <View style={styles.identity}>
          <View style={styles.mark}>
            <Reanimated.View
              entering={origin && flying ? arriveFrom(origin) : undefined}
            >
              <Bloom
                size={SIZES.mark}
                tone={bloomTone(network)}
                mode={landed ? 'still' : 'chase'}
                accessibilityLabel={name ? undefined : copy.phase.yourWallet}
              />
            </Reanimated.View>
          </View>
          {name ? (
            <Text numberOfLines={1} style={styles.name}>
              {name}
            </Text>
          ) : null}
          {tile}
        </View>
      </View>
      <View style={[styles.corner, { top: insets.top }]}>
        <GlyphButton
          glyph="lock"
          size={SIZES.cog}
          label={copy.phase.lockDevice}
          onPress={onDisconnect}
        />
      </View>
      <View
        style={[
          styles.home,
          { top: belowStatus, height: at.home - belowStatus },
        ]}
      >
        <View style={styles.middle}>
          <Wave
            ref={focus}
            label={copy.phase.opening}
            height={heroBox(fontScale, PixelRatio.get())}
          />
          <View style={styles.vessel}>
            <View style={styles.hairline} />
          </View>
        </View>
        <View
          style={styles.bar}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {ACTIONS.map(({ glyph, disc, size }) => (
            <View key={glyph} style={styles.slot}>
              <View style={[styles.action, disc]}>
                <Glyph name={glyph} size={size} color={palette.husk} />
              </View>
            </View>
          ))}
        </View>
      </View>
      <View
        style={[styles.sheet, { top: at.home }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View style={styles.grip}>
          <View style={styles.grabber} />
        </View>
        <View style={styles.rows}>
          {SKELETON_ROWS.map((width, row) => (
            <Reanimated.View
              key={width}
              entering={stagger(row)}
              style={styles.row}
            >
              <View style={styles.ring} />
              <View style={styles.lines}>
                <View style={[styles.line, { width }]} />
                <View style={[styles.line, styles.short]} />
              </View>
            </Reanimated.View>
          ))}
        </View>
      </View>
    </Reanimated.View>
  );
}

/**
 * The action row as Home draws it, Send, Scan and Receive, in husk: there,
 * so the page reads as the wallet, and plainly not yet of use. Each disc
 * and glyph is the size Home's circle draws.
 */
const ACTIONS = (
  [
    ['send', HOME.circle, 24],
    ['scan', HOME.row, 30],
    ['receive', HOME.circle, 24],
  ] as const
).map(([glyph, disc, size]) => ({
  glyph,
  disc: { width: disc, height: disc, borderRadius: disc / 2 },
  size,
}));

/** How much the mark lifts as it leaves the picker row. */
const LIFT = 1.25;

/**
 * The mark leaving the picker row it was chosen on: it lifts as it lets go,
 * then settles into the status row on the pane spring.
 */
function arriveFrom(origin: Rect): EntryExitAnimationFunction {
  return (values: EntryAnimationsValues) => {
    'worklet';
    const flight = flightFrom(origin, {
      x: values.targetGlobalOriginX,
      y: values.targetGlobalOriginY,
      width: values.targetWidth,
      height: values.targetHeight,
    });
    return {
      initialValues: {
        transform: [
          { translateX: flight.dx },
          { translateY: flight.dy },
          { scale: flight.scale },
        ],
      },
      animations: {
        transform: [
          { translateX: withSpring(0, springs.pane) },
          { translateY: withSpring(0, springs.pane) },
          {
            scale: withSequence(
              withTiming(flight.scale * LIFT, {
                duration: durations.tick,
                easing: curves.enter,
              }),
              withSpring(1, springs.pane),
            ),
          },
        ],
      },
    };
  };
}

/** The skeleton rows' first lines, each a little shorter than the last. */
const SKELETON_ROWS = ['60%', '48%', '36%'] as const;
const DOTS = Array.from({ length: WAVE.dots }, (_, i) => i);

/** Where a dot rests when the wave cannot run: a still, dim row of dots. */
const STILL = 0.4;

/**
 * Five husk dots breathing one after another, which is the whole of the
 * wait: a screen reader hears it as busy, and a long press whispers it. It
 * stands in the balance's own box, `height` tall. When the figures arrive
 * the dots shrink away as the digits roll in (R-3).
 */
function Wave({
  ref,
  label,
  height,
}: {
  ref?: Ref<HostInstance>;
  label: string;
  height: number;
}) {
  const running = useRunning(true);
  return (
    <Whisper label={label}>
      <Reanimated.View
        ref={ref}
        exiting={shrinkOut()}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityState={{ busy: true }}
        style={[styles.wave, { height }]}
      >
        {DOTS.map(index => (
          <WaveDot key={index} index={index} running={running} />
        ))}
      </Reanimated.View>
    </Whisper>
  );
}

function shrinkOut(): EntryExitAnimationFunction {
  const reduced = motionReduced();
  return () => {
    'worklet';
    const config = {
      duration: reduced ? durations.crossfade : durations.exit,
      easing: curves.exit,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: { opacity: 1, transform: [{ scale: 1 }] },
      animations: {
        opacity: withTiming(0, config),
        transform: [{ scale: withTiming(reduced ? 1 : 0.3, config) }],
      },
    };
  };
}

function WaveDot({ index, running }: { index: number; running: boolean }) {
  const breath = useSharedValue(STILL);
  useEffect(() => {
    if (!running) {
      cancelAnimation(breath);
      breath.set(withTiming(STILL, { duration: durations.crossfade }));
      return;
    }
    breath.set(0);
    breath.set(
      withDelay(
        index * WAVE.step,
        withRepeat(
          withTiming(1, { duration: durations.pulse / 2, easing: curves.sine }),
          -1,
          true,
        ),
      ),
    );
    return () => cancelAnimation(breath);
  }, [running, index, breath]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.35 + 0.65 * breath.get(),
    transform: [{ scale: 0.7 + 0.3 * breath.get() }],
  }));
  return <Reanimated.View style={[styles.dot, style]} />;
}

/** The mark's touch target in the status row, as the canvas's. */
const MARK_TARGET = 48;

const styles = StyleSheet.create({
  page: { ...StyleSheet.absoluteFill },
  // The status row, as the canvas's: the mark's target hangs its petals at
  // the page edge.
  status: {
    paddingLeft: space.xl - (MARK_TARGET - SIZES.mark) / 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  identity: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  mark: {
    width: MARK_TARGET,
    height: MARK_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { ...typography.micro, color: palette.steam, flexShrink: 1 },
  // Where the canvas's corner control stands, its glyph on the same spot.
  corner: {
    position: 'absolute',
    right: space.xl - CORNER_REACH + (CORNER_TARGET - SIZES.cog) / 2,
    height: STATUS_ROW,
    justifyContent: 'center',
  },
  // Home's pane, laid out as Home lays it out.
  home: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: HOME.edge,
  },
  middle: { flex: 1, justifyContent: 'center', gap: HOME.gap },
  wave: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  dot: {
    width: WAVE.size,
    height: WAVE.size,
    borderRadius: WAVE.size / 2,
    backgroundColor: palette.husk,
  },
  vessel: {
    height: HOME.vessel,
    marginHorizontal: HOME.vesselInset,
    justifyContent: 'center',
  },
  hairline: {
    height: 2,
    borderRadius: radius.round,
    backgroundColor: palette.husk,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingBottom: HOME.rowBottom,
  },
  slot: {
    height: HOME.row,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: palette.husk,
  },
  // The sheet at its home stop, full bleed, as the canvas's.
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.pane,
    borderTopRightRadius: radius.pane,
    backgroundColor: palette.espresso,
  },
  grip: {
    height: GRIP_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: radius.round,
    backgroundColor: palette.husk,
  },
  // The first row stands where the list's first row will, under its day.
  rows: { paddingTop: DAY_HEIGHT, paddingHorizontal: HOME.edge },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  ring: {
    width: ROW_RING,
    height: ROW_RING,
    borderRadius: ROW_RING / 2,
    borderWidth: 2,
    borderColor: palette.husk,
  },
  lines: { flex: 1, gap: space.xs },
  line: { height: 12, borderRadius: radius.sm, backgroundColor: palette.husk },
  short: { width: '28%', height: 8 },
});
