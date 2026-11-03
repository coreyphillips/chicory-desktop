import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { GLYPHS, strokeFor } from '../../design/glyphs';
import { curves, durations } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { DrawnGlyph } from './DrawnGlyph';

/*
 * The error glyphs that do more than draw in (REDESIGN.md 4, Animated
 * glyphs), as an engine refusal shows them (6, Engine errors): the bolt of a
 * payment that found no route draws in and then flashes, and the chain of a
 * funding not yet confirmed closes as its halves slide together. Each plays
 * once as it arrives. Under Reduce Motion each is simply there.
 */

/** The bolt draws in this long, then flashes. */
export const BOLT_DRAW_MS = 240;
/** How far the bolt dims at each flicker of its flash. */
const FLICKER = 0.25;

/** The chain's halves close this far between them, in points, as it arrives. */
export const CHAIN_SLIDE = 3;
const CHAIN_MS = 200;

/** A `size` point square that screen readers pass over; its owner speaks. */
function Frame({
  size,
  children,
}: {
  size: number;
  children: React.ReactNode;
}) {
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </View>
  );
}

/** No route: the bolt draws in over 240ms, then flickers twice. */
export const FlashingBolt = memo(function FlashingBoltView({
  size,
  color,
}: {
  size: number;
  color: string;
}) {
  const { reduced } = useMotionPrefs();
  const lit = useSharedValue(1);
  useEffect(() => {
    lit.set(1);
    if (reduced) return;
    const flicker = (to: number) =>
      withTiming(to, { duration: durations.tick, easing: curves.standard });
    lit.set(
      withDelay(
        BOLT_DRAW_MS,
        withSequence(
          flicker(FLICKER),
          flicker(1),
          flicker(FLICKER),
          flicker(1),
        ),
      ),
    );
  }, [reduced, lit]);
  const style = useAnimatedStyle(() => ({ opacity: lit.get() }));
  return (
    <Frame size={size}>
      <Reanimated.View style={style}>
        <DrawnGlyph
          name="bolt"
          size={size}
          color={color}
          strokes={[{ duration: BOLT_DRAW_MS }]}
        />
      </Reanimated.View>
    </Frame>
  );
});
FlashingBolt.displayName = 'FlashingBolt';

const [UPPER, LOWER] = GLYPHS.chain;

/**
 * Not yet confirmed: the chain's two halves arrive apart along its diagonal
 * and slide together over 200ms, each half of the way.
 */
export const ClosingChain = memo(function ClosingChainView({
  size,
  color,
}: {
  size: number;
  color: string;
}) {
  const { reduced } = useMotionPrefs();
  const apart = useSharedValue(reduced ? 0 : 1);
  useEffect(() => {
    if (reduced) {
      apart.set(0);
      return;
    }
    apart.set(1);
    apart.set(withTiming(0, { duration: CHAIN_MS, easing: curves.enter }));
  }, [reduced, apart]);
  // Each half covers half the slide, along the chain's diagonal.
  const step = CHAIN_SLIDE / 2 / Math.SQRT2;
  const upper = useAnimatedStyle(() => ({
    transform: [
      { translateX: step * apart.get() },
      { translateY: -step * apart.get() },
    ],
  }));
  const lower = useAnimatedStyle(() => ({
    transform: [
      { translateX: -step * apart.get() },
      { translateY: step * apart.get() },
    ],
  }));
  const svg = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: strokeFor(size),
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Frame size={size}>
      {[
        { part: UPPER, style: upper },
        { part: LOWER, style: lower },
      ].map(({ part, style }) => (
        <Reanimated.View key={part.id} style={[StyleSheet.absoluteFill, style]}>
          <Svg {...svg}>
            <Path d={part.d} />
          </Svg>
        </Reanimated.View>
      ))}
    </Frame>
  );
});
ClosingChain.displayName = 'ClosingChain';
