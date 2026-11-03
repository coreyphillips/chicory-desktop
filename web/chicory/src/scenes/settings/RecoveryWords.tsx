import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { useFocus } from '../../motion/focus';
import { riseIn } from '../../motion/presets';
import { curves } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { radius, space, type } from '../../theme';
import { WORD_RISE, wordDelay } from './motion';
import { wholeWords } from './ui';

/** How long the eye stays open before it blinks, once the words are rising. */
const BLINK_AFTER = 240;
/** Half a blink: the lid closing, then opening again. */
const BLINK_HALF = 90;

/**
 * The honey eye beside the line about being watched. It blinks once as the
 * words appear, a glance over the shoulder, and then keeps still.
 */
function BlinkingEye() {
  const { reduced } = useMotionPrefs();
  const lid = useSharedValue(1);
  useEffect(() => {
    if (reduced) return;
    lid.set(
      withDelay(
        BLINK_AFTER,
        withSequence(
          withTiming(0.1, { duration: BLINK_HALF, easing: curves.standard }),
          withTiming(1, { duration: BLINK_HALF, easing: curves.standard }),
        ),
      ),
    );
    return () => cancelAnimation(lid);
  }, [reduced, lid]);
  const blinking = useAnimatedStyle(() => ({
    transform: [{ scaleY: lid.get() }],
  }));
  return (
    <Reanimated.View style={blinking}>
      <Glyph name="eye" size={18} color={palette.honey} />
    </Reanimated.View>
  );
}

/**
 * The phrase itself, once revealed: a honey line about who can see the
 * screen, then the words in two columns, numbered, rising one after another
 * in reading order (REDESIGN.md 6, Backup and setup). Each word is one
 * element for a screen reader, its number and the word together, and the
 * first takes its focus, since the control that revealed them is gone.
 *
 * A word is never broken across lines: one wider than its cell at a large
 * text size shrinks a little instead (`wholeWords`), since "mushroo" over
 * "m" could be written down as two words.
 */
export function RecoveryWords({ words }: { words: string[] }) {
  const first = useFocus(true);
  return (
    <View style={styles.stack}>
      <View style={styles.watchers}>
        <BlinkingEye />
        <Text style={styles.watchersText}>
          {copy.settings.recovery.watchers}
        </Text>
      </View>
      <View style={styles.grid}>
        {words.map((word, index) => (
          <Reanimated.View
            key={index}
            entering={riseIn(WORD_RISE, wordDelay(index))}
            style={styles.cell}
          >
            <View
              ref={index === 0 ? first : undefined}
              accessible
              accessibilityLabel={copy.settings.recovery.word(index + 1, word)}
              style={styles.word}
            >
              <Text style={styles.number}>{index + 1}</Text>
              <Text {...wholeWords(word)} style={styles.text}>
                {word}
              </Text>
            </View>
          </Reanimated.View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  watchers: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: palette.honeySoft,
  },
  watchersText: { fontSize: 14, lineHeight: 20, color: palette.cream, flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // Two to a line while a word fits in half of it; a word that needs more,
  // at a large text size, takes a line of its own, and the order still
  // reads left to right, top to bottom.
  cell: { flexGrow: 1, flexBasis: 'auto', minWidth: '48.5%' },
  word: {
    minHeight: 44,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    backgroundColor: palette.mocha,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  number: {
    ...type.micro,
    letterSpacing: 0,
    color: palette.steam,
    minWidth: 18,
    fontVariant: ['tabular-nums'],
  },
  text: { ...type.word, color: palette.cream, flexShrink: 1 },
});
