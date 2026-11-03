import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Rect } from 'react-native-svg';
import { palette } from '../design/palette';
import { useLoop, wave } from '../motion/loops';
import { curves, durations } from '../motion/tokens';

/**
 * How long a quote or request has left, as a ring that runs down around the
 * control or frame it belongs to (REDESIGN.md 5, ExpiryRing). It depletes in
 * one linear timing over the time left, turns honey in its last 10 seconds
 * and pulses in its last 3. At zero it retracts, and `onExpired` fires once
 * for each deadline.
 *
 * `createdAt` is when the countdown started, so the ring shows the share
 * left rather than a full ring that suddenly empties; without it the ring is
 * full when it mounts. `shape` 'rect' runs it around a `width` by `height`
 * frame with corner `radius`, such as a request's QR.
 *
 * `lateAt` turns it honey sooner than its last 10 seconds, from that moment:
 * a request's frame warns in its last tenth or its last minute. It never
 * turns later than the 10 seconds.
 *
 * At zero the ring only retracts. It draws no refresh of its own: whoever
 * owns the deadline turns its control into refresh, so an expired quote
 * shows one.
 *
 * Under Reduce Motion the ring still runs down and still turns honey; only
 * the pulse and the retreat are left out. On a test network (`test`) its
 * calm stroke is slate, where it is bloom on mainnet.
 */
export interface ExpiryRingProps {
  size: number;
  expiresAt: number;
  createdAt?: number;
  shape?: 'circle' | 'rect';
  width?: number;
  height?: number;
  radius?: number;
  /** When it turns honey, if sooner than its last 10 seconds. */
  lateAt?: number;
  onExpired?: () => void;
  /** A test network, where slate stands in for bloom. */
  test?: boolean;
}

/** Time left when the ring warns, and when it starts to pulse. */
const LATE_MS = 10_000;
const URGENT_MS = 3_000;
const STROKE = 2.5;

type Stage = 'calm' | 'late' | 'urgent' | 'expired';

/** The stage with `left` ms to go, for a ring that warns `late` ms out. */
function stageAt(left: number, late: number): Stage {
  if (left <= 0) return 'expired';
  if (left <= URGENT_MS) return 'urgent';
  return left <= late ? 'late' : 'calm';
}

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);
const AnimatedRect = Reanimated.createAnimatedComponent(Rect);

export function ExpiryRing({
  size,
  expiresAt,
  createdAt,
  shape = 'circle',
  width = size,
  height = size,
  radius = 0,
  lateAt,
  onExpired,
  test = false,
}: ExpiryRingProps) {
  const late = Math.max(LATE_MS, expiresAt - (lateAt ?? expiresAt));
  // Without a start, the ring is full when it first appears.
  const [mounted] = useState(Date.now);
  const start = createdAt ?? mounted;
  // Each stage belongs to the deadline it was reached for, so a new deadline
  // is never read with the last one's stage.
  const [reached, setReached] = useState(() => ({
    deadline: expiresAt,
    late,
    stage: stageAt(expiresAt - Date.now(), late),
  }));
  const stage =
    reached.deadline === expiresAt && reached.late === late
      ? reached.stage
      : stageAt(expiresAt - Date.now(), late);

  // The stages turn on timers of their own, so nothing renders between them.
  useEffect(() => {
    const left = Math.max(0, expiresAt - Date.now());
    const reach = (next: Stage) =>
      setReached({ deadline: expiresAt, late, stage: next });
    reach(stageAt(left, late));
    const due: [number, Stage][] = [
      [left - late, 'late'],
      [left - URGENT_MS, 'urgent'],
      [left, 'expired'],
    ];
    const timers = due
      .filter(([ms]) => ms > 0)
      .map(([ms, next]) => setTimeout(() => reach(next), ms));
    return () => timers.forEach(clearTimeout);
  }, [expiresAt, late]);

  const share = useSharedValue(1);
  useEffect(() => {
    const left = Math.max(0, expiresAt - Date.now());
    share.set(expiresAt > start ? left / (expiresAt - start) : 0);
    // A countdown is not decoration: it runs down under Reduce Motion too.
    share.set(
      withTiming(0, {
        duration: left,
        easing: curves.linear,
        reduceMotion: ReduceMotion.Never,
      }),
    );
    return () => cancelAnimation(share);
  }, [expiresAt, start, share]);

  // Once per deadline, however often it re-renders past it. A new deadline,
  // such as a refreshed quote, is told again when it runs out.
  const expired = stage === 'expired';
  const told = useRef<number | null>(null);
  useEffect(() => {
    if (!expired || told.current === expiresAt) return;
    told.current = expiresAt;
    onExpired?.();
  }, [expired, expiresAt, onExpired]);

  const pulse = useLoop(durations.pulse, stage === 'urgent');
  const gone = useSharedValue(0);
  useEffect(() => {
    gone.set(
      expired
        ? withTiming(1, { duration: durations.move, easing: curves.exit })
        : 0,
    );
  }, [expired, gone]);
  const style = useAnimatedStyle(() => ({
    opacity: (1 - 0.5 * wave(pulse.get())) * (1 - gone.get()),
    transform: [{ scale: 1 - 0.08 * gone.get() }],
  }));

  const calm = test ? palette.slate : palette.bloom;
  const color = stage === 'calm' ? calm : palette.honey;
  const inset = STROKE / 2;
  const w = shape === 'rect' ? width : size;
  const h = shape === 'rect' ? height : size;
  const length =
    shape === 'rect'
      ? 2 * (w + h - 4 * inset) - (8 - 2 * Math.PI) * radius
      : Math.PI * (size - STROKE);
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: length * (1 - share.get()),
  }));
  const drawn = {
    fill: 'none',
    stroke: color,
    strokeWidth: STROKE,
    strokeLinecap: 'round' as const,
    strokeDasharray: [length, length],
    animatedProps,
  };
  return (
    <Reanimated.View
      style={[styles.ring, { width: w, height: h }, style]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={w} height={h}>
        {shape === 'rect' ? (
          <AnimatedRect
            x={inset}
            y={inset}
            width={w - STROKE}
            height={h - STROKE}
            rx={radius}
            {...drawn}
          />
        ) : (
          <AnimatedCircle
            cx={size / 2}
            cy={size / 2}
            r={(size - STROKE) / 2}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            {...drawn}
          />
        )}
      </Svg>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({ ring: { overflow: 'visible' } });
