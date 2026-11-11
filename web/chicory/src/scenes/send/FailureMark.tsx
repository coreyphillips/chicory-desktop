import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import type { GlyphName } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { WhisperAlert } from '../../glyphs/Whisper';
import { useShake } from '../../motion/effects';
import { durations } from '../../motion/tokens';
import { BANG, DrawnGlyph } from './DrawnGlyph';
import { ClosingChain, FlashingBolt } from './ErrorGlyphs';
import type { Stroke } from './DrawnGlyph';
import { failureExplanation } from './model';
import type { Failure } from './model';
import { Unplugged, WaitingClock } from './LoopingGlyphs';

/**
 * How each glyph an error shows draws in (REDESIGN.md 4, Animated glyphs):
 * the cross in two quick strokes, the bang's line and then its dot, and
 * anything else at the drawing pace. The bolt draws quickly and then
 * flashes, and the chain's halves slide together instead of drawing. A
 * clock and an unplug are never drawn: they mark something that lasts, so
 * they keep moving.
 */
const STROKES: Partial<Record<GlyphName, Stroke[]>> = {
  cross: [{ duration: 140 }, { duration: 140, delay: 60 }],
  bang: BANG,
};
const DRAW: Stroke[] = [{ duration: durations.draw }];

/**
 * What the engine said no with (REDESIGN.md 6, Engine errors): its glyphs,
 * drawn in, in honey or radish, and a shake when it is radish. Tap or
 * hold to read the same explanation that labels the mark for a screen reader.
 */
export function FailureMark({ failure }: { failure: Failure }) {
  const color = failure.tone === 'honey' ? palette.honey : palette.radish;
  const refusal = useShake();
  const { play } = refusal;
  useEffect(() => {
    if (failure.shake) play();
  }, [failure, play]);
  return (
    <WhisperAlert
      label={failureExplanation(failure)}
      revision={failure}
      style={styles.target}
    >
      <Reanimated.View style={[styles.mark, refusal.style]}>
        <Reanimated.View
          pointerEvents="none"
          style={[styles.tint, refusal.tint]}
        />
        <View style={styles.glyphs}>
          {failure.glyphs.map(glyph =>
            glyph === 'clock' ? (
              <WaitingClock key={glyph} size={22} color={color} />
            ) : glyph === 'unplug' ? (
              <Unplugged key={glyph} size={22} color={color} />
            ) : glyph === 'bolt' ? (
              <FlashingBolt key={glyph} size={22} color={color} />
            ) : glyph === 'chain' ? (
              <ClosingChain key={glyph} size={22} color={color} />
            ) : (
              <DrawnGlyph
                key={glyph}
                name={glyph}
                size={22}
                color={color}
                strokes={STROKES[glyph] ?? DRAW}
              />
            ),
          )}
        </View>
      </Reanimated.View>
    </WhisperAlert>
  );
}

const styles = StyleSheet.create({
  // The least a finger needs to hold it for its words (REDESIGN.md 3.4).
  target: {
    minWidth: 48,
    minHeight: 48,
  },
  mark: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tint: {
    ...StyleSheet.absoluteFill,
    borderRadius: 24,
    backgroundColor: palette.radishWash,
  },
  glyphs: { flexDirection: 'row', gap: 2 },
});
