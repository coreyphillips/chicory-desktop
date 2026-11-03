import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { Whisper } from '../../glyphs/Whisper';
import { riseIn, sceneOut } from '../../motion/presets';
import { number, space, type as typography } from '../../theme';
import { TARGET } from './controls';
import { Pulse } from './loops';
import type { AmountCue as Cue } from './model';
import { useBloom } from './tone';

/**
 * What the amount means, as a glyph over it (REDESIGN.md 6, Receive): a
 * sprout while an amount is still needed for a channel made just in time,
 * gone once one is entered, and the
 * moon and the cap an offline receive can take, radish past it and dust
 * below the floor. The amount itself shows the rest: an infinity while the
 * sender may choose, a dust 0 and a caret while one is needed, and the
 * shake when it is refused (`AmountFace`).
 *
 * It draws only glyphs and the cap, which is data; the words are its label.
 */
export function AmountCue({
  cue,
  cap,
  message,
}: {
  cue: Cue;
  cap?: number;
  /** What the engine said when it asked for an amount. */
  message?: string;
}) {
  const { bloom } = useBloom();
  let label: string | undefined;
  let hint: string | undefined;
  let face: React.ReactNode = null;
  if (cue.kind === 'offline') {
    const tone = cue.over
      ? palette.radish
      : cue.under
      ? palette.dust
      : palette.steam;
    label =
      cue.over && cap !== undefined
        ? copy.receive.offlineOver(cap)
        : copy.receive.offlineRange(cap);
    face = (
      <>
        <Glyph name="moon" size={18} color={bloom} />
        {cap !== undefined ? (
          <>
            <Text
              style={[styles.cap, { color: tone }]}
              maxFontSizeMultiplier={1.4}
            >
              ≤
            </Text>
            <Text
              style={[styles.cap, { color: tone }]}
              maxFontSizeMultiplier={1.4}
            >
              {number(cap)}
            </Text>
          </>
        ) : null}
      </>
    );
  } else if (cue.kind === 'required' && cue.empty) {
    // Only while the amount is empty: once one is entered, it is not
    // required any more (P10, 19-receive-refusal-pip).
    label = copy.amount.required;
    hint = copy.receive.enterAmount;
    face = <Glyph name="sprout" size={20} color={bloom} />;
  }
  return (
    <View style={styles.strip}>
      {face ? (
        <Whisper label={[label, message ?? hint].filter(Boolean).join(' ')}>
          <Reanimated.View
            key={cue.kind}
            entering={riseIn(8)}
            exiting={sceneOut()}
            accessible
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityValue={message ? { text: message } : undefined}
            style={styles.face}
          >
            {face}
          </Reanimated.View>
        </Whisper>
      ) : null}
    </View>
  );
}

/**
 * What stands in the amount while it has no digits: an infinity where the
 * sender may choose, and otherwise the dust 0 with a caret blinking after
 * it, since an amount is needed.
 */
export function AmountFace({ cue }: { cue: Cue }) {
  const { bloom } = useBloom();
  if (cue.kind === 'any') {
    return <Glyph name="infinity" size={40} color={bloom} />;
  }
  return (
    <>
      <Text style={styles.zero} maxFontSizeMultiplier={1.2}>
        0
      </Text>
      <Pulse period={1000} low={0}>
        <View style={[styles.caret, { backgroundColor: bloom }]} />
      </Pulse>
    </>
  );
}

const styles = StyleSheet.create({
  // As tall as the pencil and the switch beside it, and a place a finger
  // can hold to hear the cue whispered (REDESIGN.md 3.4).
  strip: { height: TARGET, alignItems: 'center', justifyContent: 'center' },
  face: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    minWidth: TARGET,
    minHeight: TARGET,
  },
  zero: { ...typography.amount, color: palette.dust },
  caret: {
    width: 2,
    height: 36,
    marginLeft: 2,
    borderRadius: 1,
  },
  cap: typography.meta,
});
