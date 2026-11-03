import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { GLYPHS, strokeFor } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { steady } from '../../motion/steady';
import {
  SHAKE,
  SHAKE_STEP,
  curves,
  durations,
  springs,
} from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { ROW_GLYPH } from './hub';

/*
 * The glyphs of Settings' rows that move in parts (REDESIGN.md 4, Animated
 * glyphs): the lock whose shackle closes as Lock device wallet is pressed,
 * the phone that buzzes as haptics turn on, and the scan frame that closes
 * on its bolt as Auto-pay does. Each is drawn as its glyph
 * is, in layers of its parts, so only the part that moves is moved, and
 * only by transform and opacity. Their numbers are exported, so each is a
 * table test.
 */

/**
 * Draws the parts of glyph `name` named in `parts`, as `Glyph` draws them,
 * over the whole of the box it is in. Decoration: the row says the words.
 */
function Parts({
  name,
  parts,
  size,
  color,
}: {
  name: GlyphName;
  parts: readonly string[];
  size: number;
  color: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {GLYPHS[name]
        .filter(part => parts.includes(part.id))
        .map(part => (
          <Path key={part.id} d={part.d} />
        ))}
    </Svg>
  );
}

/** How far the shackle drops as it closes, in points at a row's glyph size. */
export const SHACKLE_DROP = 1.5;

/** How long a shackle let go of without a press takes to lift back, in ms. */
export const SHACKLE_LIFT_MS = 260;

/**
 * How far the shackle drops at `size`: its 1.5pt grown with the glyph, and
 * nothing under Reduce Motion, where the shackle only crossfades.
 */
export const shackleDrop = (size: number, reduced: boolean): number =>
  reduced ? 0 : (SHACKLE_DROP * size) / ROW_GLYPH;

/** `value` held between 0 and 1. */
function unit(value: number): number {
  'worklet';
  return Math.min(1, Math.max(0, value));
}

/**
 * The lock beside Lock device wallet: at rest its shackle stands open, as
 * `unlock` draws it. `shut` closes it: the open shackle crossfades to
 * `lock`'s closed one as both drop `shackleDrop`, so a press lands with a
 * clunk before anything is locked (REDESIGN.md 4, lock to unlock run the
 * other way). `useShackle` moves `shut` with the press.
 */
export function ShackleGlyph({
  size,
  color,
  shut,
}: {
  size: number;
  color: string;
  shut: SharedValue<number>;
}) {
  const { reduced } = useMotionPrefs();
  const drop = shackleDrop(size, reduced);
  const open = useAnimatedStyle(() => ({
    opacity: 1 - unit(shut.get()),
    transform: [{ translateY: drop * shut.get() }],
  }));
  const closed = useAnimatedStyle(() => ({
    opacity: unit(shut.get()),
    transform: [{ translateY: drop * shut.get() }],
  }));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Parts name="lock" parts={['body']} size={size} color={color} />
      <Reanimated.View style={[StyleSheet.absoluteFill, open]}>
        <Parts name="unlock" parts={['shackle']} size={size} color={color} />
      </Reanimated.View>
      <Reanimated.View style={[StyleSheet.absoluteFill, closed]}>
        <Parts name="lock" parts={['shackle']} size={size} color={color} />
      </Reanimated.View>
    </View>
  );
}

/**
 * The press behind `ShackleGlyph`. A finger landing closes the shackle on
 * the snap spring; one lifting with no press after it, a press the finger
 * slid away from, lets it lift back over 260ms; a press that lands keeps it
 * shut while the wallet locks, and closes it for a press no finger started,
 * as a screen reader's. Under Reduce Motion each is a crossfade. All of it
 * runs on the steady clock (REDESIGN.md 3.5), since a lock is followed at
 * once by work that can hold the JavaScript thread.
 *
 * A press arrives with or just after the finger lifts, so the lift waits a
 * turn to see whether one came.
 */
