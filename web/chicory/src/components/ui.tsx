import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  ViewStyle,
} from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { colors, HIT_SLOP, MIN_TARGET, radius, space, type } from '../theme';
import { Glyph } from '../design/glyphs';
import type { GlyphName } from '../design/glyphs';
import { springs } from '../motion/tokens';
import { haptic } from '../services/haptics';
import { motionReduced } from '../services/motion';

/** Names from the classic icon set, drawn now by their redesign glyphs. */
const RENAMED = {
  arrowUp: 'send',
  arrowDown: 'receive',
  link: 'chain',
  settings: 'cog',
  activity: 'orbit',
} as const satisfies Record<string, GlyphName>;

export type IconName = GlyphName | keyof typeof RENAMED;

const glyphFor = (name: IconName): GlyphName =>
  name in RENAMED ? RENAMED[name as keyof typeof RENAMED] : (name as GlyphName);

/**
 * The classic icon API over the redesign's glyphs, so every screen not yet
 * redrawn keeps its call sites. The stroke follows the glyph's size unless one
 * is given.
 */
export function Icon({
  name,
  size = 24,
  color = colors.text,
  strokeWidth,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Glyph
      name={glyphFor(name)}
      size={size}
      color={color}
      strokeWidth={strokeWidth}
    />
  );
}

/**
 * A press that dips slightly and springs back, instead of a hard opacity step.
 * Reduce Motion keeps the control still.
 */
function usePressScale() {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.get() }],
  }));
  const to = (value: number) =>
    scale.set(motionReduced() ? 1 : withSpring(value, springs.snap));
  return {
    style,
    onPressIn: () => to(0.97),
    onPressOut: () => to(1),
  };
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * A control without an `onPress` keeps its look but takes no touches, which
 * is how a control on a canvas pane that is not in use is drawn (REDESIGN.md
 * 2.4): its handlers are only passed while the pane is.
 */
export function Button({
  label,
  onPress,
  disabled,
  busy,
  secondary,
  variant,
  icon,
  iconRight,
  accessibilityLabel,
  accessibilityHint,
  haptics = 'medium',
  style,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** Retained shorthand for `variant="secondary"`. */
  secondary?: boolean;
  variant?: ButtonVariant;
  icon?: IconName;
  iconRight?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  haptics?: 'selection' | 'light' | 'medium' | 'success' | false;
  style?: StyleProp<ViewStyle>;
}) {
  const kind: ButtonVariant = variant ?? (secondary ? 'secondary' : 'primary');
  const press = usePressScale();
  const inactive = disabled || busy;
  const ink =
    kind === 'primary'
      ? colors.ink
      : kind === 'danger'
      ? colors.danger
      : colors.text;
  const glyph = (
    <>
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : icon ? (
        <Icon name={icon} color={ink} size={20} />
      ) : null}
    </>
  );
  return (
    <Reanimated.View style={[press.style, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel || label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!inactive, busy: !!busy }}
        disabled={inactive}
        onPressIn={onPress && press.onPressIn}
        onPressOut={onPress && press.onPressOut}
        onPress={
          onPress &&
          (() => {
            if (haptics) haptic(haptics);
            onPress();
          })
        }
        style={[
          styles.button,
          kind === 'secondary' && styles.secondaryButton,
          kind === 'ghost' && styles.ghostButton,
          kind === 'danger' && styles.dangerButton,
          inactive && styles.disabled,
        ]}
      >
        {iconRight ? null : glyph}
        <Text
          style={[
            styles.buttonLabel,
            kind !== 'primary' && styles.secondaryLabel,
            kind === 'danger' && styles.dangerLabel,
          ]}
        >
          {label}
        </Text>
        {iconRight ? glyph : null}
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * A square, icon-only control. Always carries its own label for screen
 * readers. Like `Button`, it takes no touches without an `onPress`.
 */
export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  size = 20,
  tone = 'default',
  disabled,
}: {
  name: IconName;
  onPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  size?: number;
  tone?: 'default' | 'primary' | 'plain';
  disabled?: boolean;
}) {
  const press = usePressScale();
  return (
    <Reanimated.View style={press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: !!disabled }}
        disabled={disabled}
        hitSlop={HIT_SLOP}
        onPressIn={onPress && press.onPressIn}
        onPressOut={onPress && press.onPressOut}
        onPress={
          onPress &&
          (() => {
            haptic('selection');
            onPress();
          })
        }
        style={[
          styles.iconButton,
          tone === 'plain' && styles.iconButtonPlain,
          disabled && styles.disabled,
        ]}
      >
        <Icon
          name={name}
          size={size}
          color={tone === 'primary' ? colors.primary : colors.text}
        />
      </Pressable>
    </Reanimated.View>
  );
}

export function LinkButton({
  label,
  onPress,
  disabled = false,
  tone = 'primary',
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'muted';
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      disabled={disabled}
      accessibilityState={{ disabled }}
      hitSlop={HIT_SLOP}
      style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
    >
      <Text
        style={[
          styles.linkText,
          tone === 'muted' && styles.linkTextMuted,
          disabled && styles.disabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * An option pill. Like `Button`, a chip takes no touches without an `onPress`.
 * Its label grows with Dynamic Type without a cap unless
 * `maxFontSizeMultiplier` sets one, as an amount's presets do (REDESIGN.md
 * 3.3); Settings' chips leave it uncapped.
 */
/** A chip's least height as drawn, which its hitSlop brings to MIN_TARGET. */
export const CHIP_HEIGHT = 38;
const CHIP_REACH = (MIN_TARGET - CHIP_HEIGHT) / 2;
/**
 * A chip reaches up and down to MIN_TARGET. It needs nothing across, where
 * it is at least MIN_TARGET wide, and where its neighbours sit a gap away.
 */
export const CHIP_SLOP = {
  top: CHIP_REACH,
  bottom: CHIP_REACH,
  left: 0,
  right: 0,
};

export function Chip({
  label,
  selected,
  onPress,
  disabled,
  maxFontSizeMultiplier,
}: {
  label: string;
  selected: boolean;
  onPress?: () => void;
  disabled?: boolean;
  maxFontSizeMultiplier?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={CHIP_SLOP}
      onPress={
        onPress &&
        (() => {
          haptic('selection');
          onPress();
        })
      }
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text
        style={[styles.chipText, selected && styles.chipTextSelected]}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.xs + 2,
  },
  secondaryButton: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.line,
  },
  ghostButton: { backgroundColor: 'transparent' },
  dangerButton: {
    backgroundColor: colors.dangerSoft,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  buttonLabel: {
    ...type.label,
    fontSize: 16,
    color: colors.ink,
    fontWeight: '700',
  },
  secondaryLabel: { color: colors.text },
  dangerLabel: { color: colors.danger },
  disabled: { opacity: 0.45 },

  iconButton: {
    width: MIN_TARGET,
    height: MIN_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.raised,
  },
  iconButtonPlain: { backgroundColor: 'transparent' },

  link: { paddingVertical: space.sm, alignItems: 'center' },
  linkPressed: { opacity: 0.6 },
  linkText: { ...type.label, color: colors.primary },
  linkTextMuted: { color: colors.muted },

  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    minHeight: CHIP_HEIGHT,
    minWidth: MIN_TARGET,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.cream, borderColor: colors.cream },
  chipText: { ...type.caption, color: colors.muted },
  chipTextSelected: { color: colors.ink, fontWeight: '700' },
});
