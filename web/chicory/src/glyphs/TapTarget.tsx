import React, { useMemo } from 'react';
import type { PropsWithChildren } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type {
  AccessibilityActionEvent,
  AccessibilityState,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { GestureDetector, useTapGesture } from 'react-native-gesture-handler';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { springs } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { useBrowserTap } from '../../../platform/keyboardTap';

const ACTIONS = [{ name: 'activate' }];

/** How far the target dips under the finger. */
const DIP = 0.94;

/**
 * A press is a press however long the finger stays, as on a Pressable; only
 * a finger that wanders off the control lets it go.
 */
const HOLD_MS = 60_000;
const STRAY = 24;

/**
 * A control that answers a tap on the UI thread. A Pressable's feedback, and
 * whatever its press starts, wait for the JavaScript thread, which the
 * wallet engine shares and can hold for a second or more while the wallet
 * opens, so a tap then looks ignored. Here the tap is recognised natively:
 * the target dips under the finger, and `onPressUi`, a worklet, starts what
 * the press leads to, both within a frame. `onPress` follows on the
 * JavaScript thread whenever it is free. Under Reduce Motion it does not
 * dip. A screen reader activates it as it would a Pressable, and without an
 * `onPress`, or while `disabled`, it takes no touches. Its content is
 * centred in it, as a glyph's is in its target.
 */
export function TapTarget({
  onPress,
  onPressUi,
  disabled = false,
  accessibilityLabel,
  accessibilityState,
  style,
  children,
}: PropsWithChildren<{
  onPress?: () => void;
  /** A worklet, run on the UI thread as the tap lands, before `onPress`. */
  onPressUi?: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
}>) {
  const { reduced } = useMotionPrefs();
  const press = useSharedValue(1);
  const live = !!onPress && !disabled;
  const browserTap = useBrowserTap({
    enabled: Platform.OS === 'web' && live,
    begin: () => { if (!reduced) press.set(withSpring(DIP, springs.snap)); },
    cancel: () => { if (!reduced) press.set(withSpring(1, springs.snap)); },
    activate: () => { if (live) { onPressUi?.(); onPress?.(); } },
  });
  const gesture = useTapGesture(
    useMemo(
      () => ({
        enabled: live,
        maxDuration: HOLD_MS,
        maxDistance: STRAY,
        // A finger that drifts just past the target's edge still presses,
        // as on a Pressable; STRAY alone lets it go.
        shouldCancelWhenOutside: false,
        onBegin: () => {
          'worklet';
          if (!reduced) press.set(withSpring(DIP, springs.snap));
        },
        onActivate: () => {
          'worklet';
          // Nothing starts that the JavaScript thread will not hear of.
          if (!onPress) return;
          onPressUi?.();
          scheduleOnRN(onPress);
        },
        onFinalize: () => {
          'worklet';
          if (!reduced) press.set(withSpring(1, springs.snap));
        },
      }),
      [live, reduced, press, onPress, onPressUi],
    ),
  );
  const dip = useAnimatedStyle(() => ({
    transform: [{ scale: press.get() }],
  }));
  // The target itself is the accessible element, drawn with `style`; the
  // gesture is recognised on a view that fills it, its content centred.
  return (
    <Reanimated.View
      {...(Platform.OS === 'web' ? browserTap : {})}
      accessible
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, ...accessibilityState }}
      accessibilityActions={ACTIONS}
      onAccessibilityAction={
        live
          ? (event: AccessibilityActionEvent) => {
              if (event.nativeEvent.actionName === 'activate') onPress!();
            }
          : undefined
      }
      onAccessibilityTap={live ? onPress : undefined}
      style={[style, dip]}
    >
      <GestureDetector gesture={gesture}>
        <View collapsable={false} style={styles.fill}>
          {children}
        </View>
      </GestureDetector>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
