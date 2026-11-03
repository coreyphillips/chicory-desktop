import React, { useCallback, useRef } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { HostInstance } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { announce } from '../../design/announce';
import { copy } from '../../design/copy';
import { Glyph, strokeFor } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Whisper } from '../../glyphs/Whisper';
import { shake, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { PRIMARY_CONTROL } from '../../stage/layout';
import type { ControlLook } from '../../stage/layout';
import { REFUSED, glyphScale, tintTiming } from './motion';

/** A point in the window, where the scan reveal grows from. */
export type Point = { x: number; y: number };

const PRESSED = 0.92;

/**
 * The control a circle becomes as it opens its scene, and how far it has
 * taken on its look: 0 at home, 1 where it lands (REDESIGN.md 7, T1).
 */
export interface Morph {
  look: ControlLook;
  toward: SharedValue<number>;
}

/**
 * One circle of Home's action row: Send and Receive at 56pt, Scan at 76.
 *
 * A stale balance gates it (REDESIGN.md 6, Wallet health). It turns dust,
 * says it is disabled, and a long press whispers why; the row it sits in
 * shrinks it. It still answers a tap, though not with its action: it shakes,
 * warns, and starts the refresh that will open the gate again. Under Reduce
 * Motion the shake is a radish tint instead.
 *
 * Its props are named apart from the pressable's own, so a suite that finds
 * the control by its label reaches the one that holds the gate.
 *
 * Given `morph`, the circle takes on the look of the control it becomes as
 * it travels to it: that control's fill and ring fade in over its own, and
 * its glyph turns to that control's colour and size, so it lands looking
 * like what it hands over to rather than popping into it.
 */
export function ActionCircle({
  glyph,
  size,
  label,
  hint,
  primary = false,
  test = false,
  stale,
  onAct,
  onRefresh,
  morph,
}: {
  glyph: GlyphName;
  size: 56 | 76;
  label: string;
  hint: string;
  /** The row's main control, filled with bloom. */
  primary?: boolean;
  /** A test network, where slate stands in for bloom. */
  test?: boolean;
  stale: boolean;
  /** The action, given where the circle sits; absent while out of use. */
  onAct?: (origin?: Point) => void;
  /** Starts a refresh, for a tap on a gated circle. */
  onRefresh?: () => void;
  /** The control this circle becomes as it opens its scene. */
  morph?: Morph;
}) {
  const { reduced } = useMotionPrefs();
  const view = useRef<HostInstance>(null);
  const origin = useRef<Point | undefined>(undefined);
  const press = useSharedValue(1);
  const nudge = useSharedValue(0);
  const tint = useSharedValue(0);

  // Where the circle is, in the window. Read when it is laid out and again
  // as a finger lands, so a reveal grows from where the circle is now.
  const measure = useCallback(() => {
    view.current?.measureInWindow((x, y, width, height) => {
      origin.current = { x: x + width / 2, y: y + height / 2 };
    });
  }, []);

  const refuse = useCallback(() => {
    haptics.warning();
    if (reduced) {
      tint.set(
        withSequence(
          withTiming(1, tintTiming(REFUSED.in)),
          withTiming(0, tintTiming(REFUSED.out)),
        ),
      );
    } else {
      nudge.set(shake());
    }
    announce(copy.health.staleAction, { assertive: true });
    onRefresh?.();
  }, [reduced, tint, nudge, onRefresh]);

  const onPress = onAct
    ? () => (stale ? refuse() : onAct(origin.current))
    : undefined;
  const onPressIn = onAct
    ? () => {
        measure();
        if (stale) return;
        haptics.tap();
        press.set(withSpring(PRESSED, springs.snap));
      }
    : undefined;
  const onPressOut = onAct
    ? () => press.set(withSpring(1, springs.snap))
    : undefined;

  const motion = useAnimatedStyle(() => ({
    transform: [{ translateX: nudge.get() }, { scale: press.get() }],
  }));
  const refused = useAnimatedStyle(() => ({ opacity: tint.get() }));
  const glyphSize = size === 76 ? 30 : 24;
  const toward = morph?.toward;
  const to = morph?.look.glyph ?? glyphSize;
  const scale = morph?.look.scale ?? 1;
  const becoming = useAnimatedStyle(
    () => ({ opacity: toward ? toward.get() : 0 }),
    [toward],
  );
  const growing = useAnimatedStyle(
    () => ({
      transform: [
        {
          scale: toward
            ? glyphScale(toward.get(), glyphSize, size, to, scale)
            : 1,
        },
      ],
    }),
    [toward, glyphSize, size, to, scale],
  );

  // On the way the glyph is the control's own: drawn at the size it lands
  // at, with the control's stroke, and shrunk inside the circle as it sets
  // out (`glyphScale`). So its line is the control's for its size all the
  // way, and the one it hands over to is its twin (REDESIGN.md 4, stroke
  // width by size). Nothing is enlarged, which on a device draws a soft,
  // heavy line, and no stroke is animated, which a device does not draw.
  const landed = to * scale;
  const line = strokeFor(to);

  const bloom = test ? palette.slate : palette.bloom;
  const fill = stale ? 'transparent' : primary ? bloom : palette.mocha;
  const ink = stale ? palette.dust : primary ? palette.ink : palette.cream;
  // Gated, the main control keeps a slate ring on a test network: the test
  // network is a safety state of its own (REDESIGN.md rule 4), and an old
  // balance must not hide it.
  const ring =
    stale && primary && test
      ? palette.slate
      : stale || !primary
      ? palette.husk
      : fill;
  const circle = (
    <Reanimated.View style={motion}>
      <Pressable
        ref={view}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: stale }}
        accessibilityValue={stale ? { text: copy.health.stale } : undefined}
        onLayout={measure}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          styles.circle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: fill,
            borderColor: ring,
          },
        ]}
      >
        <Reanimated.View
          pointerEvents="none"
          style={[styles.refused, { borderRadius: size / 2 }, refused]}
        />
        {morph ? (
          // The control's disc and ring, in its own points shrunk to this
          // circle's, over the circle's own, so the growth carries it to
          // the control's size exactly.
          <Reanimated.View
            pointerEvents="none"
            style={[
              styles.becoming,
              {
                borderRadius: size / 2,
                backgroundColor: morph.look.fill,
                borderColor: morph.look.ring,
                borderWidth: (morph.look.ringWidth * size) / PRIMARY_CONTROL,
              },
              becoming,
            ]}
          />
        ) : null}
        <Reanimated.View style={morph ? growing : undefined}>
          {morph ? (
            <Glyph name={glyph} size={landed} color={ink} strokeWidth={line} />
          ) : (
            <Glyph name={glyph} size={glyphSize} color={ink} />
          )}
          {morph ? (
            <Reanimated.View style={[styles.over, becoming]}>
              <Glyph
                name={glyph}
                size={landed}
                color={morph.look.ink}
                strokeWidth={line}
              />
            </Reanimated.View>
          ) : null}
        </Reanimated.View>
      </Pressable>
    </Reanimated.View>
  );
  // Only a gated circle whispers: a live one says what it does by doing it.
  // The whisper stays in place either way, so the gate never redraws it.
  return (
    <Whisper label={copy.health.stale} enabled={stale}>
      {circle}
    </Whisper>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  refused: { ...StyleSheet.absoluteFill, backgroundColor: palette.radishSoft },
  // Over the hairline border too, so its ring is the circle's outer edge.
  becoming: {
    position: 'absolute',
    top: -StyleSheet.hairlineWidth,
    left: -StyleSheet.hairlineWidth,
    right: -StyleSheet.hairlineWidth,
    bottom: -StyleSheet.hairlineWidth,
  },
  over: StyleSheet.absoluteFill,
});