export function useShackle() {
  const { reduced } = useMotionPrefs();
  const shut = useSharedValue(0);
  const lift = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A finger is on the control, and whether its press landed.
  const finger = useRef(false);
  const landed = useRef(false);
  const stop = () => {
    if (lift.current !== null) clearTimeout(lift.current);
    lift.current = null;
  };
  // Nothing lifts a shackle that has gone.
  useEffect(
    () => () => {
      if (lift.current !== null) clearTimeout(lift.current);
    },
    [],
  );
  const close = () =>
    shut.set(
      steady(
        reduced
          ? withTiming(1, {
              duration: durations.crossfade,
              easing: curves.standard,
            })
          : withSpring(1, springs.snap),
      ),
    );
  return {
    shut,
    pressIn: () => {
      stop();
      finger.current = true;
      landed.current = false;
      close();
    },
    pressOut: () => {
      stop();
      lift.current = setTimeout(() => {
        lift.current = null;
        finger.current = false;
        if (landed.current) return;
        shut.set(
          steady(
            withTiming(0, {
              duration: reduced ? durations.crossfade : SHACKLE_LIFT_MS,
              easing: curves.standard,
            }),
          ),
        );
      }, 0);
    },
    release: () => {
      landed.current = true;
      if (!finger.current) close();
    },
  };
}

/**
 * The buzz the phone gives as haptics turn on: the shake's keyframes
 * (REDESIGN.md 3.5) at .15 of its reach, 55ms a step, 330ms in all, so the
 * phone shivers rather than refuses.
 */
export const BUZZ_REACH = 0.15;
export const BUZZ = SHAKE.map(x => x * BUZZ_REACH);

/** How the side bars rest while haptics are off: faint and short. */
export const BARS_OFF_OPACITY = 0.35;
export const BARS_OFF_SCALE = 0.6;

/** The bars' pose at `on`, from 0 (off) to 1 (on). */
export function barsPose(on: number, reduced: boolean, shown: boolean) {
  'worklet';
  return {
    opacity: BARS_OFF_OPACITY + (1 - BARS_OFF_OPACITY) * on,
    // Reduced, they only crossfade: their length says on or off at once.
    scaleY: reduced
      ? shown
        ? 1
        : BARS_OFF_SCALE
      : BARS_OFF_SCALE + (1 - BARS_OFF_SCALE) * on,
  };
}

/**
 * The phone beside Haptics. As haptics turn on, the phone buzzes
 * (`BUZZ`) and its side bars pop to full on the reveal spring; as they turn
 * off, the bars ease back, faint and short, over an exit's 140ms. All of it
 * runs on the steady clock. Under Reduce Motion the phone holds still and
 * the bars only crossfade. What it shows as it is first drawn is where it
 * rests: only a change moves it.
 */
export function HapticsGlyph({
  on,
  size,
  color,
}: {
  on: boolean;
  size: number;
  color: string;
}) {
  const { reduced } = useMotionPrefs();
  const reach = size / ROW_GLYPH;
  const body = useSharedValue(0);
  const bars = useSharedValue(on ? 1 : 0);
  const seen = useRef(on);
  useEffect(() => {
    if (seen.current === on) return;
    seen.current = on;
    if (!on) {
      bars.set(
        steady(
          withTiming(0, {
            duration: reduced ? durations.crossfade : durations.exit,
            easing: curves.standard,
          }),
        ),
      );
      return;
    }
    if (!reduced) {
      body.set(
        steady(
          withSequence(
            ...BUZZ.slice(1).map(x =>
              withTiming(x * reach, {
                duration: SHAKE_STEP,
                easing: curves.linear,
              }),
            ),
          ),
        ),
      );
    }
    bars.set(
      steady(
        reduced
          ? withTiming(1, {
              duration: durations.crossfade,
              easing: curves.standard,
            })
          : withSpring(1, springs.reveal),
      ),
    );
  }, [on, reduced, reach, body, bars]);
  const buzzing = useAnimatedStyle(() => ({
    transform: [{ translateX: body.get() }],
  }));
  const popping = useAnimatedStyle(() => {
    const pose = barsPose(bars.get(), reduced, on);
    return { opacity: pose.opacity, transform: [{ scaleY: pose.scaleY }] };
  });
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Reanimated.View style={[StyleSheet.absoluteFill, popping]}>
        <Parts
          name="haptics"
          parts={['left', 'right']}
          size={size}
          color={color}
        />
      </Reanimated.View>
      <Reanimated.View style={[StyleSheet.absoluteFill, buzzing]}>
        <Parts name="haptics" parts={['body']} size={size} color={color} />
      </Reanimated.View>
    </View>
  );
}

