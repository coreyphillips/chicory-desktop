import React, { useEffect } from 'react';
import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { CopiedGlyph } from '../../glyphs/CopyChip';
import { Whisper } from '../../glyphs/Whisper';
import { useOnce, useShake } from '../../motion/effects';
import { riseIn } from '../../motion/presets';
import { curves, durations, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { motionReduced } from '../../services/motion';
import { usePaneActive } from '../../stage/panes/Pane';
import { space, type as typography } from '../../theme';
import { BANG, DrawnGlyph } from '../send/DrawnGlyph';
import { Unplugged } from '../send/LoopingGlyphs';
import type { Focus } from './focus';
import { Pulse, Spin } from './loops';
import { refusalLook } from './model';
import { useBloom } from './tone';

/**
 * The circle of the way on, on the form and on the quote: the size Home's
 * receive circle grows to as Receive opens (REDESIGN.md 7, T2), as Send's
 * control is for T1, so the circle lands on the control it becomes.
 */
export const CONTROL = 88;

/** The least a finger is given to press or hold (REDESIGN.md 3.4). */
export const TARGET = 48;

/** The quote's expiry ring, just outside the way on. */
export const RING = CONTROL + 16;

// The row the way on sits in, as tall as the quote's ring (stage/layout).
export { CONTROL_ROW } from '../../stage/layout';

/** How long refresh takes to turn once as it arrives (REDESIGN.md 4). */
const TURN_MS = 500;

/**
 * A control's disc and glyph crossfading as its tone changes, such as plus
 * becoming the way on as money arrives (REDESIGN.md 6, Receive): the disc
 * as it was fades out over the disc as it is, and the glyph as it was gives
 * way to the glyph as it is, each over a crossfade. A colour change moves
 * nothing through space, so it plays under Reduce Motion too.
 */
const FADE_IN = FadeIn.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);
const FADE_OUT = FadeOut.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);

/**
 * A control arriving in place of another by turning once, as refresh does
 * when a quote runs out (REDESIGN.md 4). Under Reduce Motion it only fades
 * in.
 */
export function turnIn(): EntryExitAnimationFunction {
  if (motionReduced()) return riseIn(0);
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ rotate: '-360deg' }] },
      animations: {
        opacity: withTiming(1, {
          duration: durations.enter,
          easing: curves.enter,
        }),
        transform: [
          {
            rotate: withTiming('0deg', {
              duration: TURN_MS,
              easing: curves.standard,
            }),
          },
        ],
      },
    };
  };
}

/**
 * A round glyph control, the only kind Receive has (REDESIGN.md 6). Its
 * label, hint and state carry the words a button used to show.
 *
 * `tone` is how much it stands out: `primary` is the way on, a bloom disc;
 * `raised` a mocha disc; `bare` only its glyph in a place a finger can
 * press, as the glyphs it sits among are drawn, turning bloom while what it
 * opens is open (`expanded`).
 *
 * `disabled` takes no taps. `blocked` looks and reads disabled but still
 * answers a tap with `onBlocked`, as a control held back by a stale balance
 * shakes and refreshes. A new `shake` refuses; a new `pulse` swells once to
 * say it is the way on; `halo` rings it in bloom for as long as it is the
 * only way on; a new `confirm` turns its glyph to a sage check and back, as
 * a copy chip's does when it copies. `busy` turns an orbit round it.
 * Children sit beside the glyph as data, such as what a request still
 * needs, and `value` says them for a screen reader, which hears the label in
 * their place. `focusRef` is where a screen reader's focus is sent when this
 * is the way on. The orbit and the halo are drawing, which a screen reader
 * passes over. A change of `tone` crossfades the disc and the glyph rather
 * than cutting, as plus becomes the way on when money arrives.
 */
