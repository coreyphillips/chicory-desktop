import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import type {
  ComponentRef,
  PropsWithChildren,
  ReactNode,
  Ref,
  RefObject,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  HostInstance,
  LayoutChangeEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import Reanimated, {
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  ZoomOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { mixHex, palette } from '../../design/palette';
import { useFocus } from '../../motion/focus';
import { dropOut, riseIn, smooth, stagger } from '../../motion/presets';
import { steady } from '../../motion/steady';
import { curves, durations, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { usePaneActive } from '../../stage/panes/Pane';
import { radius, space, type } from '../../theme';
import { useSettingsHost } from './host';
import { joinedAbove, joinedBelow } from './hubModel';
import type { HubEdge, HubRow, StatusLook } from './hubModel';
import { REVEAL_GROWTH } from './reveal';
import {
  Breathe,
  Chevron,
  Note,
  Toggle,
  Working,
  useAccent,
  useAccessoryPlace,
  useGlyphSize,
  wholeWords,
} from './ui';

/*
 * The parts Settings is built from as a grouped hub (REDESIGN.md 6,
 * Settings): the frame every item is drawn in, the group headers, the rows
 * that open in place, act at once or switch, the disc behind each row's
 * glyph, and the value a row shows beside its label.
 *
 * A group's card is not a view of its own. Each row draws its share of it
 * by where it sits (`HubEdge`): only the corners at the card's edge are
 * rounded, and a husk hairline joins a row to the one above it, inset to
 * the label column. So the page stays one flat list of keyed items, and a
 * row can join a card, leave it, or move from one place to another as
 * itself, its corners easing to its new place as it goes.
 *
 * Every control follows the canvas rule: it takes touches only while the
 * pane it is drawn in is in use.
 */

/** A row's least height, a touch target and then some (REDESIGN.md 3.4). */
export const ROW_HEIGHT = 56;

/** The disc behind a row's glyph, and the glyph on it, before the text size. */
export const DISC = 32;
export const ROW_GLYPH = 18;

/** The space between a row's disc, its words and its chevron. */
export const ROW_GAP = space.sm;

/** How far a pressed row's disc dips. */
export const DISC_DIP = 0.92;

/** How far a row's content rises as it opens, and drops as it closes. */
export const CONTENT_RISE = 8;

/** A status dot, and a disc's pip, before the text size. */
const DOT = 7;
const PIP = 6;

/** A status mark that is a glyph rather than a dot. */
const MARK_GLYPH = 14;

/**
 * A shared value that eases to `target` on the steady clock (REDESIGN.md
 * 3.5) over `duration` whenever `target` changes, and is set at once under
 * Reduce Motion.
 */
function useEased(target: number, duration: number, reduced: boolean) {
  const value = useSharedValue(target);
  useEffect(() => {
    if (value.get() === target) return;
    value.set(
      reduced
        ? target
        : steady(withTiming(target, { duration, easing: curves.standard })),
    );
  }, [value, target, duration, reduced]);
  return value;
}

/**
 * A colour that eases to `target` ('#rrggbb') over `duration` whenever it
 * changes, from wherever it had got to, and is set at once under Reduce
 * Motion. Read with `paintOf` inside a worklet.
 */
function useEasedColor(target: string, duration: number, reduced: boolean) {
  const from = useSharedValue(target);
  const to = useSharedValue(target);
  const done = useSharedValue(1);
  useEffect(() => {
    if (to.get() === target) return;
    from.set(mixHex(from.get(), to.get(), done.get()));
    to.set(target);
    if (reduced) {
      done.set(1);
      return;
    }
    done.set(0);
    done.set(steady(withTiming(1, { duration, easing: curves.standard })));
  }, [from, to, done, target, duration, reduced]);
  return { from, to, done };
}

/** Where an eased colour has got to. */
function paintOf(color: ReturnType<typeof useEasedColor>): string {
  'worklet';
  return mixHex(color.from.get(), color.to.get(), color.done.get());
}

/**
 * The frame an item of the hub is drawn in: espresso, its corners rounded
 * only at its card's edge, and a hairline at its top where it joins the row
 * above, inset to the label column. It rises in `step` steps after Settings
 * arrives (`stagger`) and moves to wherever the page puts it with the rest
 * (`smooth`). Its corners and its hairline ease with it when its place in
 * its card changes, as when a row joins the card above or below it.
 *
 * `tone` honey is the recovery phrase still to be saved, which leads the
 * page: a honey wash and outline with every corner rounded. As it is saved
 * the wash and outline fade to the plain frame while it moves to its row,
 * over the same move. Given at all, the frame keeps its outline's hairline,
 * in espresso while plain, so the outline fades rather than appears.
 *
 * It clips what it holds: a row's content is laid out where it will end up
 * while the frame grows to it on a linear transition, and would otherwise be
 * drawn over the item below for a frame. What it holds as it first mounts
 * arrives with it rather than rising again inside it; whatever comes after
 * rises in on its own.
 */
export function HubItem({
  edge,
  step,
  tone,
  style,
  frame,
  onLayout,
  children,
}: PropsWithChildren<{
  edge: HubEdge;
  step: number;
  tone?: 'plain' | 'honey';
  style?: StyleProp<ViewStyle>;
  /** The frame itself, for what measures it (`useRevealOnOpen`). */
  frame?: Ref<ComponentRef<typeof Reanimated.View>>;
  /** The frame's layout, the one it ends at, as it changes. */
  onLayout?: (event: LayoutChangeEvent) => void;
}>) {
  const { reduced } = useMotionPrefs();
  const inset = space.lg + useGlyphSize(DISC) + ROW_GAP;
  const above = useEased(joinedAbove(edge) ? 1 : 0, durations.move, reduced);
  const below = useEased(joinedBelow(edge) ? 1 : 0, durations.move, reduced);
  const honey = useEased(tone === 'honey' ? 1 : 0, durations.move, reduced);
  const corners = useAnimatedStyle(() => {
    const top = radius.lg * (1 - above.get());
    const bottom = radius.lg * (1 - below.get());
    return {
      borderTopLeftRadius: top,
      borderTopRightRadius: top,
      borderBottomLeftRadius: bottom,
      borderBottomRightRadius: bottom,
      backgroundColor: mixHex(palette.espresso, palette.honeyWash, honey.get()),
      borderColor: mixHex(palette.espresso, palette.honey, honey.get()),
    };
  });
  const seam = useAnimatedStyle(() => ({ opacity: above.get() }));
  return (
    <Reanimated.View
      ref={frame}
      entering={stagger(step)}
      layout={smooth()}
      onLayout={onLayout}
      style={[
        styles.item,
        tone !== undefined && styles.outlined,
        corners,
        style,
      ]}
    >
      <Reanimated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.seam, { left: inset }, seam]}
      />
      <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
    </Reanimated.View>
  );
}

/**
 * Brings a row into view as it opens, and again whenever what it holds
 * grows by more than `REVEAL_GROWTH` while it is open, as Empty wallet's
 * form becoming its review does (`useReveal`). It asks once the frame's
 * layout has been reported: the layout the row ends at, while its
 * transition still draws it on the way there. A row that closes, or one
 * that only moves as another opens or closes above it, asks for nothing.
 *
 * Its `frame` and `onLayout` go on the row's frame (`HubItem`).
 */
export function useRevealOnOpen(open: boolean) {
  const { reveal } = useSettingsHost();
  const frame = useRef<ComponentRef<typeof Reanimated.View>>(null);
  const height = useRef<number | null>(null);
  const showing = useRef(open);
  // Whether the row has opened since its frame last asked: set as the
  // opening commits, before the layout it brings is reported.
  const pending = useRef(false);
  useLayoutEffect(() => {
    showing.current = open;
    pending.current = open;
  }, [open]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = event.nativeEvent.layout.height;
      const before = height.current;
      height.current = next;
      if (!showing.current || !reveal) return;
      const grew = before !== null && next - before > REVEAL_GROWTH;
      if (!pending.current && !grew) return;
      pending.current = false;
      reveal(frame.current);
    },
    [reveal],
  );
  return { frame, onLayout };
}

