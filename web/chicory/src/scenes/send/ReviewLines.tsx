import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, TextStyle } from 'react-native';
import Reanimated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { MAX_FEE_RATE } from '@beignet/wallet-core';
import type { SendReview } from '@beignet/wallet-core';
import { Glyph } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { Odometer } from '../../glyphs/Odometer';
import { Whisper } from '../../glyphs/Whisper';
import { curves, durations } from '../../motion/tokens';
import { space, type as typography } from '../../theme';
import type { Unit } from '../../theme';
import { rateText, reviewFigures, reviewRail } from './model';
import { useBloom } from './tone';
import type { ReviewFigure } from './model';

/** The sum's lines are line text, which stops growing at 1.4 (REDESIGN.md 3.3). */
export const LINE_SCALE = 1.4;

/**
 * The widest of the sum's operators. Every line sets its own in a column
 * this wide, drawn out of sight to hold the width at any text size, so the
 * amounts after them start and end together.
 */
export const WIDEST_SIGNS = '+ ≤';

/**
 * The widest rate the engine prices at, as the fee line draws one. On a sum
 * with a rate, every line sets it in a trailing column this wide, drawn out
 * of sight as the operators' column is held, so the amounts before it keep
 * their shared right edge whatever rate the fee line shows.
 */
export const WIDEST_RATE = rateText(MAX_FEE_RATE);

/** The gap between an amount and the rate column after it. */
export const RATE_GAP = space.sm;

/**
 * How much narrower than its room a sum with its rate column must be before
 * the rate goes back up beside the fee, so a sum on the boundary never
 * flickers between the two.
 */
export const REFLOW_SLACK = 2;

/**
 * Whether the fee line's rate sits under the fee rather than beside it: once
 * the sum with its rate column (`rest` without it, and `column` the column
 * with its gap) would be wider than its `room`, and until it would fit with
 * REFLOW_SLACK to spare, as the BTC face is at the largest text sizes.
 * Unmeasured, any of them 0, the column stands.
 */
export function rateBelow(
  below: boolean,
  room: number,
  rest: number,
  column: number,
): boolean {
  if (!(room > 0) || !(rest > 0) || !(column > 0)) return false;
  const wide = rest + column;
  return below ? wide > room - REFLOW_SLACK : wide > room;
}

/** A rate gives way to another over a crossfade, under Reduce Motion too. */
const RATE_IN = FadeIn.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);
const RATE_OUT = FadeOut.duration(durations.crossfade).reduceMotion(
  ReduceMotion.Never,
);

/**
 * The rate the fee was priced at, in meta steam. While the slider's thumb
 * moves (`quick`) it is one text whose figures change in place, so a fast
 * drag never smears; the first preview, a chosen rate landing on another
 * and a refused rate springing back each crossfade, the new text over the
 * old one's place. The first render shows as it is.
 */
function Rate({
  rate,
  quick,
  style,
}: {
  rate: number;
  quick: boolean;
  style: StyleProp<TextStyle>;
}) {
  return (
    <LayoutAnimationConfig skipEntering>
      <Reanimated.Text
        key={quick ? 'preview' : String(rate)}
        entering={RATE_IN}
        exiting={RATE_OUT}
        style={style}
        maxFontSizeMultiplier={LINE_SCALE}
      >
        {rateText(rate)}
      </Reanimated.Text>
    </LayoutAnimationConfig>
  );
}

/**
 * One line of the sum, as one element: the rail on the first line, its
 * signs in the operators' column, its amount set right in tabular figures
 * by the odometer, so the places of every amount line up, the total reads
 * as their sum, and a figure that changes rolls to its new value, and on a
 * sum with a rate the rate column after it, which only the fee line fills
 * (`Rate`). The operators and the rate stand on the figures' baseline. Once
 * the sum with its column would not fit its room (`below`), the fee line
 * draws its rate under its amount instead, set right to the amounts' edge,
 * and no line holds the column. A screen reader hears the line's words, and
 * the rail's with the first, since the glyph is not a control of its own;
 * the odometer's cells and the rate are hidden from it, as the amount above
 * hides its own, and the slider says the rate.
 */
