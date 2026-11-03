import React from 'react';
import type { PropsWithChildren } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { fract, useLoop, wave } from '../../motion/loops';
import { durations } from '../../motion/tokens';

/**
 * The endless motions Receive uses, each a transform or an opacity on a view
 * around a still drawing (REDESIGN.md 3.5), each read from the one loop clock
 * (`useLoop`, REDESIGN.md 10.4). A loop rests where nobody would see it move:
 * under Reduce Motion, in a pane out of use and with the app in the
 * background. It eases into its resting pose rather than snapping there, and
 * picks up where it stopped.
 */

/** Turns its children round, once per `period`: an orbit, a busy control. */
export function Spin({
  period = durations.orbit,
  style,
  children,
}: PropsWithChildren<{ period?: number; style?: StyleProp<ViewStyle> }>) {
  const turn = useLoop(period, true);
  const spin = useAnimatedStyle(() => ({
    transform: [{ rotate: `${fract(turn.get()) * 360}deg` }],
  }));
  return <Reanimated.View style={[style, spin]}>{children}</Reanimated.View>;
}

/** How far the moon rocks either way, in degrees. */
const TILT = 8;

/**
 * Rocks its children 8 degrees one way and then the other over 4200ms, from
 * level and back to it: the moon. It only decorates, so it rests level with
 * the ambient clock (REDESIGN.md 3.5).
 */
export function Rock({
  style,
  children,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const clock = useLoop(durations.breathe, true, true);
  const rock = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${-TILT * Math.sin(2 * Math.PI * clock.get())}deg` },
    ],
  }));
  return <Reanimated.View style={[style, rock]}>{children}</Reanimated.View>;
}

/**
 * Fades its children between full and `low` and back, once per `period`: a
 * caret waiting for digits, a halo asking to be pressed. At rest it holds at
 * full, and it rests with the ambient clock, since what it marks shows
 * without it (REDESIGN.md 3.5).
 */
export function Pulse({
  period = durations.halo,
  low = 0.2,
  style,
  children,
}: PropsWithChildren<{
  period?: number;
  low?: number;
  style?: StyleProp<ViewStyle>;
}>) {
  const clock = useLoop(period, true, true);
  const pulse = useAnimatedStyle(() => ({
    opacity: 1 - (1 - low) * wave(clock.get()),
  }));
  return <Reanimated.View style={[style, pulse]}>{children}</Reanimated.View>;
}
