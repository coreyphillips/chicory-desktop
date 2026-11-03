import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccessibilityActionEvent, LayoutChangeEvent } from 'react-native';
import {
  GestureDetector,
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
} from 'react-native-gesture-handler';
import type {
  PanGestureConfig,
  TapGestureConfig,
} from 'react-native-gesture-handler';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import type { FeeRates } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { GLYPHS, strokeFor } from '../../design/glyphs';
import type { GlyphPart } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Whisper } from '../../glyphs/Whisper';
import { useOnce, useShake } from '../../motion/effects';
import { steady } from '../../motion/steady';
import { curves, durations, overlap, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import {
  GLYPH,
  MARK,
  QUIET_RING,
  ROW,
  ROW_MIN_WIDTH,
  THUMB,
  TICK_GAP_MS,
  TRACK,
  TRACK_START,
  clamp01,
  feeAnchors,
  feeSpoken,
  grabs,
  markPositions,
  marksPassed,
  needleRotate,
  positionAtX,
  positionOf,
  rateAt,
  rubber,
  stepRate,
  thumbCentre,
  travelOf,
} from './feeTrack';
import { useBloom } from './tone';

export interface FeeSliderProps {
  /** The rate under the thumb, whole sats per virtual byte: the review's, or the one being dragged. */
  rate: number;
  /** The engine's estimates when the review was priced, drawn as the marks. */
  rates: FeeRates;
  min: number;
  max: number;
  /** The fee at `rate`, for what a screen reader hears. */
  feeSats: number;
  /** Nothing moves: the hold has committed, the quote ran out, the balance is stale or a call is out. */
  disabled?: boolean;
  /** Why it is held back, whispered on a hold and read as the hint. */
  hint?: string;
  /** Bumps each time the engine refused a chosen rate: the thumb springs back to `rate` and the refusal is felt. */
  refused: number;
  /** The thumb moved to `rate`, once per change of the whole number: the sum previews it. */
  onPreview: (rate: number) => void;
  /** The thumb was let go at `rate`, a tap landed there, or a screen reader stepped to it: the engine prices it. */
  onChoose: (rate: number) => void;
}

const ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

/** How far the thumb dips under the finger, as a key or a tap target does. */
const DIP = 0.94;
/** A sideways drag takes the thumb; this far up or down first lets a vertical gesture win. */
const ACROSS: [number, number] = [-6, 6];
const UPRIGHT: [number, number] = [-12, 12];
/** A tap that wanders further is not a tap. */
const TAP_STRAY = 8;

const HALF_FADE = {
  duration: durations.crossfade / 2,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};
const JUMP = { duration: 1, reduceMotion: ReduceMotion.Never };

/**
 * The thumb to `to`: on the snap spring, or under Reduce Motion a crossfade
 * of 160ms with the jump unseen at its middle (REDESIGN.md 8), as the panes
 * hand over. `veil` is how far the thumb and fill are faded for it.
 */
export function moveTo(
  position: SharedValue<number>,
  veil: SharedValue<number>,
  to: number,
  reduced: boolean,
) {
  'worklet';
  if (!reduced) {
    position.set(steady(withSpring(to, springs.snap)));
    return;
  }
  veil.set(withSequence(withTiming(1, HALF_FADE), withTiming(0, HALF_FADE)));
  position.set(
    withDelay(durations.crossfade / 2, withTiming(to, JUMP), ReduceMotion.Never),
  );
}

const DIAL = GLYPHS.gauge[0];
const NEEDLE = GLYPHS.gauge[1];
/** The gauge's hub on the 24 grid, which its needle turns about. */
const HUB = `50% ${(13 / 24) * 100}%`;

/** Some of the gauge's parts, drawn as Glyph draws the whole. */
function Parts({ parts, color }: { parts: GlyphPart[]; color: string }) {
  return (
    <Svg
      width={GLYPH}
      height={GLYPH}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeFor(GLYPH)}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {parts.map(part => (
        <Path key={part.id} d={part.d} />
      ))}
    </Svg>
  );
}

/**
 * A mark on the track at one of the engine's estimates: bark until the
 * thumb has passed it, then `lit`, the fill's tone, which the thumb covers
 * as it crosses so the change is never seen; bark alone while the slider is
 * held back. Its own component, so each mark has an animated style of its
 * own.
 */
