import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Reanimated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { announce } from '../design/announce';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import type { GlyphName } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { smooth } from '../motion/presets';
import { curves } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { DrawnGlyph } from '../scenes/receive/draw';
import { usePaneActive } from '../stage/panes/Pane';
import { space, type as typography } from '../theme';
import { chipText } from './chipText';

export { chipLead, chipText } from './chipText';

/**
 * A reference, request or address as a chip that copies it (REDESIGN.md 5,
 * CopyChip). The value shows in mono, in groups of four, shortened in the
 * middle; a long press shows all of it. A tap copies it: the copy glyph
 * shrinks away as a sage check draws in and a cream wash sweeps across, and
 * a screen reader hears "{label} copied". That is all the confirmation there
 * is: no toast.
 *
 * `label` names the value, as in "Transaction", and `glyph` swaps the copy
 * glyph for one that says what the value is, or with null leaves it out. A
 * chip that is not `copyable` only shows its value, in steam, as the record
 * of something that must not be paid again, such as a request that expired;
 * a long press still shows all of it, and a screen reader hears the label
 * and the value.
 */
export interface CopyChipProps {
  label: string;
  value: string;
  glyph?: GlyphName | null;
  copyable?: boolean;
}

/** The copied look, in ms: the wash comes in, holds, and goes. */
export const COPIED = {
  glyphOut: 120,
  checkDelay: 60,
  checkDraw: 260,
  washIn: 180,
  hold: 700,
  washOut: 600,
};

const GLYPH = 16;

/** How long the check stays before the glyph comes back. */
const SETTLE = COPIED.washIn + COPIED.hold;

/**
 * A glyph that turns into a sage check each time `copies` counts up, and
 * back once the copy has been seen (REDESIGN.md 4, copy to check): it
 * shrinks to .6 and fades as the check draws in. Under Reduce Motion the two
 * only crossfade, the check whole and the glyph at its size (REDESIGN.md 8).
 * The chip draws it, and so does a control that copies.
 */
export function CopiedGlyph({
  name,
  size,
  color,
  copies,
}: {
  name: GlyphName;
  size: number;
  color: string;
  copies: number;
}) {
  const { reduced } = useMotionPrefs();
  // 0 is the glyph at rest; 1 is the check that replaced it.
  const swap = useSharedValue(0);
  const check = useSharedValue(0);
  // Under Reduce Motion the check is drawn whole and only fades.
  const whole = useSharedValue(1);
  // Only a new copy plays. A control that mounts with copies behind it, as
  // on a fresh request, starts at rest, and so does one whose motion setting
  // changed mid-way.
  const seen = useRef(copies);
  useEffect(() => {
    if (copies === seen.current) {
      swap.set(0);
      check.set(0);
      return;
    }
    seen.current = copies;
    const stop = () => {
      cancelAnimation(swap);
      cancelAnimation(check);
    };
    if (reduced) {
      // A crossfade moves nothing, so it opts out of the system setting,
      // which would otherwise skip it and leave no sign of the copy.
      const fade = {
        duration: COPIED.glyphOut,
        reduceMotion: ReduceMotion.Never,
      };
      const flip = () =>
        withSequence(
          withTiming(1, fade),
          withDelay(SETTLE, withTiming(0, fade), ReduceMotion.Never),
        );
      swap.set(flip());
      check.set(flip());
      return stop;
    }
    const back = { duration: COPIED.washOut, easing: curves.standard };
    swap.set(
      withSequence(
        withTiming(1, { duration: COPIED.glyphOut, easing: curves.exit }),
        withDelay(SETTLE, withTiming(0, back)),
      ),
    );
    check.set(
      withSequence(
        withDelay(
          COPIED.checkDelay,
          withTiming(1, { duration: COPIED.checkDraw, easing: curves.enter }),
        ),
        withDelay(SETTLE - COPIED.checkDraw, withTiming(0, back)),
      ),
    );
    return stop;
  }, [copies, reduced, swap, check]);
  const glyphStyle = useAnimatedStyle(() => ({
    opacity: 1 - swap.get(),
    transform: [{ scale: reduced ? 1 : 1 - 0.4 * swap.get() }],
  }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: reduced ? check.get() : 1,
  }));
  const box = { width: size, height: size };
  return (
    <View style={box}>
      <Reanimated.View style={glyphStyle}>
        <Glyph name={name} size={size} color={color} />
      </Reanimated.View>
      <Reanimated.View style={[styles.check, checkStyle]}>
        <DrawnGlyph
          name="check"
          size={size}
          color={palette.sage}
          progress={reduced ? whole : check}
        />
      </Reanimated.View>
    </View>
  );
}

export function CopyChip({
  label,
  value,
  glyph = 'copy',
  copyable = true,
}: CopyChipProps) {
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  const [expanded, setExpanded] = useState(false);
  const [copies, setCopies] = useState(0);

  // A cream wash sweeps across as the glyph turns to a check. Under Reduce
  // Motion the glyph's crossfade is all there is.
  const wash = useSharedValue(0);
  const sweep = useSharedValue(0);
  useEffect(() => {
    if (!copies || reduced) {
      wash.set(0);
      return;
    }
    const back = { duration: COPIED.washOut, easing: curves.standard };
    sweep.set(0);
    sweep.set(withTiming(1, { duration: COPIED.washIn, easing: curves.enter }));
    wash.set(
      withSequence(
        withTiming(1, { duration: COPIED.washIn, easing: curves.enter }),
        withDelay(COPIED.hold, withTiming(0, back)),
      ),
    );
    return () => {
      cancelAnimation(wash);
      cancelAnimation(sweep);
    };
  }, [copies, reduced, wash, sweep]);

  const washStyle = useAnimatedStyle(() => ({
    opacity: wash.get(),
    transform: [{ scaleX: sweep.get() }],
  }));

  return (
    <Reanimated.View layout={smooth()} style={styles.hug}>
      <Pressable
        accessibilityRole={copyable ? 'button' : 'text'}
        accessibilityLabel={copyable ? copy.receive.copyValue(label) : label}
        accessibilityValue={{ text: value }}
        onPress={
          live && copyable
            ? () => {
                haptics.tick();
                Clipboard.setString(value);
                announce(copy.receive.valueCopied(label));
                setCopies(count => count + 1);
              }
            : undefined
        }
        onLongPress={live ? () => setExpanded(open => !open) : undefined}
        style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      >
        <Reanimated.View
          pointerEvents="none"
          style={[styles.wash, washStyle]}
        />
        <Text
          style={[styles.value, !copyable && styles.kept]}
          numberOfLines={expanded ? undefined : 1}
          maxFontSizeMultiplier={1.4}
        >
          {chipText(value, expanded)}
        </Text>
        {glyph ? (
          <CopiedGlyph
            name={glyph}
            size={GLYPH}
            color={copyable ? palette.steam : palette.dust}
            copies={copies}
          />
        ) : null}
      </Pressable>
    </Reanimated.View>
  );
}

/** A chip is at least a finger tall, and a pill at that height. */
const CHIP = 48;

const styles = StyleSheet.create({
  // A pill round its value and glyph, however wide its row.
  hug: { alignSelf: 'center', maxWidth: '100%' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: CHIP,
    paddingHorizontal: space.md,
    borderRadius: CHIP / 2,
    backgroundColor: palette.mocha,
    overflow: 'hidden',
  },
  pressed: { backgroundColor: palette.cocoa },
  wash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.creamSoft,
    transformOrigin: 'left',
  },
  value: { ...typography.mono, flexShrink: 1, color: palette.cream },
  kept: { color: palette.steam },
  check: { ...StyleSheet.absoluteFill },
});
