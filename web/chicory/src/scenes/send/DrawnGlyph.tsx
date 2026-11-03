import React, { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { GLYPHS, GLYPH_LENGTHS, strokeFor } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { curves, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';

const AnimatedPath = Reanimated.createAnimatedComponent(Path);

/** The glyph grid, in units. */
const GRID = 24;

/**
 * How one part of a glyph arrives, `delay` after the mount: drawn over
 * `duration`, or with `pop`, scaled up with the reveal spring from that
 * point on the 24 grid, as the bang's dot and the pause bars arrive.
 */
export type Stroke =
  | { duration: number; delay?: number; pop?: undefined }
  | { pop: { x: number; y: number }; delay?: number };

/** The bang: its line draws in 200ms, then its dot pops. */
export const BANG: Stroke[] = [
  { duration: 200 },
  { pop: { x: 12, y: 18.5 }, delay: 200 },
];

function Drawn({
  d,
  length,
  duration,
  delay,
  still,
}: {
  d: string;
  length: number;
  duration: number;
  delay: number;
  still: boolean;
}) {
  const drawn = useSharedValue(still ? 1 : 0);
  useEffect(() => {
    if (still) {
      drawn.set(1);
      return;
    }
    drawn.set(0);
    drawn.set(
      withDelay(delay, withTiming(1, { duration, easing: curves.enter })),
    );
  }, [still, duration, delay, drawn]);
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - drawn.get()),
  }));
  return (
    <AnimatedPath
      d={d}
      strokeDasharray={[length, length]}
      animatedProps={animatedProps}
    />
  );
}

/**
 * A part that pops rather than draws. It sits on a layer of its own, a view
 * that scales about the part's own point, so only a transform moves and the
 * drawing itself stays still.
 */
function Popped({
  d,
  at,
  delay,
  still,
  svg,
}: {
  d: string;
  at: { x: number; y: number };
  delay: number;
  still: boolean;
  svg: React.ComponentProps<typeof Svg>;
}) {
  const shown = useSharedValue(still ? 1 : 0);
  useEffect(() => {
    if (still) {
      shown.set(1);
      return;
    }
    shown.set(0);
    shown.set(withDelay(delay, withSpring(1, springs.reveal)));
  }, [still, delay, shown]);
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, shown.get() * 2),
    transform: [{ scale: shown.get() }],
  }));
  const origin = `${(at.x / GRID) * 100}% ${(at.y / GRID) * 100}%`;
  return (
    <Reanimated.View
      style={[StyleSheet.absoluteFill, { transformOrigin: origin }, style]}
    >
      <Svg {...svg}>
        <Path d={d} />
      </Svg>
    </Reanimated.View>
  );
}

/**
 * A glyph that arrives once, part by part (REDESIGN.md 4, Animated glyphs):
 * the check's one stroke drawn as a pen would, the cross's two, the bang's
 * line and then its dot popping, the pause bars popping one after the
 * other. `strokes` times each part in turn, and the last timing serves any
 * part after it. SVG attributes animate here only because the draw is
 * one-off; nothing loops.
 *
 * Under Reduce Motion the glyph is simply there.
 */
export const DrawnGlyph = memo(function DrawnGlyphSvg({
  name,
  size,
  color,
  strokes,
}: {
  name: GlyphName;
  size: number;
  color: string;
  strokes: Stroke[];
}) {
  const { reduced } = useMotionPrefs();
  const lengths = GLYPH_LENGTHS[name];
  const svg = {
    width: size,
    height: size,
    viewBox: `0 0 ${GRID} ${GRID}`,
    fill: 'none',
    stroke: color,
    strokeWidth: strokeFor(size),
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const parts = GLYPHS[name].map((part, index) => ({
    ...part,
    length: lengths[index],
    stroke: strokes[Math.min(index, strokes.length - 1)],
  }));
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg {...svg}>
        {parts.map(({ id, d, length, stroke }) =>
          stroke.pop ? null : (
            <Drawn
              key={id}
              d={d}
              length={length}
              duration={stroke.duration}
              delay={stroke.delay ?? 0}
              still={reduced}
            />
          ),
        )}
      </Svg>
      {parts.map(({ id, d, stroke }) =>
        stroke.pop ? (
          <Popped
            key={id}
            d={d}
            at={stroke.pop}
            delay={stroke.delay ?? 0}
            still={reduced}
            svg={svg}
          />
        ) : null,
      )}
    </View>
  );
});
DrawnGlyph.displayName = 'DrawnGlyph';
