import React, { memo } from 'react';
import type { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { GLYPHS, strokeFor } from '../../design/glyphs';
import { fract, useLoop, wave } from '../../motion/loops';
import { durations } from '../../motion/tokens';

/**
 * Glyphs that keep moving while what they mark lasts (REDESIGN.md 4,
 * Animated glyphs). Each moving part is drawn on a layer of its own and only
 * the view around it moves, by transform, on one loop. The loop rests under
 * Reduce Motion and while nobody can see it, leaving the glyph whole and
 * still.
 */

/** The clock's minute hand goes round once in this long while it waits. */
const TURN_MS = 6000;
/** How far, on the 24 grid, each half of the unplug drifts from the other. */
const DRIFT = 1.5;

function svgProps(size: number, color: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: strokeFor(size),
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

/** A `size` point square that screen readers pass over; its owner speaks. */
function Frame({ size, children }: PropsWithChildren<{ size: number }>) {
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

/** One part of a glyph, drawn still on a layer that moves as `move` says. */
function Layer({
  d,
  size,
  color,
  loop,
  move,
}: {
  d: string;
  size: number;
  color: string;
  loop: SharedValue<number>;
  move: (t: number) => { rotate: string } | { translateX: number };
}) {
  const style = useAnimatedStyle(() => ({
    transform: [move(loop.get())],
  }));
  return (
    <Reanimated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg {...svgProps(size, color)}>
        <Path d={d} />
      </Svg>
    </Reanimated.View>
  );
}

const [FACE, MINUTE, HOUR] = GLYPHS.clock;

/**
 * The clock of something that waits, such as money still arriving or a
 * funding not yet confirmed: the face and the hour hand hold still while the
 * minute hand goes round once every 6s.
 */
export const WaitingClock = memo(function WaitingClockView({
  size,
  color,
}: {
  size: number;
  color: string;
}) {
  const turn = useLoop(TURN_MS, true);
  return (
    <Frame size={size}>
      <Svg {...svgProps(size, color)}>
        <Path d={FACE.d} />
        <Path d={HOUR.d} />
      </Svg>
      <Layer
        d={MINUTE.d}
        size={size}
        color={color}
        loop={turn}
        move={t => {
          'worklet';
          return { rotate: `${fract(t) * 360}deg` };
        }}
      />
    </Frame>
  );
});
WaitingClock.displayName = 'WaitingClock';

const [LEFT, RIGHT, SPARK] = GLYPHS.unplug;

/**
 * A connection that is away, such as the primary node: the plug's halves
 * drift apart and back over 1800ms around a still spark.
 */
export const Unplugged = memo(function UnpluggedView({
  size,
  color,
}: {
  size: number;
  color: string;
}) {
  // Out and back once each 1800ms.
  const apart = useLoop(durations.pulse, true);
  const reach = (DRIFT * size) / 24;
  return (
    <Frame size={size}>
      <Svg {...svgProps(size, color)}>
        <Path d={SPARK.d} />
      </Svg>
      <Layer
        d={LEFT.d}
        size={size}
        color={color}
        loop={apart}
        move={t => {
          'worklet';
          return { translateX: -reach * wave(t) };
        }}
      />
      <Layer
        d={RIGHT.d}
        size={size}
        color={color}
        loop={apart}
        move={t => {
          'worklet';
          return { translateX: reach * wave(t) };
        }}
      />
    </Frame>
  );
});
Unplugged.displayName = 'Unplugged';
