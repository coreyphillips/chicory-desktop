import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AccessibilityActionEvent } from 'react-native';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { springs } from '../../motion/tokens';
import { usePaneActive } from '../../stage/panes/Pane';
import { space, type } from '../../theme';
import { BACKUP_HOLD, HOLD_CURVE, holdSteps } from './motion';

const SIZE = 64;
const STROKE = 4;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;
const ACTIONS = [{ name: 'activate' as const }];

const AnimatedCircle = Reanimated.createAnimatedComponent(Circle);

// Reduce Motion keeps the fill (REDESIGN.md 8): it is the hold's only
// measure of how long is left, and it moves nothing through space.
const DRAIN = { ...springs.snap, reduceMotion: ReduceMotion.Never };

/**
 * Confirms something that closes a safety state, as the recovery phrase
 * backup does, with a deliberate hold rather than a tap (REDESIGN.md 6):
 * the ring fills over 900ms, turning from honey to sage as it goes, with a
 * tick at each quarter and a thud when it completes. Letting go early drains
 * it on the snap spring and nothing happens.
 *
 * It is the send track's HoldButton interaction: a screen reader has no hold
 * to give, so it gets one `activate` action that commits at once, and
 * VoiceOver's double tap, which reaches `onAccessibilityTap` rather than the
 * action, commits too. A press that no finger started, such as a switch
 * control's or a keyboard's, is the same deliberate act and commits too; a
 * finger's own tap never does.
 */
export function HoldConfirm({
  label,
  hint,
  onCommit,
  duration = BACKUP_HOLD,
}: {
  label: string;
  hint: string;
  onCommit: () => void;
  duration?: number;
}) {
  const live = usePaneActive();
  const fill = useSharedValue(0);
  const steps = useRef<ReturnType<typeof setTimeout>[]>([]);
  // A finger is on the control, so the press that follows it is its own.
  const finger = useRef(false);
  const committed = useRef(false);

  const stop = () => {
    steps.current.forEach(clearTimeout);
    steps.current = [];
  };
  useEffect(
    () => () => {
      stop();
      cancelAnimation(fill);
    },
    [fill],
  );

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    stop();
    fill.set(1);
    onCommit();
  };
  const begin = () => {
    finger.current = true;
    if (committed.current) return;
    haptics.tap();
    fill.set(
      withTiming(1, {
        duration,
        easing: HOLD_CURVE,
        reduceMotion: ReduceMotion.Never,
      }),
    );
    steps.current = holdSteps(duration).map((at, index) =>
      setTimeout(() => {
        haptics.holdRamp(index + 1);
        if (index === 3) commit();
      }, at),
    );
  };
  const release = () => {
    // The press a finger's tap ends in arrives with or just after this.
    setTimeout(() => {
      finger.current = false;
    }, 0);
    if (committed.current) return;
    stop();
    fill.set(withSpring(0, DRAIN));
  };

  const ring = useAnimatedProps(() => ({
    strokeDashoffset: CIRCUMFERENCE * (1 - fill.get()),
    stroke: interpolateColor(fill.get(), [0, 1], [palette.honey, palette.sage]),
  }));
  const shield = useAnimatedStyle(() => ({ opacity: 1 - fill.get() }));
  const check = useAnimatedStyle(() => ({ opacity: fill.get() }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityActions={ACTIONS}
      onAccessibilityAction={
        live
          ? (event: AccessibilityActionEvent) => {
              if (event.nativeEvent.actionName === 'activate') commit();
            }
          : undefined
      }
      onAccessibilityTap={live ? commit : undefined}
      onPressIn={live ? begin : undefined}
      onPressOut={live ? release : undefined}
      onPress={
        live
          ? () => {
              if (finger.current) {
                finger.current = false;
                return;
              }
              commit();
            }
          : undefined
      }
      style={styles.control}
    >
      <View style={styles.dial}>
        <Svg width={SIZE} height={SIZE} style={StyleSheet.absoluteFill}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={palette.husk}
            strokeWidth={STROKE}
            fill="none"
          />
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={[CIRCUMFERENCE, CIRCUMFERENCE]}
            fill="none"
            rotation={-90}
            origin={`${SIZE / 2}, ${SIZE / 2}`}
            animatedProps={ring}
          />
        </Svg>
        <Reanimated.View style={[styles.glyph, shield]}>
          <Glyph name="shield" size={26} color={palette.honey} />
        </Reanimated.View>
        <Reanimated.View style={[styles.glyph, check]}>
          <Glyph name="check" size={26} color={palette.sage} />
        </Reanimated.View>
      </View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: SIZE + space.xs,
  },
  dial: { width: SIZE, height: SIZE },
  glyph: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...type.label,
    fontSize: 15,
    lineHeight: 20,
    color: palette.cream,
    flex: 1,
  },
});
