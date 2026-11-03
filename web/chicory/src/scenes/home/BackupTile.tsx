import React, { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { useAmbientRest } from '../../motion/ambient';
import { riseIn, sceneOut } from '../../motion/presets';
import { curves, durations } from '../../motion/tokens';
import { HIT_SLOP, radius, space } from '../../theme';

/**
 * A recovery phrase still to save, as the honey shield tile beside the mark
 * (REDESIGN.md 6, Backup and setup). It cannot be dismissed: it goes when the
 * phrase is saved, and a tap opens Settings, where the phrase is revealed.
 * Over a shell phase, which has no Settings, it opens the phrase's own setup
 * surface instead, and `hint` says so. The shield's stroke blinks every
 * 1600ms while `running`, and holds whole while decoration rests
 * (REDESIGN.md 3.5): the tile says the phrase is still to save without it.
 */
export function BackupTile({
  running,
  onOpen,
  hint = copy.home.backupHint,
}: {
  running: boolean;
  /** Opens where the phrase is revealed; absent while out of use. */
  onOpen?: () => void;
  hint?: string;
}) {
  const blink = useSharedValue(1);
  const resting = useAmbientRest();
  const blinking = running && !resting;
  useEffect(() => {
    if (!blinking) {
      blink.set(withTiming(1, { duration: durations.tick }));
      return;
    }
    blink.set(
      withRepeat(
        withTiming(0.35, {
          duration: durations.halo / 2,
          easing: curves.sine,
        }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(blink);
  }, [blinking, blink]);
  const shield = useAnimatedStyle(() => ({ opacity: blink.get() }));
  return (
    <Reanimated.View entering={riseIn()} exiting={sceneOut()}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.health.backupPending}
        accessibilityHint={hint}
        hitSlop={HIT_SLOP}
        onPress={
          onOpen
            ? () => {
                haptics.tick();
                onOpen();
              }
            : undefined
        }
        style={styles.target}
      >
        <View style={styles.tile}>
          <Reanimated.View style={shield}>
            <Glyph name="shieldAlert" size={18} color={palette.honey} />
          </Reanimated.View>
          <Glyph name="key" size={16} color={palette.honey} />
        </View>
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  // The pill is drawn 36pt tall inside a target of the least a control gets
  // (REDESIGN.md 3.4).
  target: { minHeight: 48, justifyContent: 'center' },
  tile: {
    minWidth: 56,
    height: 36,
    paddingHorizontal: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    borderRadius: radius.round,
    backgroundColor: palette.honeySoft,
  },
});