/**
 * A group's header: its name in small capitals over the group's card, in
 * dust, or in honey for the group that moves money out of the wallet. A
 * screen reader hears a header in sentence case, as the words are written.
 */
export const GroupHeader = memo(function GroupHeaderView({
  title,
  tone = 'plain',
  step,
}: {
  title: string;
  tone?: 'plain' | 'honey';
  step: number;
}) {
  return (
    <Reanimated.View
      entering={stagger(step)}
      layout={smooth()}
      style={styles.header}
    >
      <Text
        accessibilityRole="header"
        accessibilityLabel={title}
        {...wholeWords(title)}
        style={[styles.headerText, tone === 'honey' && styles.headerHoney]}
      >
        {title}
      </Text>
    </Reanimated.View>
  );
});

/**
 * The disc behind a row's glyph: mocha, filled with `fill` ('#rrggbb') as
 * what the row opens is open or what it switches is on, the fill easing
 * over a crossfade, or over `duration` (REDESIGN.md 3.5), and set at once
 * under Reduce Motion. It dips with `dip` while its row is pressed, and a
 * `pip` of that colour at its upper right says something stopped short, as
 * the mark's honey pip does. It grows with the text size (`glyphScale`).
 */
export function GlyphDisc({
  fill,
  pip,
  dip,
  duration = durations.crossfade,
  children,
}: PropsWithChildren<{
  fill: string;
  pip?: string;
  dip?: SharedValue<number>;
  duration?: number;
}>) {
  const { reduced } = useMotionPrefs();
  const size = useGlyphSize(DISC);
  const pipSize = useGlyphSize(PIP);
  const paint = useEasedColor(fill, duration, reduced);
  const look = useAnimatedStyle(() => ({
    backgroundColor: paintOf(paint),
    transform: [{ scale: dip ? dip.get() : 1 }],
  }));
  return (
    <Reanimated.View
      testID="glyph-disc"
      style={[
        styles.disc,
        { width: size, height: size, borderRadius: size / 2 },
        look,
      ]}
    >
      {children}
      {pip ? (
        <View
          style={[
            styles.pip,
            {
              width: pipSize,
              height: pipSize,
              borderRadius: pipSize / 2,
              backgroundColor: pip,
            },
          ]}
        />
      ) : null}
    </Reanimated.View>
  );
}