export function GlyphButton({
  glyph,
  label,
  hint,
  onPress,
  onBlocked,
  size = 56,
  tone = 'raised',
  align = 'center',
  disabled = false,
  blocked = false,
  busy = false,
  shake: shakeKey,
  pulse: pulseKey,
  confirm,
  halo = false,
  expanded,
  value,
  focusRef,
  turns = false,
  children,
}: PropsWithChildren<{
  glyph: GlyphName;
  label: string;
  hint?: string;
  onPress: () => void;
  onBlocked?: () => void;
  size?: number;
  tone?: 'primary' | 'raised' | 'bare';
  /** Anchor a bare glyph to the text direction's leading edge of its hit target. */
  align?: 'center' | 'start';
  disabled?: boolean;
  blocked?: boolean;
  busy?: boolean;
  shake?: number;
  pulse?: number;
  confirm?: number;
  halo?: boolean;
  /** For a control that opens something: whether it is open. */
  expanded?: boolean;
  /** What the children show, as a screen reader hears it after the label. */
  value?: string;
  focusRef?: Focus;
  /** It is the big arrow Send's control turns into, and back. */
  turns?: boolean;
}>) {
  const live = usePaneActive();
  const { reduced } = useMotionPrefs();
  const { bloom } = useBloom();
  const press = useSharedValue(1);
  const swell = useSharedValue(1);
  // A refusal shakes it, or tints it radish under Reduce Motion.
  const refusal = useShake();
  useOnce(shakeKey, refusal.play);
  useOnce(pulseKey, () => {
    if (reduced) return;
    swell.set(
      withSequence(
        withSpring(1.12, springs.reveal),
        withSpring(1, springs.reveal),
      ),
    );
  });
  useEffect(
    () => () => {
      cancelAnimation(swell);
      cancelAnimation(press);
    },
    [swell, press],
  );
  const scaled = useAnimatedStyle(() => ({
    transform: [{ scale: swell.get() * press.get() }],
  }));

  const quiet = disabled || blocked;
  const primary = tone === 'primary' && !quiet;
  const bare = tone === 'bare';
  const ink = quiet
    ? palette.dust
    : primary
    ? palette.ink
    : bare && expanded
    ? bloom
    : palette.cream;
  const to = (scale: number) =>
    press.set(reduced ? 1 : withSpring(scale, springs.snap));
  const round = { width: size, height: size, borderRadius: size / 2 };
  const pill = { minHeight: size, borderRadius: size / 2 };
  // A layer over the disc fills the control from its insets, inside any husk
  // ring. Given a size of its own it would start inside the ring's border
  // and spill past it at the bottom right, since Yoga places an absolute
  // child from the border's inside and lets a width beat a right inset.
  const over = { borderRadius: size / 2 };
  // The disc's colour, which a layer keyed by it fades out of as it changes.
  const fill = primary ? bloom : bare ? null : palette.mocha;
  // Held back, it is drawn as Send's way on is, a mocha disc in a husk ring
  // with a dust glyph: a shape as well as a colour (REDESIGN.md 9). And a
  // long press whispers why (REDESIGN.md rule 3).
  const held = quiet && !bare && { borderWidth: quietRing(size) };
  return (
    <Whisper label={hint ?? label} enabled={quiet}>
      <Reanimated.View style={refusal.style}>
        <Reanimated.View style={scaled}>
          {halo ? (
            <Decor size={size}>
              <Pulse>
                <View
                  style={[styles.haloRing, ring(size), { borderColor: bloom }]}
                />
              </Pulse>
            </Decor>
          ) : null}
          <Pressable
            {...(turns ? { dataSet: { bigControl: 'true' } } : {})}
            ref={focusRef}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityState={{ disabled: quiet, busy, expanded }}
            accessibilityValue={value ? { text: value } : undefined}
            disabled={disabled || busy}
            onPressIn={live ? () => to(0.94) : undefined}
            onPressOut={live ? () => to(1) : undefined}
            onPress={
              live
                ? () => {
                    if (blocked) {
                      onBlocked?.();
                      return;
                    }
                    if (primary) haptics.tap();
                    else haptics.tick();
                    onPress();
                  }
                : undefined
            }
            style={[
              styles.control,
              bare && align === 'start' && styles.leading,
              children ? [styles.pill, pill] : round,
              primary
                ? { backgroundColor: bloom }
                : bare
                ? undefined
                : styles.raised,
              quiet && !bare && styles.quiet,
              held,
            ]}
          >
            <LayoutAnimationConfig skipEntering>
              {fill ? (
                <Reanimated.View
                  key={fill}
                  exiting={FADE_OUT}
                  pointerEvents="none"
                  style={[styles.tint, over, { backgroundColor: fill }]}
                />
              ) : null}
              <Reanimated.View key={ink} entering={FADE_IN} exiting={FADE_OUT}>
                {turns ? (
                  <View {...{ dataSet: { bigArrow: 'true' } }} style={styles.arrow}>
                    <Glyph
                      name={glyph}
                      size={Math.round(size * 0.42)}
                      color={ink}
                    />
                  </View>
                ) : confirm === undefined ? (
                  <Glyph
                    name={glyph}
                    size={Math.round(size * 0.42)}
                    color={ink}
                  />
                ) : (
                  <CopiedGlyph
                    name={glyph}
                    size={Math.round(size * 0.42)}
                    color={ink}
                    copies={confirm}
                  />
                )}
              </Reanimated.View>
            </LayoutAnimationConfig>
            {children ? (
              <Text
                style={[styles.data, { color: ink }]}
                maxFontSizeMultiplier={1.4}
              >
                {children}
              </Text>
            ) : null}
            <Reanimated.View
              pointerEvents="none"
              style={[styles.tint, over, refusal.tint]}
            />
          </Pressable>
          {busy ? (
            <Decor size={size}>
              <Spin>
                <Orbit size={size + ORBIT_GAP * 2} color={bloom} />
              </Spin>
            </Decor>
          ) : null}
        </Reanimated.View>
      </Reanimated.View>
    </Whisper>
  );
}