function Mark({
  at,
  position,
  width,
  lit,
}: {
  at: number;
  position: SharedValue<number>;
  width: SharedValue<number>;
  lit?: string;
}) {
  const place = useAnimatedStyle(() => ({
    opacity: width.get() > 0 ? 1 : 0,
    transform: [{ translateX: thumbCentre(at, width.get()) - MARK / 2 }],
  }));
  const passed = useAnimatedStyle(() => ({
    opacity: position.get() >= at ? 1 : 0,
  }));
  return (
    <Reanimated.View pointerEvents="none" style={[styles.mark, place]}>
      {lit ? (
        <Reanimated.View
          style={[styles.markLit, { backgroundColor: lit }, passed]}
        />
      ) : null}
    </Reanimated.View>
  );
}

/**
 * The fee rate of a payment to a Bitcoin address, as a slider under the
 * review's sum with no words on it (REDESIGN.md 6, Send): a husk track with
 * the bloom fill to the thumb, marks at the engine's slow, normal and fast
 * estimates, and a 28pt thumb carrying the gauge, whose needle turns with
 * the rate and stands straight up at normal. The fee line above is its
 * readout: the thumb follows the finger and `onPreview` says each whole rate
 * it passes, felt as a tick, or a soft at a mark; letting go settles the
 * thumb on the rate and `onChoose` asks the engine to price it. A tap on
 * the track moves the thumb there. Past either end the thumb follows on the
 * rubber band and springs back.
 *
 * Held back (`disabled`, or a range with no room) it is a mocha disc in a
 * husk ring with a dust glyph, and a long press whispers why (rule 3). A
 * rate the engine refused (`refused`) springs the thumb back to `rate`,
 * shakes it and is felt as a refused key. A screen reader hears an
 * adjustable control whose value is the zone, the rate and the fee, and
 * steps it with increment and decrement; the thumb then moves as the
 * parent echoes the rate. Haptics play under Reduce Motion as ever (rule 7);
 * the settle, a tap's move and the spring back become a short crossfade.
 */