/**
 * What a row's press does to its disc: a dip to `DISC_DIP` on the snap
 * spring as the finger lands, and back as it lifts. Under Reduce Motion the
 * disc holds still; the row's pressed opacity still shows the press.
 */
export function useDip() {
  const { reduced } = useMotionPrefs();
  const dip = useSharedValue(1);
  const to = (scale: number) => {
    if (!reduced) dip.set(withSpring(scale, springs.snap));
  };
  return { dip, down: () => to(DISC_DIP), up: () => to(1) };
}

/**
 * The mark before a status's words (`StatusLook`): a sage dot while the
 * primary node answers, a honey dot that breathes while it is sought, which
 * says something is under way and never rests, a still honey dot where
 * something stopped short, the accent's orbit while work is under way, or a
 * slate flask for a test network. It grows with the words beside it, and
 * holds still under Reduce Motion, solid honey while sought.
 */
export function StatusMark({ look }: { look: StatusLook }) {
  const dot = useGlyphSize(DOT);
  const glyph = useGlyphSize(MARK_GLYPH);
  if (look === 'working') return <Working size={glyph} />;
  if (look === 'test') {
    return <Glyph name="flask" size={glyph} color={palette.slate} />;
  }
  return (
    <Breathe on={look === 'seeking'}>
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: look === 'live' ? palette.sage : palette.honey,
        }}
      />
    </Breathe>
  );
}

/**
 * A row's value: its mark and its words, in steam, or in honey for a state
 * that needs attention. The words keep whole at any text size.
 */