/** How the bolt rests while Auto-pay is off: faint and small in its frame. */
export const BOLT_OFF_OPACITY = 0.35;
export const BOLT_OFF_SCALE = 0.7;
/** How far the frame reaches out before it closes on the bolt. */
export const FRAME_REACH = 1.1;

/** The bolt's pose at `on`, from 0 (off) to 1 (on). */
export function boltPose(on: number, reduced: boolean, shown: boolean) {
  'worklet';
  return {
    opacity: BOLT_OFF_OPACITY + (1 - BOLT_OFF_OPACITY) * on,
    // Reduced, it only crossfades: its size says on or off at once.
    scale: reduced
      ? shown
        ? 1
        : BOLT_OFF_SCALE
      : BOLT_OFF_SCALE + (1 - BOLT_OFF_SCALE) * on,
  };
}

/**
 * The scan frame round its bolt beside Auto-pay. As Auto-pay turns on, the
 * frame's corners reach out a tick and close back on the code on the reveal
 * spring, and the bolt pops to full inside them; as it turns off, the bolt
 * eases back, faint and small, over an exit's 140ms. All of it runs on the
 * steady clock. Under Reduce Motion the frame holds still and the bolt only
 * crossfades. What it shows as it is first drawn is where it rests: only a
 * change moves it.
 */
export function AutoPayGlyph({
  on,
  size,
  color,
}: {
  on: boolean;
  size: number;
  color: string;
}) {
  const { reduced } = useMotionPrefs();
  const frame = useSharedValue(1);
  const bolt = useSharedValue(on ? 1 : 0);
  const seen = useRef(on);
  useEffect(() => {
    if (seen.current === on) return;
    seen.current = on;
    if (!on) {
      bolt.set(
        steady(
          withTiming(0, {
            duration: reduced ? durations.crossfade : durations.exit,
            easing: curves.standard,
          }),
        ),
      );
      return;
    }
    if (!reduced) {
      frame.set(
        steady(
          withSequence(
            withTiming(FRAME_REACH, {
              duration: durations.tick,
              easing: curves.exit,
            }),
            withSpring(1, springs.reveal),
          ),
        ),
      );
    }
    bolt.set(
      steady(
        reduced
          ? withTiming(1, {
              duration: durations.crossfade,
              easing: curves.standard,
            })
          : withSpring(1, springs.reveal),
      ),
    );
  }, [on, reduced, frame, bolt]);
  const closing = useAnimatedStyle(() => ({
    transform: [{ scale: frame.get() }],
  }));
  const popping = useAnimatedStyle(() => {
    const pose = boltPose(bolt.get(), reduced, on);
    return { opacity: pose.opacity, transform: [{ scale: pose.scale }] };
  });
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <Reanimated.View style={[StyleSheet.absoluteFill, closing]}>
        <Parts name="autoPay" parts={['frame']} size={size} color={color} />
      </Reanimated.View>
      <Reanimated.View style={[StyleSheet.absoluteFill, popping]}>
        <Parts name="autoPay" parts={['bolt']} size={size} color={color} />
      </Reanimated.View>
    </View>
  );
}
