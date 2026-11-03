import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, View } from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import Reanimated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  ExitAnimationsValues,
} from 'react-native-reanimated';
import { announce } from '../../design/announce';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomEvent } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { useFocus } from '../../motion/focus';
import { curves, durations } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { BIOMETRY_NAMES, supportedBiometry } from '../../services/lock';
import type { BiometryKind } from '../../services/lock';
import { motionReduced } from '../../services/motion';
import { space } from '../../theme';
import { useRunning } from './parts';
import {
  BUD_OPEN,
  lockVisual,
  markFlight,
  markPoint,
  QUIET_MS,
  SIZES,
  unlockGlyph,
} from './visual';
import type { Point } from './visual';

/**
 * What someone sees when the app lock is on and they have not authenticated.
 *
 * Nothing about the wallet is shown here, no name, no network, no balance,
 * because the point of the lock is that the phone's holder has not proved they
 * are the owner yet. A closed bud breathes above the glyph for the way this
 * phone proves its owner, and the whole screen is the one control.
 *
 * While the system prompt is up the glyph draws itself over and over. A
 * refusal shakes the bud and turns the glyph radish until the next try, with
 * an error haptic and the reason spoken at once. Unlocking unfolds the bud and
 * flies it toward the wallet's mark as the wallet builds under it (R-1).
 */
export function LockScreen({
  prompting,
  error,
  onUnlock,
}: {
  prompting: boolean;
  error: string;
  onUnlock: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { reduced } = useMotionPrefs();
  const look = lockVisual({ prompting, error });
  // Unknown until the keychain answers, so no glyph shows that might be wrong.
  const [kind, setKind] = useState<BiometryKind | null | undefined>();
  useEffect(() => {
    let active = true;
    supportedBiometry().then(value => {
      if (active) setKind(value);
    });
    return () => {
      active = false;
    };
  }, []);

  // Each refusal plays once: the bud shakes, or under Reduce Motion the
  // bloom's own 400ms radish tint stands in for the shake.
  const [refusal, setRefusal] = useState<BloomEvent | undefined>();
  useEffect(() => {
    if (!error) return;
    haptics.error();
    announce(error, { assertive: true });
    setRefusal(last => ({ kind: 'shake', key: (last?.key ?? 0) + 1 }));
  }, [error]);

  // The screen leaves only when the lock opens, so leaving straight after a
  // prompt is an unlock and says so in the hand.
  const prompted = useRef(prompting);
  useEffect(() => {
    prompted.current = prompting;
  }, [prompting]);
  useEffect(
    () => () => {
      if (prompted.current) haptics.success();
    },
    [],
  );

  const focus = useFocus();
  const mark = markPoint(insets);
  const glyph = kind === undefined ? null : unlockGlyph(kind);
  return (
    <Reanimated.View entering={budIn()} style={styles.root}>
      <SafeAreaView style={styles.root} edges={EDGES}>
        <StatusBar barStyle="light-content" />
        <Pressable
          ref={focus}
          accessibilityRole="button"
          accessibilityLabel={copy.phase.unlock}
          accessibilityHint={
            kind === undefined
              ? undefined
              : copy.phase.unlockWith(BIOMETRY_NAMES[kind ?? 'passcode'])
          }
          accessibilityValue={{ text: look.value }}
          accessibilityState={{ disabled: prompting, busy: prompting }}
          disabled={prompting}
          onPress={onUnlock}
          style={styles.screen}
        >
          <View style={styles.bud}>
            <Reanimated.View exiting={unfoldOut(mark, reduced)}>
              <Bloom
                size={SIZES.bud}
                open={BUD_OPEN}
                mode="breathe"
                event={refusal}
                unfoldOnExit={leaveMs(reduced)}
              />
            </Reanimated.View>
          </View>
          {glyph ? (
            <Whisper label={look.status}>
              <View
                accessible
                accessibilityRole="image"
                accessibilityLabel={look.status}
                style={styles.glyph}
              >
                <UnlockGlyph
                  name={glyph}
                  drawing={look.drawing}
                  refused={look.refused}
                />
              </View>
            </Whisper>
          ) : null}
        </Pressable>
      </SafeAreaView>
    </Reanimated.View>
  );
}

const EDGES = ['top', 'bottom', 'left', 'right'] as const;

const GLYPH_SIZE = 32;

/** One pass of the prompting draw, and the rest before the next. */
const DRAW_LOOP_MS = 900;
const DRAW_REST_MS = 360;

/**
 * The unlock glyph. While the system prompt is up it draws itself in from
 * the left, over and over, like a scan: a window slides across the glyph
 * while the glyph slides the other way inside it and so stays put. Only
 * transforms move, and the glyph's drawing never changes. A refusal lays the
 * same glyph in radish over it, flashing as it arrives and holding until the
 * next try.
 */
function UnlockGlyph({
  name,
  drawing,
  refused,
}: {
  name: GlyphName;
  drawing: boolean;
  refused: boolean;
}) {
  const { reduced } = useMotionPrefs();
  const running = useRunning(drawing);
  const drawn = useSharedValue(1);
  useEffect(() => {
    if (!running) {
      cancelAnimation(drawn);
      drawn.set(withTiming(1, { duration: durations.draw }));
      return;
    }
    drawn.set(
      withRepeat(
        withSequence(
          withTiming(0, { duration: 0 }),
          withTiming(1, { duration: DRAW_LOOP_MS, easing: curves.standard }),
          withTiming(1, { duration: DRAW_REST_MS }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(drawn);
  }, [running, drawn]);
  const windowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -GLYPH_SIZE * (1 - drawn.get()) }],
  }));
  const glyphStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: GLYPH_SIZE * (1 - drawn.get()) }],
  }));

  const flash = useSharedValue(0);
  useEffect(() => {
    if (!refused) {
      flash.set(withTiming(0, { duration: durations.enter }));
      return;
    }
    flash.set(
      reduced
        ? 1
        : withSequence(
            withTiming(1, { duration: 60 }),
            withTiming(0.35, { duration: durations.tick }),
            withTiming(1, { duration: durations.tick }),
          ),
    );
  }, [refused, reduced, flash]);
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.get() }));
  // Under Reduce Motion the prompt is a still state: the glyph dims.
  const waiting = reduced && drawing;

  return (
    <View style={[styles.glyphFrame, waiting && styles.waiting]}>
      <Reanimated.View style={[styles.window, windowStyle]}>
        <Reanimated.View style={glyphStyle}>
          <Glyph name={name} size={GLYPH_SIZE} color={palette.steam} />
        </Reanimated.View>
      </Reanimated.View>
      <Reanimated.View style={[styles.overlay, flashStyle]}>
        <Glyph name={name} size={GLYPH_SIZE} color={palette.radish} />
      </Reanimated.View>
    </View>
  );
}