export function RowValue({
  words,
  look,
  attention = false,
}: {
  words: string;
  look?: StatusLook | null;
  attention?: boolean;
}) {
  return (
    <View style={styles.value}>
      {look ? <StatusMark look={look} /> : null}
      <Text
        {...wholeWords(words)}
        style={[styles.valueText, attention && styles.valueAttention]}
      >
        {words}
      </Text>
    </View>
  );
}

/**
 * What a row opens: laid out under the row with the room the page gives,
 * rising 8pt into place as it opens and dropping 8pt as it goes (REDESIGN.md
 * 3.5); under Reduce Motion each is a crossfade. What it holds as it opens
 * rises with it rather than again inside it, so a warning that would rise
 * on its own, inside a form that would too, travels 8pt and no more; what
 * comes after, such as a review or an outcome, rises in on its own.
 */
export function RowContent({ children }: PropsWithChildren) {
  return (
    <Reanimated.View
      entering={riseIn(CONTENT_RISE)}
      exiting={dropOut(CONTENT_RISE)}
      style={styles.content}
    >
      <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
    </Reanimated.View>
  );
}

/** The ink and the open fill of a row's glyph, by its tone. */
function useRowTone(tone: 'accent' | 'honey' | 'radish') {
  const accent = useAccent();
  if (tone === 'honey') return { ink: palette.honey, soft: palette.honeySoft };
  if (tone === 'radish') {
    return { ink: palette.radish, soft: palette.radishSoft };
  }
  return { ink: accent.accent, soft: accent.soft };
}

/**
 * A row that opens in place: its glyph on its disc, its label, its value
 * when it has one, and a chevron that turns a quarter as it opens. One row
 * is open at a time; what it opens is drawn only while it is open
 * (`children`), so a closed row costs nothing and opens fresh.
 *
 * The value sits at the label's right while both fit, and takes the line
 * below the label once the label beside it would need a second line
 * (`accessoryBelow`, measured), as a section heading's accessory does.
 *
 * To a screen reader it is a button whose value is the row's value and
 * whose state says whether it is open. It takes touches only while its
 * pane is in use. `back` lands a screen reader on it, as a row whose content
 * closed itself, such as Keep my wallet, does.
 */
export const DisclosureRow = memo(function DisclosureRowView({
  id,
  edge,
  step,
  glyph,
  tone = 'accent',
  label,
  danger = false,
  accessibilityLabel,
  accessibilityHint,
  value,
  look,
  attention = false,
  said,
  open,
  back = false,
  disabled = false,
  pip = false,
  onToggle,
  children,
}: {
  id: HubRow;
  edge: HubEdge;
  step: number;
  glyph: GlyphName;
  /**
   * The glyph's colour, and the disc's fill while open: the accent, unless
   * honey or radish.
   */
  tone?: 'accent' | 'honey' | 'radish';
  label: string;
  /** The label in radish, for the row that deletes. */
  danger?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** The value drawn beside the label, if any. */
  value?: string;
  look?: StatusLook | null;
  /** The value in honey. */
  attention?: boolean;
  /** What a screen reader hears for the value, where not what is drawn. */
  said?: string;
  open: boolean;
  back?: boolean;
  disabled?: boolean;
  /** A honey pip on the disc. */
  pip?: boolean;
  onToggle: (id: HubRow) => void;
  children?: ReactNode;
}) {
  const live = usePaneActive();
  const target = useFocus(back);
  const size = useGlyphSize(ROW_GLYPH);
  const { ink, soft } = useRowTone(tone);
  const press = useDip();
  const place = useAccessoryPlace(!!value);
  const shown = useRevealOnOpen(open);
  // Beside its value the label wraps freely, so a squeezed label shows as a
  // second line and the value drops; on its own it keeps its words whole.
  const beside = !!value && !place.below;
  const usable = live && !disabled;
  return (
    <HubItem
      edge={edge}
      step={step}
      frame={shown.frame}
      onLayout={shown.onLayout}
    >
      <Pressable
        ref={target}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
        accessibilityValue={value ? { text: said ?? value } : undefined}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPressIn={usable ? press.down : undefined}
        onPressOut={usable ? press.up : undefined}
        onPress={
          usable
            ? () => {
                haptics.tick();
                onToggle(id);
              }
            : undefined
        }
        style={({ pressed }) => [
          styles.row,
          pressed && styles.pressed,
          disabled && styles.inactive,
        ]}
      >
        <GlyphDisc
          fill={open ? soft : palette.mocha}
          pip={pip ? palette.honey : undefined}
          dip={press.dip}
        >
          <Glyph name={glyph} size={size} color={ink} />
        </GlyphDisc>
        <View
          onLayout={value ? place.onRoom : undefined}
          style={[styles.words, place.below && styles.wordsBelow]}
        >
          <Text
            onTextLayout={value ? place.onHeading : undefined}
            {...(beside ? null : wholeWords(label))}
            style={[
              place.below ? styles.labelAbove : styles.label,
              danger && styles.labelDanger,
            ]}
          >
            {label}
          </Text>
          {value ? (
            <View onLayout={place.onAccessory} style={styles.accessory}>
              <RowValue words={value} look={look} attention={attention} />
            </View>
          ) : null}
        </View>
        <Chevron open={open} />
      </Pressable>
      {children ? <RowContent>{children}</RowContent> : null}
    </HubItem>
  );
});

