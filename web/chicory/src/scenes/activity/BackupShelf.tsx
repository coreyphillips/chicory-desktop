import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { useLoop, wave } from '../../motion/loops';
import { riseIn, sceneOut } from '../../motion/presets';
import { durations } from '../../motion/tokens';
import { usePaneActive } from '../../stage/panes/Pane';
import { radius, space } from '../../theme';
import { ROW_BAND, ROW_GAP, ROW_HEIGHT, ROW_RING } from './model';

/** How wide the list lets its rows grow, as the list lays them out. */
const LIST_WIDTH = 640 - space.xl * 2;

/** How far the shield fades at the dim end of each blink. */
const BLINK = 0.65;

/**
 * A recovery phrase still to save, pinned first in the attention shelf of
 * the open list (REDESIGN.md 6, Activity and Backup and setup): the honey
 * band the payments that need attention sit on, with a shield where a row
 * has its ring and the key where a row has its rail. It cannot be dismissed:
 * it goes when the phrase is saved, and a tap opens Settings, which leads
 * with the recovery phrase. The phrase itself, and every word about it, stay
 * there.
 *
 * The shield's stroke blinks every 1600ms while anyone would see it, and
 * holds whole while decoration rests (REDESIGN.md 3.5).
 */
export function BackupShelf({ onOpen }: { onOpen: () => void }) {
  const live = usePaneActive();
  const clock = useLoop(durations.halo, true, true);
  const blink = useAnimatedStyle(() => ({
    opacity: 1 - BLINK * wave(clock.get()),
  }));
  return (
    <Reanimated.View
      entering={riseIn()}
      exiting={sceneOut()}
      style={styles.place}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.health.backupPending}
        accessibilityHint={copy.home.backupHint}
        onPress={
          live
            ? () => {
                haptics.tick();
                onOpen();
              }
            : undefined
        }
        style={({ pressed }) => [styles.band, pressed && styles.pressed]}
      >
        <View style={styles.ring}>
          <Reanimated.View style={blink}>
            <Glyph name="shieldAlert" size={20} color={palette.honey} />
          </Reanimated.View>
        </View>
        <View style={styles.middle} />
        <Glyph name="key" size={14} color={palette.honey} />
      </Pressable>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  place: { alignSelf: 'center', width: '100%', maxWidth: LIST_WIDTH },
  // The band runs a little wider than the rows, as the pinned rows' does, so
  // the shield lines up with their rings.
  band: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
    marginHorizontal: -ROW_BAND,
    paddingHorizontal: ROW_BAND,
    borderRadius: radius.md,
    backgroundColor: palette.honeyWash,
  },
  pressed: { backgroundColor: palette.honeySoft },
  ring: {
    width: ROW_RING,
    height: ROW_RING,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.honeySoft,
  },
  middle: { flex: 1 },
});
