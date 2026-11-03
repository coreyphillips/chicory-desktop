import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { ComponentRef, ReactNode, Ref } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type {
  AccessibilityActionEvent,
  AccessibilityValue,
} from 'react-native';
import {
  GestureDetector,
  useLongPressGesture,
} from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { fadeIn, fadeOut } from '../motion/presets';
import { curves, durations, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { Comet } from '../scenes/send/Comet';
import { bloomFor } from '../scenes/send/tone';
import { stepInMs } from '../scenes/send/useLanding';
import { usePaneActive } from '../stage/panes/Pane';
import { useBrowserHold } from '../../../platform/keyboardHold';

/**
 * Hold to send (REDESIGN.md rule 5 and 5, HoldButton). A payment commits
 * only after the circle is held for 700ms, or 1000ms when the engine has
 * `warning`s about it, so a brush of the thumb never pays anyone. A plain tap
 * does nothing, and there is no `onPress` to call.
 *
 * The hold is a long press the gesture handler times on the UI thread, where
 * the fill runs: the complete plays as the ring fills however busy the
 * JavaScript thread is, the payment follows as soon as that thread is free,
 * and a finger lifted after the ring is whole cannot take it back. Lifted
 * before, nothing is paid. Held, the circle dips and its ring fills, with a
 * tick at each quarter. Complete, it thuds, flashes cream and pops, and as
 * the flash peaks the arrow launches, twelve petal sparks burst and the fill
 * drains away. Let go early, the fill drains with the snap spring. With
 * warnings the fill is honey. While `busy` a comet runs round the emptied
 * ring, in bloom for money in flight (REDESIGN.md 5, Comet), setting off
 * from the arrow's heading and turning on the clock the caller keeps in
 * `comet` where it does, so the mark a result grows into carries it on
 * from where it was. On a test network (`test`) slate stands in for bloom
 * throughout.
 *
 * A screen reader has no hold to give, so it gets one `activate` action that
 * commits at once: the confirmation is the deliberate double tap. TalkBack
 * sends that as the action, and VoiceOver as an accessibility tap, since on
 * the new architecture iOS lists `activate` only among the custom actions;
 * both commit. However many of these arrive, `onCommit` is called once until
 * the circle is ready again. Its words are the caller's, and a caller gives
 * the whole of what is committed in `accessibilityValue`, as Send gives the
 * review.
 */
export interface HoldButtonProps {
  accessibilityLabel: string;
  /** What a screen reader hears after the label, such as the time left. */
  accessibilityValue?: AccessibilityValue;
  /**
   * How the hold is committed, in the caller's words when what it commits
   * is not a payment, as Settings' emptying is. Send's own otherwise.
   */
  accessibilityHint?: string;
  onCommit: () => void;
  warning?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** A test network, where slate stands in for bloom. */
  test?: boolean;
  /**
   * The payment was committed for the payer, with no hold, by Settings >
   * Auto-pay (REDESIGN.md rule 5). As `busy` arrives the circle plays the
   * complete a hold ends in, the thud, the flash, the pop, the launch and
   * the burst, once its step has risen into view, rather than simply
   * showing no arrow.
   */
  auto?: boolean;
  /** What sits in the circle instead of the send glyph. */
  children?: ReactNode;
  /**
   * Runs from 0 to 1 over a tick as the hold commits, on the UI thread with
   * the flash, for what the commit ends to fade with it, such as the quote's
   * ring: waiting for the payment's render, which a busy JavaScript thread
   * can hold back, left it drawn and running down for 600ms (P12, 06d).
   */
  commit?: SharedValue<number>;
  /**
   * The clock the comet turns on while `busy`, where the caller keeps one:
   * Send's, so the comet round a result's mark carries on from where this
   * one was (REDESIGN.md 7, T7). Without one the comet keeps its own.
   */
  comet?: SharedValue<number>;
  /** The circle itself, for a screen that moves a screen reader to it. */
  ref?: Ref<ComponentRef<typeof View>>;
}

const ACTIONS = [{ name: 'activate' as const }];

const SIZE = 88;
const RING = 4;
const R = (SIZE - RING) / 2;
const AROUND = 2 * Math.PI * R;
/** The fill gathers slowly, then commits quickly. */
const FILL_CURVE = Easing.bezier(0.35, 0, 0.25, 1);
/** The arrow leaves up and to the right, this far, as it fades. */
const LAUNCH = 28;
const LAUNCH_MS = 240;
const SPARKS = 12;
/** How far past the rim a spark flies. */
const REACH = 34;
const BURST_MS = 700;
/** A finger that strays this far from where it pressed lets go. */
const STRAY = SIZE / 2;

/*
 * The complete, in order: the flash rises over a tick, and the launch, the
 * burst and the drain start as it peaks. The flash, the reduced launch and
 * the drain are a colour, a fade and a ring emptying, which move nothing
 * through space, so they play under Reduce Motion too.
 */
const FLASH_IN = {
  duration: durations.tick,
  reduceMotion: ReduceMotion.Never,
};
const FLASH_OUT = {
  duration: durations.move,
  reduceMotion: ReduceMotion.Never,
};
const DRAIN = {
  duration: durations.move,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};
const FADE = {
  duration: durations.crossfade,
  reduceMotion: ReduceMotion.Never,
};
const FLIGHT = { duration: LAUNCH_MS, easing: curves.exit };
/** What the commit ends fades as the flash rises, and under Reduce Motion. */
const ENDED = {
  duration: durations.tick,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};
const BURST = { duration: BURST_MS, easing: curves.enter };

/** The parts of the hold that move, driven from the UI thread. */
export interface HoldParts {
  fill: SharedValue<number>;
  scale: SharedValue<number>;
  flash: SharedValue<number>;
  launch: SharedValue<number>;
  burst: SharedValue<number>;
  /** Set as the hold commits, until the circle is ready to be held again. */
  sealed: SharedValue<boolean>;
  /** The caller's, run to 1 as the hold commits (`commit`). */
  commit?: SharedValue<number>;
}

/**
 * A finger comes down: the circle dips and the fill runs over `hold` ms.
 * The fill runs under Reduce Motion too: it is the hold's only clock.
 * Returns false on a circle that has already committed, which takes no
 * new hold.
 */
export function pressIn(
  parts: HoldParts,
  hold: number,
  reduced: boolean,
): boolean {
  'worklet';
  if (parts.sealed.get()) return false;
  if (!reduced) parts.scale.set(withSpring(0.94, springs.snap));
  parts.fill.set(
    withTiming(1, {
      duration: hold,
      easing: FILL_CURVE,
      reduceMotion: ReduceMotion.Never,
    }),
  );
  return true;
}

/** The finger lifts before the hold completes: the fill drains away. */
export function letGo(parts: HoldParts) {
  'worklet';
  if (parts.sealed.get()) return;
  parts.scale.set(withSpring(1, springs.snap));
  parts.fill.set(withSpring(0, springs.snap));
}

/**
 * The hold completes (REDESIGN.md 5, HoldButton): the ring is whole, a cream
 * flash rises and the circle pops to 1.06, and what the commit ends fades as
 * the flash rises; as the flash peaks the arrow launches, the sparks burst
 * and the fill drains, so the orbit that runs while the payment is sent has
 * the track to itself. Under Reduce Motion the arrow only fades and nothing
 * pops or bursts. Returns false when the hold had already committed, so it
 * plays once.
 */
export function seal(parts: HoldParts, reduced: boolean): boolean {
  'worklet';
  if (parts.sealed.get()) return false;
  parts.sealed.set(true);
  parts.fill.set(1);
  parts.fill.set(
    withDelay(durations.tick, withTiming(0, DRAIN), ReduceMotion.Never),
  );
  parts.flash.set(
    withSequence(withTiming(1, FLASH_IN), withTiming(0, FLASH_OUT)),
  );
  parts.commit?.set(withTiming(1, ENDED));
  if (reduced) {
    parts.launch.set(
      withDelay(durations.tick, withTiming(1, FADE), ReduceMotion.Never),
    );
    return true;
  }
  parts.scale.set(
    withSequence(withSpring(1.06, springs.reveal), withSpring(1, springs.snap)),
  );
  parts.launch.set(withDelay(durations.tick, withTiming(1, FLIGHT)));
  parts.burst.set(0);
  parts.burst.set(withDelay(durations.tick, withTiming(1, BURST)));
  return true;
}

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);