/**
 * A row that acts at once, with no chevron and nothing to open, as Lock
 * device wallet does: a way out that must take one press, whatever else
 * is open. Its glyph is drawn by the caller, which may move it with the
 * press (`glyph`, given the press's dip and the row's hooks).
 */
export const ActionRow = memo(function ActionRowView({
  edge,
  step,
  label,
  glyph,
  onPressIn,
  onPressOut,
  onPress,
}: {
  edge: HubEdge;
  step: number;
  label: string;
  glyph: ReactNode;
  onPressIn?: () => void;
  onPressOut?: () => void;
  onPress: () => unknown;
}) {
  const live = usePaneActive();
  const press = useDip();
  return (
    <HubItem edge={edge} step={step}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPressIn={
          live
            ? () => {
                press.down();
                onPressIn?.();
              }
            : undefined
        }
        onPressOut={
          live
            ? () => {
                press.up();
                onPressOut?.();
              }
            : undefined
        }
        onPress={
          live
            ? () => {
                haptics.tick();
                return onPress();
              }
            : undefined
        }
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <GlyphDisc fill={palette.mocha} dip={press.dip}>
          {glyph}
        </GlyphDisc>
        <Text {...wholeWords(label)} style={styles.label}>
          {label}
        </Text>
      </Pressable>
    </HubItem>
  );
});

/**
 * A switch as a row's line: its glyph on its disc, which fills while it is
 * on, its label and its switch (`Toggle`), and a failure to change it
 * under them. It acts at once and opens nothing. Drawn in a frame of the
 * caller's, as a row that waits for something before it can show one does.
 */
export function ToggleLine({
  glyph,
  label,
  accessibilityLabel,
  value,
  disabled = false,
  error,
  onValueChange,
}: {
  glyph: ReactNode;
  label: string;
  accessibilityLabel: string;
  value: boolean;
  disabled?: boolean;
  error?: string;
  onValueChange: (next: boolean) => void | Promise<void>;
}) {
  const { soft } = useAccent();
  return (
    <>
      <View style={styles.toggleRow}>
        <Toggle
          glyph={
            <GlyphDisc fill={value ? soft : palette.mocha}>{glyph}</GlyphDisc>
          }
          label={label}
          accessibilityLabel={accessibilityLabel}
          value={value}
          disabled={disabled}
          onValueChange={onValueChange}
        />
      </View>
      {/* The note rises in on its own. */}
      {error ? (
        <View style={styles.content}>
          <Note tone="error">{error}</Note>
        </View>
      ) : null}
    </>
  );
}