/**
 * The lock check leaves the screen plain roast, and the bud surfaces after a
 * beat (REDESIGN.md 6), so a lock that opens at once never shows. Under
 * Reduce Motion it only fades in, after the same beat, which Reanimated
 * would otherwise skip.
 */
function budIn(): EntryExitAnimationFunction {
  const reduced = motionReduced();
  return () => {
    'worklet';
    const config = {
      duration: reduced ? durations.crossfade : durations.draw,
      easing: curves.enter,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: { opacity: 0, transform: [{ scale: reduced ? 1 : 0.96 }] },
      animations: {
        opacity: withDelay(QUIET_MS, withTiming(1, config), ReduceMotion.Never),
        transform: [
          {
            scale: withDelay(
              QUIET_MS,
              withTiming(1, config),
              ReduceMotion.Never,
            ),
          },
        ],
      },
    };
  };
}

/**
 * R-1's first beats, carried: the bud's own petals unfold where it stands
 * (0 to 500ms), then it flies to the status row's mark and shrinks to it
 * (500 to 880ms) as the wallet builds beneath, and fades as it lands. Under
 * Reduce Motion the petals come back open within a crossfade and the flower
 * fades where it is. The bloom times its petals to the same stay.
 */
function unfoldOut(mark: Point, reduced: boolean): EntryExitAnimationFunction {
  const stay = leaveMs(reduced);
  return (values: ExitAnimationsValues) => {
    'worklet';
    const fade = reduced ? durations.crossfade : durations.exit;
    const out = {
      duration: fade,
      easing: curves.exit,
      reduceMotion: ReduceMotion.Never,
    };
    const opacity = withDelay(
      stay - fade,
      withTiming(0, out),
      ReduceMotion.Never,
    );
    if (reduced) {
      return { initialValues: { opacity: 1 }, animations: { opacity } };
    }
    const flight = markFlight(
      mark,
      {
        x: values.currentGlobalOriginX + values.currentWidth / 2,
        y: values.currentGlobalOriginY + values.currentHeight / 2,
      },
      SIZES.bud,
    );
    const fly = (to: number) =>
      withDelay(
        UNFOLD_MS,
        withTiming(to, {
          duration: FLIGHT_MS,
          easing: curves.standard,
          reduceMotion: ReduceMotion.Never,
        }),
        ReduceMotion.Never,
      );
    return {
      initialValues: {
        opacity: 1,
        transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }],
      },
      animations: {
        opacity,
        transform: [
          { translateX: fly(flight.dx) },
          { translateY: fly(flight.dy) },
          { scale: fly(flight.scale) },
        ],
      },
    };
  };
}

/** How long the bud stays as it leaves: it unfolds, then flies or fades. */
const leaveMs = (reduced: boolean) =>
  UNFOLD_MS + (reduced ? durations.crossfade : FLIGHT_MS);

const UNFOLD_MS = 500;
const FLIGHT_MS = 380;

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xxl,
  },
  bud: {
    width: SIZES.bud,
    height: SIZES.bud,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { padding: space.xs },
  glyphFrame: { width: GLYPH_SIZE, height: GLYPH_SIZE },
  window: { width: GLYPH_SIZE, height: GLYPH_SIZE, overflow: 'hidden' },
  waiting: { opacity: 0.6 },
  overlay: StyleSheet.absoluteFill,
});
