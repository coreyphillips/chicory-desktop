import React, { useEffect } from 'react';
import type { ComponentRef, ReactNode, Ref } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Whisper } from '../../glyphs/Whisper';
import { useShake } from '../../motion/effects';
import { curves, durations, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import { DrawnGlyph } from './DrawnGlyph';
import { Orbit } from './Orbit';
import { useBloom } from './tone';

/** The control's circle, the size the home circle grows to (REDESIGN.md 7, T1). */
export const CONTROL = 88;
const RING = 4;

type Tone = 'bloom' | 'honey';

/**
 * Send's round control at the foot of the scene, for a tap: review the
 * payment, or refresh a quote that ran out. While `busy` an orbit runs round
 * it. Without `onPress`, as before there is a request to review, it waits in
 * dust.
 *
 * `stale` is the gate a balance too old to spend against closes
 * (REDESIGN.md 6, Send): the control turns dust and says why, and a tap
 * shakes it before `onPress`, which the caller points at a refresh rather
 * than at going on. Its words show through Whisper, as a disabled
 * control's do.
 *
 * Like every control on the canvas, it is given `onPress` only while its
 * pane is in use, and only when a tap does something. `ref` is the circle,
 * for a screen that moves a screen reader to it. Its bloom is slate on a
 * test network.
 */
export function CircleControl({
  accessibilityLabel,
  accessibilityHint,
  onPress,
  busy = false,
  stale = false,
  tone = 'bloom',
  children,
  ref,
}: {
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress?: () => void;
  busy?: boolean;
  stale?: boolean;
  tone?: Tone;
  children?: ReactNode;
  ref?: Ref<ComponentRef<typeof View>>;
}) {
  const live = usePaneActive() && !busy;
  const { reduced } = useMotionPrefs();
  const bloom = useBloom();
  const ring = tone === 'honey' ? palette.honey : bloom.tone;
  const fill = tone === 'honey' ? palette.honeySoft : bloom.soft;
  const refusal = useShake();
  const scale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  const to = (value: number) => {
    if (!reduced) scale.set(withSpring(value, springs.snap));
  };
  const dust = !onPress || stale;
  const press = onPress
    ? () => {
        if (stale) {
          haptics.warning();
          refusal.play();
        } else {
          haptics.tap();
        }
        onPress();
      }
    : null;
  const control = (
    <Reanimated.View style={[refusal.style, pressStyle]}>
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: dust, busy }}
        onPressIn={live && press ? () => to(0.94) : undefined}
        onPressOut={live && press ? () => to(1) : undefined}
        onPress={live && press ? press : undefined}
        style={[
          styles.circle,
          {
            backgroundColor: dust ? palette.mocha : fill,
            borderColor: dust ? palette.husk : ring,
          },
        ]}
      >
        <Reanimated.View
          pointerEvents="none"
          style={[styles.tint, refusal.tint]}
        />
        {children ?? (
          <Glyph
            name="send"
            size={32}
            color={dust ? palette.dust : palette.cream}
          />
        )}
        {busy ? (
          <View style={styles.orbit}>
            <Orbit size={CONTROL} stroke={RING} color={ring} />
          </View>
        ) : null}
      </Pressable>
    </Reanimated.View>
  );
  // Dust, it says why when held: the stale balance, the wait, or what it
  // needs first.
  return (
    <Whisper label={accessibilityHint ?? accessibilityLabel} enabled={dust}>
      {control}
    </Whisper>
  );
}

/**
 * A quote that ran out (REDESIGN.md 5, ExpiryRing): the arrow turns away
 * and fades as the refresh glyph draws in, and a tap asks for a new quote
 * for the same payment.
 */
export function QuoteRefresh({
  onPress,
  busy,
  ref,
}: {
  onPress?: () => void;
  busy: boolean;
  ref?: Ref<ComponentRef<typeof View>>;
}) {
  const { reduced } = useMotionPrefs();
  const turned = useSharedValue(0);
  useEffect(() => {
    // Under Reduce Motion the arrow only fades, so the fade plays.
    turned.set(
      withTiming(1, {
        duration: reduced ? durations.crossfade : durations.move,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [reduced, turned]);
  const arrow = useAnimatedStyle(
    () => ({
      opacity: 1 - turned.get(),
      transform: reduced ? [] : [{ rotate: `${-135 * turned.get()}deg` }],
    }),
    [reduced],
  );
  return (
    <CircleControl
      ref={ref}
      accessibilityLabel={copy.send.refreshQuote}
      accessibilityHint={copy.send.quoteExpired}
      onPress={onPress}
      busy={busy}
      tone="honey"
    >
      <Reanimated.View style={[styles.glyph, arrow]}>
        <Glyph name="send" size={32} color={palette.cream} />
      </Reanimated.View>
      <View style={styles.glyph}>
        <DrawnGlyph
          name="refresh"
          size={32}
          color={palette.honey}
          strokes={[{ duration: durations.draw, delay: durations.exit }]}
        />
      </View>
    </CircleControl>
  );
}

const styles = StyleSheet.create({
  circle: {
    width: CONTROL,
    height: CONTROL,
    borderRadius: CONTROL / 2,
    borderWidth: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tint: {
    ...StyleSheet.absoluteFill,
    borderRadius: CONTROL / 2,
    backgroundColor: palette.radishWash,
  },
  glyph: { position: 'absolute' },
  // Absolute children sit inside the border, so the orbit steps out over it.
  orbit: {
    position: 'absolute',
    top: -RING,
    left: -RING,
    width: CONTROL,
    height: CONTROL,
  },
});