/** A switch as a row of its own (`ToggleLine` in a frame). */
export function ToggleRow({
  edge,
  step,
  ...line
}: Parameters<typeof ToggleLine>[0] & { edge: HubEdge; step: number }) {
  return (
    <HubItem edge={edge} step={step}>
      <ToggleLine {...line} />
    </HubItem>
  );
}

/**
 * A row that only says something, such as that this phone offers no lock:
 * its glyph on its disc and its words in steam. It is not a control.
 */
export function NoteLine({
  glyph,
  children,
}: {
  glyph: GlyphName;
  children: string;
}) {
  const size = useGlyphSize(ROW_GLYPH);
  return (
    <View style={styles.row}>
      <GlyphDisc fill={palette.mocha}>
        <Glyph name={glyph} size={size} color={palette.steam} />
      </GlyphDisc>
      <Text style={styles.note}>{children}</Text>
    </View>
  );
}

/**
 * How a halo leaves as what it marked is done: it shrinks into its disc
 * over a move, as the bloom's halo shrinks into the mark once the phrase is
 * saved (REDESIGN.md 6, Backup and setup), or under Reduce Motion fades
 * within a crossfade.
 */
const HALO_SHRINK = ZoomOut.duration(durations.move);
const HALO_FADE = FadeOut.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);
export const haloOut = (reduced: boolean) =>
  reduced ? HALO_FADE : HALO_SHRINK;

/**
 * The heading of the recovery phrase still to be saved, as the row it is
 * drawn in leads the page: its shield on a honey disc with a halo that
 * breathes around it, and its title in honey. It is a header to a screen
 * reader and the first on the page, and `heading` lands one on it.
 */
export function LeadTitle({
  title,
  heading,
}: {
  title: string;
  heading?: RefObject<HostInstance | null>;
}) {
  return (
    <Text
      ref={heading}
      accessibilityRole="header"
      {...wholeWords(title)}
      style={styles.leadTitle}
    >
      {title}
    </Text>
  );
}

/**
 * The styles of a row's line, for a row drawn its own way, as the recovery
 * phrase's is while it moves from leading the page to its row.
 */
export const hubStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
    minHeight: ROW_HEIGHT,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
  pressed: { opacity: 0.6 },
  // The label takes what the disc, the value and the chevron leave.
  label: { ...type.body, color: palette.cream, flex: 1 },
  words: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
});

const styles = StyleSheet.create({
  item: {
    backgroundColor: palette.espresso,
    overflow: 'hidden',
  },
  outlined: { borderWidth: StyleSheet.hairlineWidth },
  seam: {
    position: 'absolute',
    top: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.husk,
  },
  header: {
    paddingTop: space.lg,
    paddingBottom: space.xs,
    paddingHorizontal: space.lg,
  },
  headerText: {
    ...type.micro,
    color: palette.dust,
    textTransform: 'uppercase',
  },
  headerHoney: { color: palette.honey },
  row: hubStyles.row,
  pressed: hubStyles.pressed,
  inactive: { opacity: 0.45 },
  disc: { alignItems: 'center', justifyContent: 'center' },
  pip: { position: 'absolute', top: 0, right: 0 },
  // The label and its value share a line while both fit, the label taking
  // what the value leaves; once they do not, the value takes the line below
  // (`accessoryBelow`).
  words: hubStyles.words,
  wordsBelow: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.xxs,
  },
  label: hubStyles.label,
  // Above the value it dropped, the label has the whole width.
  labelAbove: { ...type.body, color: palette.cream, alignSelf: 'stretch' },
  labelDanger: { color: palette.radish },
  accessory: { flexShrink: 0 },
  value: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  valueText: { ...type.meta, color: palette.steam, flexShrink: 1 },
  valueAttention: { color: palette.honey },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  toggleRow: {
    minHeight: ROW_HEIGHT,
    paddingHorizontal: space.lg,
    paddingVertical: space.xxs,
    justifyContent: 'center',
  },
  note: { ...type.body, color: palette.steam, flex: 1 },
  leadTitle: { ...type.label, color: palette.honey, flex: 1 },
});
