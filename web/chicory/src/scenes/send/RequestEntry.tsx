import React, { useEffect, useRef, useState } from 'react';
import type { ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { dissolve, popIn, useShake } from '../../motion/effects';
import { useLoop, wave } from '../../motion/loops';
import { durations, overlap } from '../../motion/tokens';
import { WELL } from '../../stage/layout';
import { usePaneActive } from '../../stage/panes/Pane';
import { HIT_SLOP, radius, space, type as typography } from '../../theme';
import { FailureMark } from './FailureMark';
import { GlyphButton } from './GlyphButton';
import { requestRail, shortRequest } from './model';
import { useBloom } from './tone';
import type { Failure } from './model';

/**
 * How far the request's words grow with Dynamic Type, as a row's do
 * (REDESIGN.md 3.3). The empty well then keeps its height, `WELL`, at every
 * text size, which is where a code read from home collapses to.
 */
const REQUEST_SCALE = 1.4;

/** Where a scan starts from on screen, for the reveal to grow out of. */
export type Origin = { x: number; y: number };

export interface RequestEntryProps {
  /** What a screen reader calls the request, and how the suites find it. */
  accessibilityLabel: string;
  value: string;
  /** Called as the request is typed, as a text field reports text. */
  onChangeText?: (text: string) => void;
  /** The request is taken: it shows as a chip rather than as text. */
  collapsed: boolean;
  /** The chip was tapped, to change the request. */
  onExpand?: () => void;
  /** Typing is done, by leaving the field or by its return key. */
  onCollapse?: () => void;
  /** The request names its amount, so the chip carries a lock. */
  fixed: boolean;
  /** The engine would not pay the request: a cross sits in the well. */
  refused?: Failure | null;
  busy?: boolean;
  /** Pastes a request, resolving false when there was none to paste. */
  onPaste?: () => Promise<boolean>;
  onScan?: (origin: Origin | null) => void;
}

/**
 * The payment request (REDESIGN.md 6, Send): a well to paste, scan or type
 * one into, which becomes a chip once a request is taken.
 *
 * The well is a mocha field in mono with no placeholder, its dashed edge
 * breathing while it waits, and the clipboard and scan beside it. A request
 * that is pasted, scanned or brought by a link, or typed and left, collapses
 * into a chip that pops in: the rail it will go over, where it pays,
 * shortened in the middle, and a lock when it names its amount. A tap on the
 * chip opens it again. A request the engine refuses dissolves back into the
 * well, where a cross draws.
 *
 * It takes a text field's `value` and `onChangeText`, so the suites and the
 * screen read and set the request the same way whichever is showing.
 *
 * A refused request stays in the well shortened in the middle, as a chip
 * shows one, on a line or two, until the well is touched to change it: the
 * whole of a long one would fill the well with lines of code that say no
 * more than the cross beside them. A screen reader still hears all of it.
 */
export function RequestEntry({
  accessibilityLabel,
  value,
  onChangeText,
  collapsed,
  onExpand,
  onCollapse,
  fixed,
  refused = null,
  busy = false,
  onPaste,
  onScan,
}: RequestEntryProps) {
  const live = usePaneActive() && !busy;
  const bloom = useBloom();
  // The well pops back in when a chip opens or dissolves into it, once the
  // chip is on its way out, but not when the scene first arrives: the scene
  // rises in as a whole.
  const settled = useRef(false);
  useEffect(() => {
    settled.current = true;
  }, []);
  if (collapsed && value.trim()) {
    const rail = requestRail(value);
    const shown = shortRequest(value);
    return (
      <AnimatedPressable
        entering={popIn()}
        exiting={dissolve()}
        accessibilityRole={onExpand ? 'button' : 'none'}
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: shown }}
        accessibilityHint={onExpand ? copy.send.requestHint : undefined}
        accessibilityState={{ disabled: !onExpand || busy }}
        hitSlop={HIT_SLOP}
        onPress={
          live && onExpand
            ? () => {
                haptics.tick();
                onExpand();
              }
            : undefined
        }
        style={styles.chip}
      >
        {rail ? <Glyph name={rail} size={16} color={bloom.tone} /> : null}
        <Text
          style={styles.chipText}
          numberOfLines={1}
          maxFontSizeMultiplier={REQUEST_SCALE}
        >
          {shown}
        </Text>
        {fixed ? <Glyph name="lock" size={14} color={palette.steam} /> : null}
      </AnimatedPressable>
    );
  }
  return (
    <Well
      entering={settled.current ? popIn(0.96, overlap.enterDelay) : undefined}
      focus={settled.current}
      accessibilityLabel={accessibilityLabel}
      value={value}
      onChangeText={live ? onChangeText : undefined}
      onCollapse={onCollapse}
      refused={refused}
      busy={busy}
      live={live}
      onPaste={onPaste}
      onScan={onScan}
    />
  );
}