function HoldGesture({
  browser,
  gesture,
  children,
}: { browser: boolean; gesture: ReturnType<typeof useLongPressGesture>; children: React.ReactElement }) {
  return browser ? children : <GestureDetector gesture={gesture}>{children}</GestureDetector>;
}

/** One petal of the burst, flying out from the rim at its angle. */
function Spark({
  index,
  burst,
  color,
}: {
  index: number;
  burst: SharedValue<number>;
  color: string;
}) {
  const angle = (index * 2 * Math.PI) / SPARKS;
  const style = useAnimatedStyle(() => {
    const t = burst.get();
    const out = SIZE / 2 + REACH * t;
    return {
      opacity: t > 0 && t < 1 ? 1 - t : 0,
      transform: [
        { translateX: Math.sin(angle) * out },
        { translateY: -Math.cos(angle) * out },
        { rotate: `${index * 30}deg` },
        { scale: 1 - 0.5 * t },
      ],
    };
  });
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[styles.spark, { backgroundColor: color }, style]}
    />
  );
}

const SPARK_INDEXES = Array.from({ length: SPARKS }, (_, index) => index);

export function HoldButton({
  accessibilityLabel,
  accessibilityValue,
  accessibilityHint = copy.send.holdHint,
  onCommit,
  warning = false,
  disabled = false,
  busy = false,
  auto = false,
  test = false,
  children,
  commit,
  comet,
  ref,
}: HoldButtonProps) {
  const browser = Platform.OS === 'web';
  const live = usePaneActive() && !disabled && !busy;
  const { reduced } = useMotionPrefs();
  const hold = warning ? durations.holdWarning : durations.hold;
  const fill = useSharedValue(0);
  const scale = useSharedValue(1);
  const flash = useSharedValue(0);
  const launch = useSharedValue(0);
  const burst = useSharedValue(0);
  const sealed = useSharedValue(false);
  const parts = useMemo<HoldParts>(
    () => ({ fill, scale, flash, launch, burst, sealed, commit }),
    [fill, scale, flash, launch, burst, sealed, commit],
  );
  // One list for the button's life, emptied and refilled with each hold.
  const ramp = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Whether `onCommit` has been called since the circle was last ready.
  const committed = useRef(false);
  const latest = useRef(onCommit);
  useLayoutEffect(() => {
    latest.current = onCommit;
  });

  // Auto-pay's complete, waiting for the review's step to rise in.
  const autoSeal = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (autoSeal.current) clearTimeout(autoSeal.current);
    },
    [],
  );

  const stopRamp = useCallback(() => {
    ramp.current.forEach(clearTimeout);
    ramp.current.length = 0;
  }, []);
  useEffect(() => {
    const timers = ramp.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  /** A finger came down: a tap, then a tick at each quarter of the hold. */
  const began = useCallback(() => {
    haptics.tap();
    stopRamp();
    for (const step of [1, 2, 3]) {
      ramp.current.push(
        setTimeout(() => haptics.holdRamp(step), (hold * step) / 4),
      );
    }
  }, [hold, stopRamp]);

  /** The hold committed: the thud, and the payment, once. */
  const landed = useCallback(() => {
    stopRamp();
    if (committed.current) return;
    committed.current = true;
    haptics.holdRamp(4);
    latest.current();
  }, [stopRamp]);

  // Sending shows no arrow. Back from sending without a result, as when the
  // send itself was refused, the circle is ready to be held again and the
  // arrow comes back. Under Reduce Motion that is only a fade, so it plays.
  // Sent by Auto-pay, the complete plays as if held, once the review's step
  // has risen in, so the payer sees it go.
  useEffect(() => {
    if (busy) {
      if (committed.current) return;
      if (!auto) {
        launch.set(1);
        return;
      }
      committed.current = true;
      autoSeal.current = setTimeout(() => {
        autoSeal.current = null;
        if (seal(parts, reduced)) haptics.holdRamp(4);
      }, stepInMs());
      return;
    }
    if (autoSeal.current) clearTimeout(autoSeal.current);
    autoSeal.current = null;
    committed.current = false;
    sealed.set(false);
    launch.set(
      withTiming(0, {
        duration: reduced ? durations.crossfade : durations.enter,
        reduceMotion: ReduceMotion.Never,
      }),
    );
    fill.set(withSpring(0, springs.snap));
  }, [busy, auto, reduced, parts, launch, fill, sealed]);

  // The hold is timed where the fill runs, on the UI thread: it commits the
  // moment the ring is whole, and a finger lifted after that cannot undo it.
  const gesture = useLongPressGesture(
    useMemo(
      () => ({
        enabled: live && !browser,
        minDuration: hold,
        maxDistance: STRAY,
        onBegin: () => {
          'worklet';
          if (pressIn(parts, hold, reduced)) scheduleOnRN(began);
        },
        onActivate: () => {
          'worklet';
          if (seal(parts, reduced)) scheduleOnRN(landed);
        },
        onFinalize: () => {
          'worklet';
          letGo(parts);
          scheduleOnRN(stopRamp);
        },
      }),
      [live, browser, hold, reduced, parts, began, landed, stopRamp],
    ),
  );

  /** A screen reader's commit, which has no hold to give. */
  const commitNow = () => {
    if (committed.current) return;
    seal(parts, reduced);
    landed();
  };

  const browserHold = useBrowserHold({
    enabled: browser && live,
    duration: hold,
    maxDistance: STRAY,
    begin: () => {
      if (!pressIn(parts, hold, reduced)) return false;
      began();
      return true;
    },
    cancel: () => { letGo(parts); stopRamp(); },
    commit: () => { if (seal(parts, reduced)) landed(); },
    accessibleCommit: commitNow,
  });

  const fillProps = useAnimatedProps(() => ({
    strokeDashoffset: AROUND * (1 - fill.get()),
  }));
  const frameStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: 0.9 * flash.get() }));
  // Under Reduce Motion the arrow only fades: nothing travels.
  const arrowStyle = useAnimatedStyle(
    () => ({
      opacity: 1 - launch.get(),
      transform: reduced
        ? []
        : [
            { translateX: LAUNCH * launch.get() },
            { translateY: -LAUNCH * launch.get() },
          ],
    }),
    [reduced],
  );

  const bloom = bloomFor(test);
  const tone = disabled ? palette.dust : warning ? palette.honey : bloom.tone;
  // The payment is in flight whatever the fill was, so the comet is bloom.
  const flight = disabled ? palette.dust : bloom.tone;
  return (
    <Reanimated.View style={[styles.frame, frameStyle]}>
      {SPARK_INDEXES.map(index => (
        <Spark key={index} index={index} burst={burst} color={bloom.hi} />
      ))}
      <HoldGesture browser={browser} gesture={gesture}>
        <View
          {...(browser ? { ...browserHold, dataSet: { holdConfirmation: 'true' } } : {})}
          ref={ref}
          collapsable={false}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityValue={accessibilityValue}
          accessibilityHint={browser ? `Hold Space or Enter to confirm. ${accessibilityHint}` : accessibilityHint}
          accessibilityState={{ disabled: !live, busy }}
          accessibilityActions={ACTIONS}
          onAccessibilityAction={
            live
              ? (event: AccessibilityActionEvent) => {
                  if (event.nativeEvent.actionName === 'activate') {
                    commitNow();
                  }
                }
              : undefined
          }
          onAccessibilityTap={live ? commitNow : undefined}
          style={[
            styles.circle,
            { backgroundColor: bloom.soft },
            warning && styles.warning,
            disabled && styles.inactive,
          ]}
        >
          <Svg
            width={SIZE}
            height={SIZE}
            style={styles.fill}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={palette.husk}
              strokeWidth={RING}
            />
            <AnimatedCircle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={tone}
              strokeWidth={RING}
              strokeLinecap="round"
              strokeDasharray={[AROUND, AROUND]}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              animatedProps={fillProps}
            />
          </Svg>
          <Reanimated.View
            pointerEvents="none"
            style={[styles.flash, flashStyle]}
          />
          <Reanimated.View style={arrowStyle}>
            {children ?? <Glyph name="send" size={32} color={palette.cream} />}
          </Reanimated.View>
          {busy ? (
            <Comet
              size={SIZE}
              stroke={RING}
              color={flight}
              clock={comet}
              entering={fadeIn()}
              exiting={fadeOut()}
            />
          ) : null}
        </View>
      </HoldGesture>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circle: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  warning: { backgroundColor: palette.honeySoft },
  inactive: { backgroundColor: palette.mocha },
  fill: { position: 'absolute', top: 0, left: 0 },
  flash: {
    ...StyleSheet.absoluteFill,
    borderRadius: SIZE / 2,
    backgroundColor: palette.cream,
  },
  spark: {
    position: 'absolute',
    width: 6,
    height: 12,
    borderRadius: 3,
  },
});