const ORBIT_GAP = 5;

/**
 * The husk ring round a control held back: Send's 4pt on the 88pt way on,
 * and in step with it on a smaller control, never under 2pt.
 */
export const quietRing = (size: number) => Math.max(2, Math.round(size / 22));

/** A circle just outside a control `size` across. */
const ring = (size: number) => ({
  width: size + ORBIT_GAP * 2,
  height: size + ORBIT_GAP * 2,
  borderRadius: size / 2 + ORBIT_GAP,
});

/** Where that circle sits, from the control's own corner. */
const around = (size: number) => ({
  top: -ORBIT_GAP,
  left: -ORBIT_GAP,
  ...ring(size),
});

/**
 * Drawing just outside a control `size` across, such as its orbit or its
 * halo: it takes no touches, and a screen reader passes over it.
 */
function Decor({ size, children }: PropsWithChildren<{ size: number }>) {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.around, around(size)]}
    >
      {children}
    </View>
  );
}

/** A quarter arc in bloom, which turns while something is being prepared. */
function Orbit({ size, color }: { size: number; color: string }) {
  const stroke = 2.5;
  const r = size / 2 - stroke;
  const circumference = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={[circumference / 4, circumference]}
      />
    </Svg>
  );
}

/**
 * Something went wrong with what was just asked, beside the control that
 * asked it (REDESIGN.md 6, Engine errors): a radish bang, or while the
 * primary node is away a honey unplug whose halves drift apart and back
 * (`refusalLook`, by the engine's `code`). The bang draws in, its line and
 * then its dot, as Send's does (REDESIGN.md 4). It says nothing on screen; the
 * whole message is its label. Whoever sets it also announces it, so it is
 * not a live region too, which would have Android read it twice.
 */
export function ErrorPip({
  message,
  code,
}: {
  message: string;
  code?: string;
}) {
  const look = refusalLook(code);
  const honey = look.tone === 'honey';
  // The disc is 32, in a place a finger can hold to hear it whispered.
  return (
    <Whisper label={message}>
      <Reanimated.View
        entering={riseIn(8)}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={message}
        style={styles.pipArea}
      >
        <View style={[styles.errorPip, honey && styles.waitPip]}>
          {look.glyph === 'unplug' ? (
            <Unplugged size={18} color={palette.honey} />
          ) : (
            <DrawnGlyph
              name="bang"
              size={18}
              color={palette.radish}
              strokes={BANG}
            />
          )}
        </View>
      </Reanimated.View>
    </Whisper>
  );
}

/**
 * What the engine warned about, as honey pips: one each, each carrying its
 * warning for a screen reader and whispering it when held, in a place big
 * enough to hold (REDESIGN.md 3.4, 48 at the least).
 */
export function WarningPips({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <View style={styles.pips}>
      {warnings.map((warning, i) => (
        <Whisper key={i} label={warning}>
          <View accessible accessibilityLabel={warning} style={styles.pipArea}>
            <View style={styles.pip} />
          </View>
        </Whisper>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // The arrow's box, the size of Send's, for a switch to turn it in place.
  arrow: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  control: { alignItems: 'center', justifyContent: 'center' },
  leading: { alignItems: 'flex-start' },
  pill: {
    flexDirection: 'row',
    gap: space.xs,
    paddingHorizontal: space.lg,
  },
  raised: { backgroundColor: palette.mocha },
  quiet: { backgroundColor: palette.mocha, borderColor: palette.husk },
  data: { ...typography.line },
  tint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: palette.radishSoft,
  },
  around: { position: 'absolute' },
  haloRing: { borderWidth: 2 },
  errorPip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.radishSoft,
  },
  waitPip: { backgroundColor: palette.honeySoft },
  pips: { flexDirection: 'row', justifyContent: 'center' },
  pipArea: {
    width: TARGET,
    height: TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pip: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.honey,
  },
});
