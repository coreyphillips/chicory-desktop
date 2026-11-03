import React, { useEffect, useLayoutEffect, useRef } from 'react';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import {
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { WithTimingConfig } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { steady } from '../../motion/steady';
import { curves, durations } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { Pane } from './Pane';

/**
 * How a scene's content looks `gone` of the way out of the top slot, from 0
 * to 1: it fades and settles back slightly, as `sceneOut` has it, and under
 * Reduce Motion only fades.
 */
export function leavePose(
  gone: number,
  reduced: boolean,
): { opacity: number; transform: { scale: number }[] } {
  'worklet';
  const g = Math.min(1, Math.max(0, gone));
  return {
    opacity: 1 - g,
    transform: [{ scale: reduced ? 1 : 1 - 0.02 * g }],
  };
}

/**
 * How long the content takes to go: 140ms on the exit curve, or under
 * Reduce Motion the first half of a crossfade, which plays however the
 * system asks, since it moves nothing (REDESIGN.md 8).
 */
export function leaveTiming(reduced: boolean): WithTimingConfig {
  return reduced
    ? {
        duration: durations.crossfade / 2,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }
    : { duration: durations.exit, easing: curves.exit };
}

/**
 * A scene in the top slot, Send or Receive, and how it leaves (REDESIGN.md
 * 7, going back). The canvas keeps a scene that has gone drawn where it
 * was, `leaving`, while this fades it with a style of its own, and lets it
 * go once the fade is over (`onGone`). A layout exit would do the same, but
 * on the device it drew what was leaving over the sheet and Home as they
 * came back, where a style keeps it in the slot, under both.
 *
 * Leaving, it is out of use: touches pass through it, a screen reader skips
 * it, and its controls have no handlers. What it draws plays no exits of
 * its own as it is let go: it has faded out already.
 */
export function SceneLeave({
  leaving,
  onGone,
  children,
}: PropsWithChildren<{ leaving: boolean; onGone: () => void }>) {
  const { reduced } = useMotionPrefs();
  const gone = useSharedValue(0);
  const latest = useRef(onGone);
  useLayoutEffect(() => {
    latest.current = onGone;
  });
  useEffect(() => {
    if (!leaving) return;
    const done = () => latest.current();
    gone.set(
      steady(
        withTiming(1, leaveTiming(reduced), () => {
          'worklet';
          scheduleOnRN(done);
        }),
      ),
    );
  }, [leaving, reduced, gone]);
  const fade = useAnimatedStyle(
    () => leavePose(gone.get(), reduced),
    [reduced],
  );
  return (
    <LayoutAnimationConfig skipExiting>
      <Pane active={!leaving} style={[styles.fill, fade]}>
        {children}
      </Pane>
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({ fill: StyleSheet.absoluteFill });
