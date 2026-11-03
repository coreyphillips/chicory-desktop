import React from 'react';
import { StyleSheet } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { fract, useLoop } from '../../motion/loops';
import { durations } from '../../motion/tokens';

/** How much of the ring the moving arc covers. */
const ARC = 0.25;

/**
 * Money on its way: an arc going round a `size` point circle, once every
 * 1400ms, in `color` at `alpha`. The arc is drawn once and only the view
 * around it turns. Under Reduce Motion, or while nobody can see it, it rests
 * where it is.
 */
export function Orbit({
  size,
  stroke,
  color,
  alpha = 1,
}: {
  size: number;
  stroke: number;
  color: string;
  alpha?: number;
}) {
  const turn = useLoop(durations.orbit, true);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${fract(turn.get()) * 360}deg` }],
  }));
  const c = size / 2;
  const r = c - stroke / 2;
  const around = 2 * Math.PI * r;
  return (
    <Reanimated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.orbit, { width: size, height: size }, style]}
    >
      <Svg width={size} height={size}>
        <Circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeOpacity={alpha}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={[around * ARC, around]}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </Svg>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({ orbit: { position: 'absolute' } });