const AnimatedPressable = Reanimated.createAnimatedComponent(Pressable);

function Well({
  entering,
  focus,
  accessibilityLabel,
  value,
  onChangeText,
  onCollapse,
  refused,
  busy,
  live,
  onPaste,
  onScan,
}: Pick<
  RequestEntryProps,
  | 'accessibilityLabel'
  | 'value'
  | 'onChangeText'
  | 'onCollapse'
  | 'refused'
  | 'onPaste'
  | 'onScan'
> & {
  entering?: EntryExitAnimationFunction;
  /** Opened from the chip or by a refusal: the keyboard comes up with it. */
  focus: boolean;
  busy: boolean;
  live: boolean;
}) {
  // The dashed edge breathes only while the well waits for something, in
  // and out once each 4200ms, and rests with the ambient clock.
  const breath = useLoop(durations.breathe, !value && !refused, true);
  const bloom = useBloom();
  const edge = useAnimatedStyle(() => ({
    opacity: 0.4 + 0.6 * wave(breath.get()),
  }));
  const missed = useShake();
  // Where the scan button sits, for the reveal: measured once it is laid
  // out and again as it is pressed, so the disc grows from where it is now.
  const scanButton = useRef<ComponentRef<typeof View>>(null);
  const scanAt = useRef<Origin | null>(null);
  const measure = () =>
    scanButton.current?.measureInWindow((x, y, width, height) => {
      scanAt.current = { x: x + width / 2, y: y + height / 2 };
    });
  const paste = () =>
    onPaste?.().then(taken => {
      if (!taken) missed.play();
    });
  // While it is being changed the whole request shows; otherwise a refused
  // one is folded to its short form, drawn under the field, which stays
  // where it is to take the touch that opens it.
  const [editing, setEditing] = useState(false);
  const folded = !!refused && !editing && !!value.trim();
  return (
    <Reanimated.View
      entering={entering}
      style={[styles.well, refused && styles.refused]}
    >
      <Reanimated.View
        pointerEvents="none"
        style={[styles.edge, !!value && styles.edgeSteady, edge]}
      />
      <View style={styles.field}>
        {folded ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            numberOfLines={2}
            maxFontSizeMultiplier={REQUEST_SCALE}
            style={styles.folded}
          >
            {shortRequest(value)}
          </Text>
        ) : null}
        <TextInput
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={value ? undefined : copy.send.requestEmpty}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            onCollapse?.();
          }}
          onSubmitEditing={onCollapse}
          submitBehavior="blurAndSubmit"
          returnKeyType="done"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          autoFocus={focus}
          editable={live}
          selectionColor={bloom.tone}
          maxFontSizeMultiplier={REQUEST_SCALE}
          style={[styles.input, folded && styles.behind]}
        />
      </View>
      {refused ? <FailureMark failure={refused} /> : null}
      {onPaste ? (
        <Reanimated.View style={missed.style}>
          <GlyphButton
            glyph="clipboard"
            accessibilityLabel={copy.send.paste}
            onPress={live ? paste : undefined}
            disabled={busy}
            size={44}
            ground={false}
          />
        </Reanimated.View>
      ) : null}
      {onScan ? (
        <View ref={scanButton} onLayout={measure} collapsable={false}>
          <GlyphButton
            glyph="scan"
            accessibilityLabel={copy.send.scan}
            onPress={
              live
                ? () => {
                    measure();
                    onScan(scanAt.current);
                  }
                : undefined
            }
            disabled={busy}
            size={44}
            ground={false}
          />
        </View>
      ) : null}
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 44,
    maxWidth: '100%',
    paddingHorizontal: space.md,
    borderRadius: radius.round,
    backgroundColor: palette.mocha,
  },
  chipText: { ...typography.mono, color: palette.cream, flexShrink: 1 },
  well: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: WELL,
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    backgroundColor: palette.mocha,
  },
  refused: { backgroundColor: palette.radishWash },
  edge: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: palette.bark,
  },
  edgeSteady: { borderStyle: 'solid', borderColor: palette.husk },
  field: { flex: 1, justifyContent: 'center' },
  input: {
    ...typography.mono,
    color: palette.cream,
    padding: 0,
    maxHeight: WELL * 2,
  },
  folded: { ...typography.mono, color: palette.cream },
  // Over the folded request, to take the touch that opens it, with its own
  // text out of sight.
  behind: { ...StyleSheet.absoluteFill, color: 'transparent' },
});
