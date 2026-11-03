import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';
import { fract, useLoop } from '../../motion/loops';
import { curves, durations } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { useBloom } from './tone';

/**
 * A request listening for its payment (REDESIGN.md 5, Listening ping): a
 * thin ring the frame's shape sets out from it once every 2400ms, 12pt
 * out and gone within 1600, the pulse dot's ping grown to the request's
 * frame. It is 2pt at .45: enough to be seen beside the frame's own 2.5pt
 * ring, and still well under it. It is drawn behind the frame's expiry ring
 * and outside the code, so the code stays ink on cream and the ring that
 * counts down is untouched.
 */
export const PING = {
  /** One ping every this many ms. */
  period: durations.sheen,
  /** How long a ping takes to go out and fade. */
  travel: durations.halo,
  /** How far it goes out past the frame, in points. */
  reach: 12,
  /** How much shows as it sets out: well under the frame's own ring. */
  peak: 0.45,
  stroke: 2,
};

/**
 * The ping at `clock`, for a frame `side` across: how far it has grown and
 * how much of it shows. Each cycle is quiet for its first third, then the
 * ring sets out fast and slows as it fades, and it is gone at every whole
 * number, where the clock rests, so a ping at rest draws nothing.
 */
export function listenPose(
  clock: number,
  side: number,
): { scale: number; opacity: number } {
  'worklet';
  const quiet = 1 - PING.travel / PING.period;
  const p = fract(clock);
  if (p < quiet) return { scale: 1, opacity: 0 };
  const q = (p - quiet) / (1 - quiet);
  const eased = 1 - (1 - q) * (1 - q);
  return {
    scale: 1 + (2 * PING.reach * eased) / side,
    opacity: PING.peak * (1 - q),
  };
}

/**
 * Whether `running` turned false within the last `durations.exit` ms: the
 * time a ping told to stop takes to fade.
 */
function useStopping(running: boolean): boolean {
  const [stopping, setStopping] = useState(false);
  // Known in the render that stops, so the clock is never told to rest in
  // a render the ring still shows in.
  const [was, setWas] = useState(running);
  if (was !== running) {
    setWas(running);
    setStopping(!running);
  }
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), durations.exit);
    return () => clearTimeout(timer);
  }, [stopping]);
  return stopping;
}

/**
 * The ping round a request's frame, `side` across with corners of
 * `radius`, in the network's tone. It only decorates: the frame's ring
 * says the request is live, so the ping rests with the ambient clock,
 * finishing the cycle it is in (REDESIGN.md 3.5), and under Reduce Motion
 * it draws nothing. `running` is whether the request is listening: the
 * code shown and still payable, not lifted, and bloomed in. Told to stop
 * mid-flight, as the code is paid, lifted or runs out, the ring fades out
 * where it is going rather than turning back (3.5): its clock runs on under
 * the fade, and rests once nothing shows.
 */
export function ListeningPing({
  side,
  radius,
  running,
}: {
  side: number;
  radius: number;
  running: boolean;
}) {
  const { reduced } = useMotionPrefs();
  const { bloom } = useBloom();
  const stopping = useStopping(running);
  const clock = useLoop(PING.period, running || stopping, true);
  const shown = useSharedValue(running ? 1 : 0);
  useEffect(() => {
    shown.set(
      withTiming(running ? 1 : 0, {
        duration: durations.exit,
        easing: curves.standard,
      }),
    );
  }, [running, shown]);
  const style = useAnimatedStyle(() => {
    const pose = listenPose(clock.get(), side);
    return {
      opacity: pose.opacity * shown.get(),
      transform: [{ scale: pose.scale }],
    };
  });
  if (reduced) return null;
  const inset = PING.stroke / 2;
  return (
    <Reanimated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.ping, { width: side, height: side }, style]}
    >
      <Svg width={side} height={side}>
        <Rect
          x={inset}
          y={inset}
          width={side - PING.stroke}
          height={side - PING.stroke}
          rx={radius}
          fill="none"
          stroke={bloom}
          strokeWidth={PING.stroke}
        />
      </Svg>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  ping: { position: 'absolute', top: 0, left: 0, overflow: 'visible' },
});
