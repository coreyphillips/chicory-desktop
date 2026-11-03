import React from 'react';
import { Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import Reanimated, {
  ReduceMotion,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { QrBloom } from '../../glyphs/QrBloom';
import { useFocus } from '../../motion/focus';
import { curves, durations, springs } from '../../motion/tokens';
import { motionReduced } from '../../services/motion';
import { usePaneActive } from '../../stage/panes/Pane';
import { SLOT_PADDING } from '../../stage/panes/SceneSlot';
import { space } from '../../theme';
import { RING_GAP } from './RequestStep';

/**
 * How far the scene slot's padding sits inside the slot, so the scrim can
 * reach past it to the slot's edges. Below, the scene also keeps clear of
 * the system bar, which the scrim covers too.
 */
const BLEED = {
  top: -SLOT_PADDING.top,
  left: -SLOT_PADDING.side,
  right: -SLOT_PADDING.side,
  bottom: -SLOT_PADDING.bottom,
};

/** The scrim, in and out on the standard curve. */
function fade(to: 0 | 1): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const config = {
      duration: to ? durations.enter : durations.exit,
      easing: to ? curves.enter : curves.exit,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: { opacity: 1 - to },
      animations: { opacity: withTiming(to, config) },
    };
  };
}

/**
 * The card grows out of the frame it was tapped in, from its top edge, and
 * goes back into it: `from` is the small card's width over the large one's.
 * Under Reduce Motion it only fades.
 */
function grow(from: number, out: boolean): EntryExitAnimationFunction {
  if (motionReduced()) return fade(out ? 0 : 1);
  const [start, end] = out ? [1, from] : [from, 1];
  return () => {
    'worklet';
    return {
      initialValues: { transform: [{ scale: start }] },
      animations: { transform: [{ scale: withSpring(end, springs.pane) }] },
    };
  };
}

/**
 * A request's code lifted to the full width of the screen over the scrim,
 * so it scans from across a table (REDESIGN.md 5, QrBloom: enlarge). A tap
 * anywhere, Android back or the escape gesture sets it down again.
 *
 * It holds a screen reader while it is up, as the modal it replaced did
 * (REDESIGN.md 9): iOS takes it as a modal view, the screen hides the step
 * it covers, and focus lands on the way to set it down.
 */
export function LiftedQr({
  value,
  from,
  onClose,
}: {
  value: string;
  /** The width of the card it was lifted from. */
  from: number;
  onClose: () => void;
}) {
  const live = usePaneActive();
  const { width } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const side = width - space.xs * 2;
  const ratio = Math.min(1, from / side);
  const close = useFocus();
  return (
    <Reanimated.View
      entering={fade(1)}
      exiting={fade(0)}
      accessibilityViewIsModal
      onAccessibilityEscape={live ? onClose : undefined}
      style={[styles.scrim, BLEED, { bottom: BLEED.bottom - bottom }]}
    >
      <Pressable
        ref={close}
        accessibilityRole="button"
        accessibilityLabel={copy.receive.closeQr}
        onPress={live ? onClose : undefined}
        style={StyleSheet.absoluteFill}
      />
      <Reanimated.View
        pointerEvents="none"
        entering={grow(ratio, false)}
        exiting={grow(ratio, true)}
        style={styles.card}
      >
        <QrBloom
          value={value}
          size={side}
          state="shown"
          accessibilityLabel={copy.receive.qr}
        />
      </Reanimated.View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    backgroundColor: palette.scrim,
    alignItems: 'center',
  },
  // Level with the card in the frame, so it grows out of that card's top.
  card: { marginTop: -BLEED.top + RING_GAP, transformOrigin: 'top' },
});
