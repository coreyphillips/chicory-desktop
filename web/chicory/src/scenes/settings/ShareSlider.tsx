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
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { steady } from '../../motion/steady';
import { curves, durations, overlap, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import { moveTo } from '../send/FeeSlider';
import {
  GLYPH,
  MARK,
  ROW,
  ROW_MIN_WIDTH,
  THUMB,
  TICK_GAP_MS,
  TRACK,
  clamp01,
  marksPassed,
  rubber,
} from '../send/feeTrack';
import {
  SHARE_MARKS,
  positionOfShare,
  shareAt,
  shareAtX,
  shareCentre,
  shareGrabs,
  shareTravel,
  stepShare,
} from './shareTrack';
import { useAccent } from './ui';

export interface ShareSliderProps {
  /** The share the thumb rests on, 0 to 100 in detents: the saved one. */
  share: number;
  /** What a screen reader hears as the value at `share`. */
  spoken: (share: number) => string;
  /**
   * It has just been switched on: the thumb grows from 0 to `share` as it
   * mounts, on the reveal spring, rather than resting there from the first
   * frame. Read once.
   */
  wake?: boolean;
  /** The thumb is over `share`, once per detent, as it is dragged or grows out: the readout follows. */
  onPreview: (share: number) => void;
  /** The thumb was let go on `share`, a tap landed there, or a screen reader stepped to it: it is saved. */
  onChoose: (share: number) => void;
}

const ACTIONS = [
  { name: 'increment' as const },
  { name: 'decrement' as const },
];

/** How far the thumb dips under the finger, as a key does. */
const DIP = 0.94;
/** How far the bolt pops as the thumb lands on a share. */
export const POP = 1.15;
/** A sideways drag takes the thumb; this far up or down first lets the page scroll. */
const ACROSS: [number, number] = [-6, 6];
const UPRIGHT: [number, number] = [-12, 12];
/** A tap that wanders further is not a tap. */
const TAP_STRAY = 8;
/** The thumb sets out once the row's content has begun to rise in. */
const WAKE_DELAY = overlap.enterDelay;

/** The bolt's pop as the thumb lands: out a tick, back on the snap spring. */
function pop(scale: SharedValue<number>, reduced: boolean) {
  'worklet';
  if (reduced) return;
  scale.set(
    withSequence(
      withTiming(POP, { duration: durations.tick, easing: curves.exit }),
      withSpring(1, springs.snap),
    ),
  );
}

/** A mark on the track: bark until the thumb has passed it, then the accent. */
function Mark({
  at,
  position,
  width,
  lit,
}: {
  at: number;
  position: SharedValue<number>;
  width: SharedValue<number>;
  lit: string;
}) {
  const place = useAnimatedStyle(() => ({
    opacity: width.get() > 0 ? 1 : 0,
    transform: [{ translateX: shareCentre(at, width.get()) - MARK / 2 }],
  }));
  const passed = useAnimatedStyle(() => ({
    opacity: position.get() >= at ? 1 : 0,
  }));
  return (
    <Reanimated.View pointerEvents="none" style={[styles.mark, place]}>
      <Reanimated.View
        style={[styles.markLit, { backgroundColor: lit }, passed]}
      />
    </Reanimated.View>
  );
}

/**
 * The share of the balance Auto-pay may spend on a scanned code, as a
 * slider (REDESIGN.md 5, ShareSlider): the fee rate slider's husk track and
 * accent fill, marks at a quarter, a half and three quarters, and a 28pt
 * accent thumb carrying the bolt. It moves in detents of 5%. Dragged, the
 * thumb follows the finger and each detent it crosses is felt as a tick, a
 * mark or either end as a soft, and `onPreview` says it so the readout above
 * rolls with it; let go, the thumb settles on its detent, the bolt pops and
 * `onChoose` saves it, once. A tap on the track moves the thumb there.
 * Past either end it follows on the rubber band and springs back.
 *
 * Switched on (`wake`), the thumb grows out from 0 to the saved share on the
 * reveal spring, with the readout following it. A screen reader hears an
 * adjustable control whose value is the share and what it allows, and steps
 * it 5% at a time. Haptics play under Reduce Motion as ever (rule 7); the
 * settle and a tap's move become a short crossfade, and the thumb is simply
 * where it rests as it mounts.
 */
export function ShareSlider({
  share,
  spoken,
  wake = false,
  onPreview,
  onChoose,
}: ShareSliderProps) {
  const { reduced } = useMotionPrefs();
  const { accent } = useAccent();
  const live = usePaneActive();

  // The row's width, as it was laid out; 0 until then, when nothing is drawn.
  const width = useSharedValue(0);
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      width.set(event.nativeEvent.layout.width);
    },
    [width],
  );

  const woken = useRef(wake && !reduced);
  const position = useSharedValue(woken.current ? 0 : positionOfShare(share));
  // Whether the thumb is growing out to the share, for the readout to follow.
  const waking = useSharedValue(woken.current);
  const dip = useSharedValue(1);
  const bolt = useSharedValue(1);
  const veil = useSharedValue(0);
  // The drag in flight: whether a pan has taken the thumb, whether the finger
  // is on it, where it was as the drag began, the share last felt, how many
  // marks it was past, and when the last tick played.
  const engaged = useSharedValue(false);
  const grabbed = useSharedValue(false);
  const origin = useSharedValue(0);
  const lastShare = useSharedValue(share);
  const lastMarks = useSharedValue(0);
  const lastTickAt = useSharedValue(0);
  // The share the thumb last chose itself, so the parent's echo of it moves
  // nothing.
  const settled = useSharedValue(share);

  // What the gesture hands back to the JS thread: stable, reading the
  // latest callbacks.
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
  const felt = useCallback(
    (kind: 'tap' | 'tick' | 'soft') => haptics[kind](),
    [],
  );

  // Switched on, the thumb grows out to where it rests, and lands soft.
  useEffect(() => {
    if (!woken.current) return;
    woken.current = false;
    position.set(
      steady(
        withDelay(
          WAKE_DELAY,
          withSpring(positionOfShare(share), springs.reveal, () => {
            'worklet';
            waking.set(false);
          }),
          ReduceMotion.Never,
        ),
      ),
    );
    // Landed, the readout says the share it rests on, wherever its count
    // had got to.
    const landing = setTimeout(() => {
      haptics.soft();
      latest.current.onPreview(share);
    }, WAKE_DELAY + durations.move);
    return () => clearTimeout(landing);
    // Read once, as it mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While it grows out, the readout counts up with it, a detent at a time.
  useAnimatedReaction(
    () => shareAt(position.get()),
    (now, before) => {
      if (waking.get() && before !== null && now !== before) {
        scheduleOnRN(preview, now);
      }
    },
    [preview],
  );

  const pan = usePanGesture(
    useMemo<PanGestureConfig>(
      () => ({
        enabled: live,
        activeOffsetX: ACROSS,
        failOffsetY: UPRIGHT,
        onBegin: event => {
          'worklet';
          cancelAnimation(position);
          waking.set(false);
          const held = shareGrabs(event.x, position.get(), width.get());
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
          lastShare.set(shareAt(inside));
          lastMarks.set(marksPassed(inside, SHARE_MARKS));
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
            origin.get() + event.translationX / shareTravel(width.get()),
          );
          position.set(at);
          const inside = clamp01(at);
          const next = shareAt(inside);
          if (next === lastShare.get()) return;
          lastShare.set(next);
          scheduleOnRN(preview, next);
          // Felt once a frame at most: either end or a mark is a soft,
          // otherwise a tick, never two within TICK_GAP_MS.
          const passed = marksPassed(inside, SHARE_MARKS);
          const now = Date.now();
          if (passed !== lastMarks.get() || next === 0 || next === 100) {
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
          const chosen = lastShare.get();
          moveTo(position, veil, positionOfShare(chosen), reduced);
          pop(bolt, reduced);
          scheduleOnRN(choose, chosen);
        },
      }),
      [
        live,
        reduced,
        position,
        waking,
        width,
        dip,
        bolt,
        veil,
        engaged,
        grabbed,
        origin,
        lastShare,
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
          if (shareGrabs(event.x, position.get(), w)) return;
          const next = shareAt(shareAtX(event.x, w));
          waking.set(false);
          lastShare.set(next);
          moveTo(position, veil, positionOfShare(next), reduced);
          pop(bolt, reduced);
          scheduleOnRN(felt, 'tick');
          scheduleOnRN(choose, next);
        },
      }),
      [
        live,
        reduced,
        position,
        waking,
        width,
        veil,
        bolt,
        lastShare,
        felt,
        choose,
      ],
    ),
  );
  // A race: a lift without travel is the tap, travel takes the pan.
  const gesture = useCompetingGestures(pan, tap);

  // The parent's share moves the thumb when it is not where the thumb
  // already put itself: a screen reader's step, or a save refused. Never
  // mid-drag.
  useEffect(() => {
    if (engaged.get() || share === settled.get()) return;
    settled.set(share);
    moveTo(position, veil, positionOfShare(share), reduced);
  }, [share, reduced, engaged, settled, position, veil]);

  const thumbStyle = useAnimatedStyle(() => {
    const w = width.get();
    return {
      opacity: w > 0 ? 1 - veil.get() : 0,
      transform: [
        { translateX: shareCentre(position.get(), w) - THUMB / 2 },
        { scale: dip.get() },
      ],
    };
  });
  const fillStyle = useAnimatedStyle(() => {
    const w = width.get();
    return {
      opacity: w > 0 ? 1 - veil.get() : 0,
      transform: [
        {
          scaleX: Math.max(0, shareCentre(position.get(), w) / Math.max(1, w)),
        },
      ],
    };
  });
  const boltStyle = useAnimatedStyle(() => ({
    transform: [{ scale: bolt.get() }],
  }));

  /** A screen reader's step: one detent. */
  const step = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    const direction = name === 'increment' ? 1 : name === 'decrement' ? -1 : 0;
    if (!direction) return;
    const next = stepShare(share, direction);
    if (next === share) return;
    haptics.tick();
    onChoose(next);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={copy.settings.phone.autoPayLimit}
        accessibilityHint={copy.settings.phone.autoPayLimitHint}
        accessibilityValue={{
          min: 0,
          max: 100,
          now: share,
          text: spoken(share),
        }}
        accessibilityActions={ACTIONS}
        onAccessibilityAction={live ? step : undefined}
        onLayout={measure}
        style={styles.row}
      >
        <View style={styles.track} />
        <Reanimated.View
          style={[styles.fill, { backgroundColor: accent }, fillStyle]}
        />
        {SHARE_MARKS.map(at => (
          <Mark
            key={at}
            at={at}
            position={position}
            width={width}
            lit={accent}
          />
        ))}
        <Reanimated.View
          style={[styles.thumb, { backgroundColor: accent }, thumbStyle]}
        >
          <Reanimated.View style={boltStyle}>
            <Glyph name="bolt" size={GLYPH} color={palette.ink} />
          </Reanimated.View>
        </Reanimated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // As wide as the row's content, and never too short for the thumb to
  // travel.
  row: { height: ROW, minWidth: ROW_MIN_WIDTH, justifyContent: 'center' },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: TRACK,
    borderRadius: TRACK / 2,
    backgroundColor: palette.husk,
  },
  // A full line scaled from its left end to the thumb: never a width that
  // changes.
  fill: {
    position: 'absolute',
    left: 0,
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
});