function Figure({
  figure,
  unit,
  symbol,
  rail,
  quick,
  column,
  below,
  measure,
}: {
  figure: ReviewFigure;
  unit: Unit;
  symbol: boolean;
  rail?: ReturnType<typeof reviewRail>;
  quick: boolean;
  /** The sum has a rate column, which this line holds open. */
  column: boolean;
  /** The sum's rate sits under its fee rather than beside it. */
  below: boolean;
  /** Told the ghost rate's width as it is laid out, on the line that measures it. */
  measure?: (width: number) => void;
}) {
  const bloom = useBloom();
  const total = figure.key === 'total';
  const onGhost = useCallback(
    (event: LayoutChangeEvent) => measure?.(event.nativeEvent.layout.width),
    [measure],
  );
  const line = (
    <View
      accessible
      accessibilityLabel={
        rail ? `${rail.label}, ${figure.label}` : figure.label
      }
      accessibilityValue={{ text: figure.value }}
      style={styles.line}
    >
      <View style={styles.rail}>
        {rail ? <Glyph name={rail.glyph} size={20} color={bloom.tone} /> : null}
      </View>
      <View style={styles.signs}>
        <Text
          style={[styles.sign, styles.ghost]}
          maxFontSizeMultiplier={LINE_SCALE}
        >
          {WIDEST_SIGNS}
        </Text>
        <Text
          style={[styles.sign, styles.shownSign]}
          maxFontSizeMultiplier={LINE_SCALE}
        >
          {figure.signs}
        </Text>
      </View>
      <View
        style={styles.amount}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Odometer
          sats={figure.sats}
          unit={unit}
          symbol={symbol}
          variant="line"
          color={total ? palette.cream : palette.steam}
          duration={quick ? durations.crossfade : undefined}
        />
      </View>
      {column ? (
        <View
          style={styles.rate}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text
            style={[styles.rateText, styles.ghost]}
            maxFontSizeMultiplier={LINE_SCALE}
            onLayout={measure ? onGhost : undefined}
          >
            {WIDEST_RATE}
          </Text>
          {figure.rate !== undefined ? (
            <Rate
              rate={figure.rate}
              quick={quick}
              style={[styles.rateText, styles.shownRate]}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
  if (!below || figure.rate === undefined) return line;
  return (
    <View style={styles.figure}>
      {line}
      <View
        style={styles.under}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text
          style={[styles.rateText, styles.ghost, styles.aside]}
          maxFontSizeMultiplier={LINE_SCALE}
          onLayout={measure ? onGhost : undefined}
        >
          {WIDEST_RATE}
        </Text>
        <Rate rate={figure.rate} quick={quick} style={styles.rateText} />
      </View>
    </View>
  );
}

/** An engine warning, as a honey pip that says it when asked. */
function Pip({ warning }: { warning: string }) {
  return (
    <Whisper label={warning}>
      <View accessible accessibilityLabel={warning} style={styles.pipArea}>
        <View style={styles.pip} />
      </View>
    </Whisper>
  );
}

/** How far the sum dims once the payment it priced is going out. */
export const SPENT_OPACITY = 0.4;

/**
 * What a payment will cost, as a sum with no words on it (REDESIGN.md 6,
 * Send): the rail and `+ ≤` the most the fee can be, `≈` what the route
 * priced should cost when there is an estimate, and `=` the most it all
 * comes to. Each line's words, as the engine and the old screen named them,
 * are what a screen reader hears. Engine warnings are honey pips.
 *
 * The figures are in `unit`, the one the balance is shown in, and sats as
 * `₿2,000` with `symbol` on. They are never hidden: a review is where the
 * payment is checked before it is sent. A figure that changes rolls to its
 * new value, and `quick` while the fee slider's thumb is moving, so the sum
 * keeps up with the finger. On a review the engine priced at a rate, the fee
 * line says that rate beside the fee, `3 sat/vB`, in a column every line of
 * the sum holds open; the rate follows the thumb and the engine's answer
 * with the figures. The sum measures its room, its own width and the
 * column's as they are laid out, and once it would be wider than its room
 * with the column, as the BTC face is at the largest text sizes, the rate
 * drops under the fee and the column goes (`rateBelow`). `children` sit
 * under the lines and over the pips, as wide as the sum: the fee rate
 * slider on a Bitcoin review. Once the hold commits (`spent`) there is
 * nothing left to check, so the sum and what sits in it dim back and the
 * screen reads as money going out.
 */
export function ReviewLines({
  review,
  unit = 'sats',
  symbol = false,
  spent = false,
  quick = false,
  children,
}: {
  review: SendReview;
  unit?: Unit;
  symbol?: boolean;
  spent?: boolean;
  quick?: boolean;
  children?: ReactNode;
}) {
  const rail = reviewRail(review);
  const figures = reviewFigures(review);
  const rated = figures.some(figure => figure.rate !== undefined);
  // The sum's room, its own width and its ghost rate's, as laid out. The
  // lines' width is read with the way they were laid out, so the sum's
  // width without the column is known either way.
  const [room, setRoom] = useState(0);
  const [sum, setSum] = useState({ width: 0, withColumn: false });
  const [ghost, setGhost] = useState(0);
  const [below, setBelow] = useState(false);
  const withColumn = useRef(false);
  const column = ghost > 0 ? ghost + RATE_GAP : 0;
  const rest = sum.withColumn ? sum.width - column : sum.width;
  // Read as the measurements come in, so the frame that follows a change
  // is laid out the new way.
  const drops = rateBelow(below, room, rest, column);
  if (drops !== below) setBelow(drops);
  const drawsColumn = rated && !drops;
  useLayoutEffect(() => {
    withColumn.current = drawsColumn;
  });
  const onRoom = useCallback(
    (event: LayoutChangeEvent) => setRoom(event.nativeEvent.layout.width),
    [],
  );
  const onLines = useCallback(
    (event: LayoutChangeEvent) =>
      setSum({
        width: event.nativeEvent.layout.width,
        withColumn: withColumn.current,
      }),
    [],
  );
  // A colour change, not a movement, so it plays under Reduce Motion too.
  const dim = useSharedValue(spent ? SPENT_OPACITY : 1);
  useEffect(() => {
    dim.set(
      withTiming(spent ? SPENT_OPACITY : 1, {
        duration: durations.move,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      }),
    );
  }, [spent, dim]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.get() }));
  return (
    <View style={styles.room} onLayout={onRoom}>
      <Reanimated.View style={[styles.lines, dimStyle]} onLayout={onLines}>
        {figures.map((figure, index) => (
          <Figure
            key={figure.key}
            figure={figure}
            unit={unit}
            symbol={symbol}
            rail={index === 0 ? rail : undefined}
            quick={quick}
            column={drawsColumn}
            below={rated && drops}
            measure={index === 0 ? setGhost : undefined}
          />
        ))}
        {children}
        {review.warnings.length ? (
          <View style={styles.pips}>
            {review.warnings.map(warning => (
              <Pip key={warning} warning={warning} />
            ))}
          </View>
        ) : null}
      </Reanimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Across its parent, so the sum knows the room it may take.
  room: { alignSelf: 'stretch' },
  // As wide as its widest line, which every other line stretches to.
  lines: { alignSelf: 'center', alignItems: 'stretch', gap: space.xs },
  // The operators and the rate stand on the figures' baseline; the rail and
  // the amount sit centred on the line.
  line: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  rail: { width: 24, alignItems: 'center', alignSelf: 'center' },
  signs: { justifyContent: 'center' },
  sign: { ...typography.line, color: palette.steam },
  ghost: { opacity: 0 },
  shownSign: { position: 'absolute', left: 0, top: 0 },
  // Set right, in the line's tabular figures, so places line up.
  amount: {
    flexGrow: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignSelf: 'center',
  },
  rate: { justifyContent: 'center' },
  rateText: {
    ...typography.meta,
    color: palette.steam,
    includeFontPadding: false,
  },
  shownRate: { position: 'absolute', left: 0, top: 0 },
  // The fee line with its rate under it, set right to the amounts' edge.
  figure: { alignItems: 'stretch' },
  under: { alignItems: 'flex-end' },
  // Out of the flow: measured, and nothing more.
  aside: { position: 'absolute', right: 0, top: 0 },
  pips: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.xxs,
    paddingTop: space.xs,
  },
  pipArea: {
    width: 28,
    height: 28,
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
