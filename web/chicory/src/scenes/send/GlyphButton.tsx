import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import { HIT_SLOP } from '../../theme';

/**
 * A round control that is only a glyph, such as paste, scan or edit. Its
 * words are its label and hint. It dips as it is pressed and ticks as it
 * fires. Like every control on the canvas it is given `onPress` only while
 * its pane is in use, and takes no touches without one.
 *
 * It sits on a mocha disc of its own, unless it is drawn on a ground that
 * already says what it belongs to (`ground` false), as the well's paste and
 * scan are: a disc there would only show when the well changes colour.
 */
export function GlyphButton({
  glyph,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  disabled = false,
  size = 48,
  color = palette.cream,
  ground = true,
}: {
  glyph: GlyphName;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress?: () => void;
  disabled?: boolean;
  size?: number;
  color?: string;
  ground?: boolean;
}) {
  const live = usePaneActive() && !disabled && !!onPress;
  const { reduced } = useMotionPrefs();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  const to = (value: number) => {
    if (!reduced) scale.set(withSpring(value, springs.snap));
  };
  return (
    <Reanimated.View style={style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={HIT_SLOP}
        onPressIn={live ? () => to(0.92) : undefined}
        onPressOut={live ? () => to(1) : undefined}
        onPress={
          live && onPress
            ? () => {
                haptics.tick();
                onPress();
              }
            : undefined
        }
        style={[
          styles.button,
          { width: size, height: size, borderRadius: size / 2 },
          !ground && styles.bare,
          disabled && styles.disabled,
        ]}
      >
        <Glyph name={glyph} size={Math.round(size * 0.46)} color={color} />
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.mocha,
  },
  bare: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.45 },
});