export function FeeSlider({
  rate,
  rates,
  min,
  max,
  feeSats,
  disabled = false,
  hint,
  refused,
  onPreview,
  onChoose,
}: FeeSliderProps) {
  const { reduced } = useMotionPrefs();
  const tones = useBloom();
  const refusal = useShake();

  const anchorList = useMemo(() => feeAnchors(rates, min, max), [rates, min, max]);
  const markList = useMemo(
    () => markPositions(rates, anchorList),
    [rates, anchorList],
  );
  const usable = anchorList.length > 1;
  const quiet = disabled || !usable;
  const live = usePaneActive() && !quiet;

  // What the worklets read, kept current from render.
  const anchors = useSharedValue(anchorList);
  const marks = useSharedValue(markList);
  useLayoutEffect(() => {
    anchors.set(anchorList);
    marks.set(markList);
  }, [anchorList, markList, anchors, marks]);
  // The row's width, as it was laid out; 0 until then, when nothing is drawn
  // at the track's start only to jump.
  const width = useSharedValue(0);
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      width.set(event.nativeEvent.layout.width);
    },
    [width],
  );

  // Where the thumb is, 0 to 1 and past the ends on the rubber band; how far
  // it dips under the finger; and the crossfade of a jump under Reduce
  // Motion.
  const position = useSharedValue(positionOf(rate, anchorList));
  const dip = useSharedValue(1);
  const veil = useSharedValue(0);
  // The drag in flight: whether a pan has taken the thumb, whether the finger
  // is on it, where it was as the drag began, the whole rate last said, how
  // many marks it was past, and when the last tick played.
  const engaged = useSharedValue(false);
  const grabbed = useSharedValue(false);
  const origin = useSharedValue(0);
  const lastRate = useSharedValue(rate);
  const lastMarks = useSharedValue(0);
  const lastTickAt = useSharedValue(0);
  // The rate the thumb last chose itself, so the parent's echo of it moves
  // nothing.
  const settled = useSharedValue(rate);
  // The needle wakes from the glyph's drawn pose to the rate's heading once
  // the step has landed, as the gauge comes to life.
  const wake = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) {
      wake.set(1);
      return;
    }
    wake.set(
      withDelay(
        overlap.enterDelay + durations.enter,
        withSpring(1, springs.soft),
        ReduceMotion.Never,
      ),
    );
    return () => cancelAnimation(wake);
  }, [reduced, wake]);

  // What the gesture hands back to the JS thread: stable, reading the
  // latest callbacks, so a parent that passes new closures never hands the
  // gesture a new configuration mid-drag.
  const latest = useRef({ onPreview, onChoose });
  useLayoutEffect(() => {
    latest.current = { onPreview, onChoose };
  });
  const preview = useCallback(
    (next: number) => latest.current.onPreview(next),
    [],
  );
  const choose = useCallback(
    (next: number) => {
      settled.set(next);
      latest.current.onChoose(next);
    },
    [settled],
  );
  const felt = useCallback((kind: 'tap' | 'tick' | 'soft') => haptics[kind](), []);

  const pan = usePanGesture(
    useMemo<PanGestureConfig>(
      () => ({
        enabled: live,
        activeOffsetX: ACROSS,
        failOffsetY: UPRIGHT,
        onBegin: event => {
          'worklet';
          // A spring in flight, a tap's move or a settle, stops where it is.
          cancelAnimation(position);
          const held = grabs(event.x, position.get(), width.get());
          grabbed.set(held);
          if (held) {
            if (!reduced) dip.set(withSpring(DIP, springs.snap));
            scheduleOnRN(felt, 'tap');
          }
        },
        onActivate: () => {
          'worklet';
          engaged.set(true);
          origin.set(position.get());
          const inside = clamp01(position.get());
          lastRate.set(rateAt(inside, anchors.get()));
          lastMarks.set(marksPassed(inside, marks.get()));
          lastTickAt.set(0);
          // A drag that began beside the thumb takes it from where it is.
          if (!grabbed.get()) {
            grabbed.set(true);
            if (!reduced) dip.set(withSpring(DIP, springs.snap));
            scheduleOnRN(felt, 'tap');
          }
        },
        onUpdate: event => {
          'worklet';
          const at = rubber(
            origin.get() + event.translationX / travelOf(width.get()),
          );
          position.set(at);
          const inside = clamp01(at);
          const next = rateAt(inside, anchors.get());
          if (next === lastRate.get()) return;
          lastRate.set(next);
          scheduleOnRN(preview, next);
          // Felt once a frame at most: crossing a mark is a soft, otherwise a
          // tick, and never two ticks within TICK_GAP_MS however many whole
          // rates a fast drag crossed.
          const passed = marksPassed(inside, marks.get());
          const now = Date.now();
          if (passed !== lastMarks.get()) {
            lastMarks.set(passed);
            lastTickAt.set(now);
            scheduleOnRN(felt, 'soft');
          } else if (now - lastTickAt.get() >= TICK_GAP_MS) {
            lastTickAt.set(now);
            scheduleOnRN(felt, 'tick');
          }
        },
        onFinalize: () => {
          'worklet';
          if (grabbed.get()) {
            grabbed.set(false);
            if (!reduced) dip.set(withSpring(1, springs.snap));
          }
          // A pan that failed, or never activated, chose nothing.
          if (!engaged.get()) return;
          engaged.set(false);
          const chosen = lastRate.get();
          moveTo(position, veil, positionOf(chosen, anchors.get()), reduced);
          scheduleOnRN(choose, chosen);
        },
      }),
      [
        live,
        reduced,
        position,
        width,
        anchors,
        marks,
        dip,
        veil,
        engaged,
        grabbed,
        origin,
        lastRate,
        lastMarks,
        lastTickAt,
        felt,
        preview,
        choose,
      ],
    ),
  );
  const tap = useTapGesture(
    useMemo<TapGestureConfig>(
      () => ({
        enabled: live,
        maxDistance: TAP_STRAY,
        onActivate: event => {
          'worklet';
          const w = width.get();
          // A tap on the thumb is not a move.
          if (grabs(event.x, position.get(), w)) return;
          const all = anchors.get();
          const next = rateAt(positionAtX(event.x, w), all);
          lastRate.set(next);
          moveTo(position, veil, positionOf(next, all), reduced);
          scheduleOnRN(felt, 'tick');
          scheduleOnRN(choose, next);
        },
      }),
      [live, reduced, position, width, anchors, veil, lastRate, felt, choose],
    ),
  );
  // A race: a lift without travel is the tap, travel takes the pan.
  const gesture = useCompetingGestures(pan, tap);

  // The parent's rate moves the thumb when it is not where the thumb already
  // put itself: a screen reader's step, a quote with new estimates, a
  // refusal's spring back. Never mid-drag.
  const anchorKey = anchorList.join(',');
  const seen = useRef(anchorKey);
  useEffect(() => {
    const sameAnchors = seen.current === anchorKey;
    seen.current = anchorKey;
    if (engaged.get() || (sameAnchors && rate === settled.get())) return;
    settled.set(rate);
    moveTo(position, veil, positionOf(rate, anchorList), reduced);
  }, [rate, anchorKey, anchorList, reduced, engaged, settled, position, veil]);

  // The engine refused the chosen rate: felt as a refused key, shaken, and
  // back to the rate that stood.
  useOnce(refused, () => {
    haptics.rigid();
    refusal.play();
    settled.set(rate);
    moveTo(position, veil, positionOf(rate, anchorList), reduced);
  });

  const thumbStyle = useAnimatedStyle(() => {
    const w = width.get();
    return {
      opacity: w > 0 ? 1 - veil.get() : 0,
      transform: [
        { translateX: thumbCentre(position.get(), w) - THUMB / 2 },
        { scale: dip.get() },
      ],
    };
  });
  const fillStyle = useAnimatedStyle(() => {
    const w = width.get();
    const end = thumbCentre(position.get(), w) - TRACK_START;
    return {
      opacity: w > 0 ? 1 - veil.get() : 0,
      transform: [
        { scaleX: Math.max(0, end / Math.max(1, w - TRACK_START)) },
      ],
    };
  });
  const needleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${needleRotate(position.get()) * wake.get()}deg` }],
  }));

  /** A screen reader's step: one stride, landing on any estimate it would pass. */
  const step = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    const direction = name === 'increment' ? 1 : name === 'decrement' ? -1 : 0;
    if (!direction) return;
    const next = stepRate(rate, direction, anchorList);
    if (next === rate) return;
    haptics.tick();
    onChoose(next);
  };

  const why = hint ?? copy.send.feeRateFixed;
  const glyph = quiet ? palette.dust : palette.ink;
  return (
    <Whisper label={why} enabled={quiet}>
      <Reanimated.View style={refusal.style}>
        <GestureDetector gesture={gesture}>
          <View
            collapsable={false}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={copy.send.feeRate}
            accessibilityHint={quiet ? why : copy.send.feeRateHint}
            accessibilityValue={{
              min,
              max,
              now: rate,
              text: feeSpoken(rate, feeSats, rates),
            }}
            accessibilityState={{ disabled: quiet }}
            accessibilityActions={ACTIONS}
            onAccessibilityAction={live ? step : undefined}
            onLayout={measure}
            style={styles.row}
          >
            <View style={styles.track} />
            {quiet ? null : (
              <Reanimated.View
                style={[styles.fill, { backgroundColor: tones.tone }, fillStyle]}
              />
            )}
            {markList.map(at => (
              <Mark
                key={at}
                at={at}
                position={position}
                width={width}
                lit={quiet ? undefined : tones.tone}
              />
            ))}
            <Reanimated.View
              style={[
                styles.thumb,
                quiet ? styles.quiet : { backgroundColor: tones.tone },
                thumbStyle,
              ]}
            >
              <View style={styles.glyphBox}>
                <Parts parts={[DIAL]} color={glyph} />
                <Reanimated.View
                  style={[StyleSheet.absoluteFill, styles.needle, needleStyle]}
                >
                  <Parts parts={[NEEDLE]} color={glyph} />
                </Reanimated.View>
              </View>
              <Reanimated.View
                pointerEvents="none"
                style={[styles.wash, refusal.tint]}
              />
            </Reanimated.View>
          </View>
        </GestureDetector>
      </Reanimated.View>
    </Whisper>
  );
}

const styles = StyleSheet.create({
  row: { height: ROW, minWidth: ROW_MIN_WIDTH, justifyContent: 'center' },
  track: {
    position: 'absolute',
    left: TRACK_START,
    right: 0,
    height: TRACK,
    borderRadius: TRACK / 2,
    backgroundColor: palette.husk,
  },
  // A full line scaled from its left end to the thumb: never a width that
  // changes.
  fill: {
    position: 'absolute',
    left: TRACK_START,
    right: 0,
    height: TRACK,
    borderRadius: TRACK / 2,
    transformOrigin: '0% 50%',
  },
  mark: {
    position: 'absolute',
    left: 0,
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    backgroundColor: palette.bark,
  },
  markLit: { ...StyleSheet.absoluteFill, borderRadius: MARK / 2 },
  thumb: {
    position: 'absolute',
    left: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quiet: {
    backgroundColor: palette.mocha,
    borderWidth: QUIET_RING,
    borderColor: palette.husk,
  },
  glyphBox: { width: GLYPH, height: GLYPH },
  needle: { transformOrigin: HUB },
  wash: {
    ...StyleSheet.absoluteFill,
    borderRadius: THUMB / 2,
    backgroundColor: palette.radishSoft,
  },
});
