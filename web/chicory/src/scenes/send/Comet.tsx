import React from 'react';
import { StyleSheet } from 'react-native';
import Reanimated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, G } from 'react-native-svg';
import { fract, useLoop } from '../../motion/loops';
import { durations } from '../../motion/tokens';

/**
 * Money on its way (REDESIGN.md 5, Comet): a head going round the ring once
 * every 1400ms with a tail fading behind it, where the orbit drew a plain
 * arc. It sets off from the arrow's heading, up and to the right, so it
 * reads as the arrow's own momentum carried on round the ring after the
 * launch at the hold's commit.
 */
export const COMET = {
  /** Degrees from twelve, clockwise: the arrow's launch heading. */
  heading: 45,
  /** The head's diameter, in points, on the hold's 88pt ring. */
  head: 6,
  /** How much of the ring the tail covers. */
  tail: 0.22,
  /** How many arcs the tail fades over. */
  segments: 5,
};

/** One arc of the tail: from how far behind the head to how far, and its opacity. */
export interface TailArc {
  from: number;
  to: number;
  opacity: number;
}

/**
 * The tail's arcs, nearest the head first: `segments` arcs that together
 * cover `tail` of the ring behind the head, each fainter than the last, so
 * the tail tapers away.
 */
export function cometTail(
  tail = COMET.tail,
  segments = COMET.segments,
): TailArc[] {
  return Array.from({ length: segments }, (_, i) => ({
    from: (tail * i) / segments,
    to: (tail * (i + 1)) / segments,
    opacity: (1 - i / segments) * 0.9,
  }));
}

/**
 * The SVG transform that starts a circle's dash at twelve o'clock and runs
 * it the other way round, so a dash grows behind a head going clockwise.
 */
export function behindHead(c: number): string {
  return `translate(${2 * c} 0) scale(-1 1) rotate(-90 ${c} ${c})`;
}

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);
const AnimatedG = Reanimated.createAnimatedComponent(G);

/**
 * The comet round a `size` point ring, `stroke` wide, in `color` at
 * `alpha`, its head `head` across. The drawing is still; only the view
 * round it turns, on `clock` where the caller keeps one, so a comet handed
 * from the hold to the result's mark carries on from where it was, or else
 * on a clock of its own. Under Reduce Motion, or where nobody can see it,
 * the clock rests and the comet holds still.
 *
 * `closing`, from 0 to 1, lengthens the tail into the whole ring as a done
 * result lands (REDESIGN.md 7, T7): one arc grows back from the head as
 * the tail's arcs fade, so the ring closes behind the head with no jump.
 * `entering` and `exiting` are the caller's, for a comet that comes and
 * goes on its own, as the hold's does.
 */
export function Comet({
  size,
  stroke,
  color,
  alpha = 1,
  head = COMET.head,
  clock,
  closing,
  entering,
  exiting,
}: {
  size: number;
  stroke: number;
  color: string;
  alpha?: number;
  head?: number;
  clock?: SharedValue<number>;
  closing?: SharedValue<number>;
  entering?: EntryExitAnimationFunction;
  exiting?: EntryExitAnimationFunction;
}) {
  const own = useLoop(durations.orbit, !clock);
  const turn = clock ?? own;
  const open = useSharedValue(0);
  const close = closing ?? open;
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${fract(turn.get()) * 360}deg` }],
  }));
  const c = size / 2;
  const r = c - stroke / 2;
  const around = 2 * Math.PI * r;
  const tailProps = useAnimatedProps(() => ({ opacity: 1 - close.get() }));
  // One dash as long as the ring, slid back by what is still open; a round
  // cap would leave a dot at the head before anything has closed.
  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: around * (1 - close.get()),
    strokeOpacity: close.get() > 0 ? 1 : 0,
  }));
  return (
    <Reanimated.View
      entering={entering}
      exiting={exiting}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.comet, { width: size, height: size }, style]}
    >
      <Svg width={size} height={size}>
        <G transform={`rotate(${COMET.heading} ${c} ${c})`}>
          <AnimatedG animatedProps={tailProps}>
            {cometTail().map(arc => (
              <Circle
                key={arc.from}
                cx={c}
                cy={c}
                r={r}
                fill="none"
                stroke={color}
                strokeOpacity={alpha * arc.opacity}
                strokeWidth={stroke}
                strokeDasharray={[around * (arc.to - arc.from), around]}
                strokeDashoffset={-around * arc.from}
                transform={behindHead(c)}
              />
            ))}
          </AnimatedG>
          <AnimatedCircle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={[around, around]}
            transform={behindHead(c)}
            animatedProps={ringProps}
          />
          <Circle
            cx={c}
            cy={c - r}
            r={head / 2}
            fill={color}
            fillOpacity={alpha}
          />
        </G>
      </Svg>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({ comet: { position: 'absolute' } });
