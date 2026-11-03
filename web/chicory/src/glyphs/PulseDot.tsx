import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  FadeOut,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import { copy } from '../design/copy';
import { palette } from '../design/palette';
import { useAmbientRest } from '../motion/ambient';
import { useAwake, useLoop } from '../motion/loops';
import { ENTRY_GRACE_MS, useSureEntry } from '../motion/sureEntry';
import { curves, durations, springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';

/**
 * The connection, as a 7pt dot at the mark's lower right (REDESIGN.md 5,
 * PulseDot), outlined in roast so it stands off the mark: sage when live,
 * pinging with each poll that succeeds; honey while reconnecting, breathing
 * out and in; a hollow radish ring when the last refresh failed; and gone,
 * shrinking to nothing, when hidden. It comes back with a ping. A new
 * `pingKey` is a poll that succeeded. The pings only decorate, so a poll
 * lands without one while the ambient clock rests (REDESIGN.md 3.5); the
 * reconnecting pulse says something is under way, and keeps breathing.
 *
 * Under Reduce Motion reconnecting is a still, hollow honey ring and a ping
 * only fades.
 */
export type PulseState = 'live' | 'reconnecting' | 'failed' | 'hidden';

export interface PulseDotProps {
  state: PulseState;
  pingKey?: number;
}

const LABELS: Record<Exclude<PulseState, 'hidden'>, string> = {
  live: copy.health.fresh,
  reconnecting: copy.health.reconnecting,
  failed: copy.health.refreshFailed,
};

const SIZE = 7;
const OUTLINE = 1.5;
const PING_MS = 900;

/**
 * A ping at `p`, from 0 to done: a ring that grows to 2.6 and fades. Under
 * Reduce Motion it holds one size and only fades.
 */
export function pingPose(p: number, still: boolean) {
  'worklet';
  return {
    scale: still ? 1.8 : 1 + 1.6 * p,
    opacity: 0.7 * (1 - p),
  };
}

/** The reconnecting pulse at clock `t`: 1 to 1.3 and back each cycle. */
export function pulseScale(t: number): number {
  'worklet';
  return 1 + 0.15 * (1 - Math.cos(2 * Math.PI * t));
}

/** Arriving, the dot springs up from nothing. */
const dotIn: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    // Keep visibility explicit through Android's entering-view cleanup.
    initialValues: { opacity: 1, transform: [{ scale: 0 }] },
    animations: {
      opacity: 1,
      transform: [{ scale: withSpring(1, springs.snap) }],
    },
  };
};
/** Leaving, it shrinks to nothing. */
const dotOut: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { transform: [{ scale: 1 }] },
    animations: {
      transform: [
        {
          scale: withTiming(0, {
            duration: durations.exit,
            easing: curves.exit,
          }),
        },
      ],
    },
  };
};
/** Under Reduce Motion it fades in instead, as a function so it can end surely. */
const dotFade: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0 },
    animations: {
      opacity: withTiming(1, {
        duration: durations.crossfade,
        reduceMotion: ReduceMotion.Never,
      }),
    },
  };
};
const FADE_OUT = FadeOut.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);

function Dot({
  state,
  pingKey,
}: {
  state: Exclude<PulseState, 'hidden'>;
  pingKey?: number;
}) {
  const { reduced } = useMotionPrefs();
  const awake = useAwake();
  const live = state === 'live';
  // The dot is how the mark says the wallet is connected, so it is sure to
  // show, however its entrance fares (`useSureEntry`).
  const entry = useSureEntry(reduced ? dotFade : dotIn, ENTRY_GRACE_MS);

  // Every successful poll, and every return to live, sends out a ring,
  // unless decoration is resting. Waking is neither, so it sends none.
  const resting = useAmbientRest();
  const seen = useRef<{ key?: number; live: boolean } | null>(null);
  const ping = useSharedValue(1);
  useEffect(() => {
    const was = seen.current;
    seen.current = { key: pingKey, live };
    if (!live || resting || (was?.live && was.key === pingKey)) return;
    cancelAnimation(ping);
    ping.set(0);
    ping.set(
      withTiming(1, {
        duration: reduced ? durations.draw : PING_MS,
        easing: curves.enter,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [ping, live, pingKey, reduced, resting]);
  const pulse = useLoop(
    durations.pulse,
    state === 'reconnecting' && awake && !reduced,
  );

  const pingStyle = useAnimatedStyle(() => {
    const pose = pingPose(ping.get(), reduced);
    return { opacity: pose.opacity, transform: [{ scale: pose.scale }] };
  }, [reduced]);
  const coreStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale(pulse.get()) }],
  }));

  const hollow = state === 'failed' || (state === 'reconnecting' && reduced);
  const color =
    state === 'failed' ? palette.radish : live ? palette.sage : palette.honey;
  return (
    <Reanimated.View
      accessible
      accessibilityLabel={LABELS[state]}
      key={entry.key}
      entering={entry.entering}
      exiting={reduced ? FADE_OUT : dotOut}
      style={styles.dot}
    >
      {live ? (
        <Reanimated.View
          pointerEvents="none"
          style={[styles.fill, styles.ping, pingStyle]}
        />
      ) : null}
      <Reanimated.View style={[styles.fill, coreStyle]}>
        <View style={styles.outline} />
        <View
          style={[
            styles.fill,
            hollow
              ? [styles.hollow, { borderColor: color }]
              : { backgroundColor: color },
          ]}
        />
      </Reanimated.View>
    </Reanimated.View>
  );
}

export function PulseDot({ state, pingKey }: PulseDotProps) {
  if (state === 'hidden') return null;
  return <Dot state={state} pingKey={pingKey} />;
}

const styles = StyleSheet.create({
  dot: { width: SIZE, height: SIZE },
  fill: { ...StyleSheet.absoluteFill, borderRadius: SIZE / 2 },
  // Roast around the dot, outside its 7pt, so it reads against the mark.
  outline: {
    position: 'absolute',
    top: -OUTLINE,
    left: -OUTLINE,
    right: -OUTLINE,
    bottom: -OUTLINE,
    borderRadius: SIZE / 2 + OUTLINE,
    backgroundColor: palette.roast,
  },
  hollow: { borderWidth: OUTLINE, backgroundColor: palette.roast },
  ping: { backgroundColor: palette.sage },
});
