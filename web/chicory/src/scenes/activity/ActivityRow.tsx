import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import type { Activity } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { InlineSign } from '../../glyphs/InlineAmount';
import { StatusRing } from '../../glyphs/StatusRing';
import { Whisper } from '../../glyphs/Whisper';
import { riseIn } from '../../motion/presets';
import { curves, overlap } from '../../motion/tokens';
import { useBuild } from '../../stage/panes/Build';
import { usePaneActive } from '../../stage/panes/Pane';
import type { Rect } from '../../stage/scene';
import {
  MASK,
  dateLabel,
  radius,
  space,
  type as typography,
} from '../../theme';
import type { Unit } from '../../theme';
import {
  NOTE_GAP,
  ROW_BAND,
  ROW_GAP,
  ROW_HEIGHT,
  ROW_OPEN,
  ROW_RING,
  activityStatus,
  timeLabel,
} from './model';
import type { Band } from './model';
import { measureNode, registerRow } from './rowRects';
import type { RowNode } from './rowRects';
import { rowBeat, rowReturn } from './sheet';
import {
  EXPIRED_OPACITY,
  RAIL_GLYPH,
  amountVisual,
  figureOf,
  railOf,
  ringFlags,
  ringVisual,
} from './visual';
import type { AmountVisual } from './visual';

/**
 * What the list tells the rows it draws: whether a payment has been shown
 * before, so only a new one arrives with a fade, and that rows here register
 * where they are, for a detail to grow out of. On the sheet, `back` is the
 * clock of the rows coming back in as the canvas returns home from Send or
 * Receive (`rowReturn`), which each row reads by its place in the list, and
 * `lifted` is the payment whose detail is open, whose row steps out at once:
 * its ring and amount are the ones flying to the detail's header (T4).
 */
export interface RowList {
  seen: (id: string) => boolean;
  back?: SharedValue<number>;
  lifted?: SharedValue<string>;
}

export const RowListContext = createContext<RowList | null>(null);

/** How far a new payment falls into place from above. */
const ARRIVE = -8;

/** The strike through a failed or expired amount draws over this long. */
const STRIKE_MS = 300;
/** The size a row's amount is set at. */
const FIGURE_SIZE = typography.row.fontSize;

const TONES: Record<AmountVisual['tone'], string> = {
  sage: palette.sage,
  cream: palette.cream,
  steam: palette.steam,
  dust: palette.dust,
};

/**
 * One payment (REDESIGN.md 6, Activity row): its ring on the left, the amount
 * and the note in the middle, and the time over the rail it took on the
 * right. The engine's title only goes to a screen reader.
 *
 * Memoized, and its `onPress` takes the row it belongs to, and where the row
 * is on screen when that can be measured, for the detail to grow out of.
 * A per-row closure is a new prop on every render of the list, which defeats
 * the memo; handing the item back lets every call site pass one stable
 * handler.
 */
export const ActivityRow = React.memo(function ActivityRowItem({
  item,
  onPress,
  hidden = false,
  unit = 'sats',
  symbol = false,
  band,
  test = false,
  index = 0,
}: {
  item: Activity;
  onPress: (item: Activity, rect?: Rect) => void;
  hidden?: boolean;
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  /** Pinned to the honey band at the top of the list, and where in it. */
  band?: Band;
  /** On a test network, whose rings are slate where they would be bloom. */
  test?: boolean;
  /** Where the row sits in the list, for the rows to stagger in by. */
  index?: number;
}) {
  const live = usePaneActive();
  const list = useContext(RowListContext);
  const ref = useRef<RowNode>(null);
  // Decided once, as the row mounts. As the canvas builds in, each row in
  // the list rises in on the rows' beat, 30ms after the one above (R-1 and
  // R-3). Otherwise only a payment the list has not shown before arrives,
  // falling into place; one scrolled back into view does not.
  const build = useBuild();
  const [entering] = useState(() =>
    list && build
      ? riseIn(
          overlap.rise,
          rowBeat(build.beats, index, Date.now() - build.began),
        )
      : list && !list.seen(item.id)
      ? riseIn(ARRIVE)
      : undefined,
  );
  // Coming back home from Send or Receive, the rows come back in one after
  // another (T1, reversed).
  const back = list?.back;
  const lifted = list?.lifted;
  const id = item.id;
  const returning = useAnimatedStyle(
    () => ({
      opacity:
        lifted && lifted.get() === id
          ? 0
          : back
          ? rowReturn(back.get(), index)
          : 1,
    }),
    [back, lifted, id, index],
  );
  useEffect(
    () => (list ? registerRow(item.id, ref) : undefined),
    [list, item.id],
  );

  const status = activityStatus(item);
  const ring = ringVisual(item);
  const look = amountVisual(item);
  const amount = figureOf(item.amountSats, unit, symbol);
  const label = hidden
    ? copy.activity.rowHidden(item.title, status)
    : look.open
    ? copy.activity.rowOpen(item.title, status)
    : copy.activity.row(item.title, item.amountSats, status);
  const value = [
    ...ringFlags(ring),
    item.description,
    dateLabel(item.timestamp),
  ]
    .filter(Boolean)
    .join(', ');

  const press = () => {
    haptics.tick();
    onPress(item, measureNode(ref.current) ?? undefined);
  };

  return (
    <Reanimated.View entering={entering}>
      <Reanimated.View style={returning}>
        <Pressable
          ref={ref}
          accessibilityRole="button"
          // Hiding the balance has to hide it from the screen reader too, or
          // the amount is simply announced out loud instead of shown.
          accessibilityLabel={label}
          accessibilityHint={copy.activity.rowHint}
          accessibilityValue={{ text: value }}
          onPress={live ? press : undefined}
          style={({ pressed }) => [
            styles.row,
            band && [styles.band, BANDS[band]],
            item.status === 'expired' && styles.expired,
            pressed && styles.pressed,
          ]}
        >
          {/* Held, the ring whispers what it shows (REDESIGN.md rule 3). */}
          <Whisper label={[status, ...ringFlags(ring)].join('. ')}>
            <StatusRing size={ROW_RING} visual={ring} test={test} />
          </Whisper>
          <View style={styles.middle}>
            {look.open ? (
              <Glyph name="infinity" size={ROW_OPEN} color={TONES[look.tone]} />
            ) : (
              <View style={styles.amount}>
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.4}
                  style={[
                    styles.figure,
                    { color: TONES[look.tone], fontWeight: look.weight },
                  ]}
                >
                  {amount.prefix ? (
                    // The payment's sign, then the bitcoin sign at its share
                    // of the line, then the figures.
                    <>
                      {hidden ? null : look.sign}
                      <InlineSign prefix={amount.prefix} size={FIGURE_SIZE} />
                      {hidden ? MASK : amount.value}
                    </>
                  ) : hidden ? (
                    MASK
                  ) : (
                    `${look.sign}${amount.value}`
                  )}
                  {/* A BTC amount's trailing zeros, in dust, as the hero. */}
                  {!hidden && amount.dim ? (
                    <Text style={styles.dim}>{amount.dim}</Text>
                  ) : null}
                  {amount.suffix ? (
                    <Text style={styles.unit}> {amount.suffix}</Text>
                  ) : null}
                </Text>
                <Strike struck={look.struck} />
              </View>
            )}
            {item.description ? (
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.4}
                style={styles.note}
              >
                {item.description}
              </Text>
            ) : null}
          </View>
          <View style={styles.side}>
            <Text maxFontSizeMultiplier={1.4} style={styles.time}>
              {timeLabel(item.timestamp)}
            </Text>
            <Glyph
              name={RAIL_GLYPH[railOf(item)]}
              size={14}
              color={palette.dust}
            />
          </View>
        </Pressable>
      </Reanimated.View>
    </Reanimated.View>
  );
});
ActivityRow.displayName = 'ActivityRow';

/**
 * A line through an amount that never moved. It draws across when a payment
 * fails or expires on screen, and is simply there for one that already had.
 */
function Strike({ struck }: { struck: boolean }) {
  const reach = useSharedValue(struck ? 1 : 0);
  useEffect(() => {
    reach.set(
      withTiming(struck ? 1 : 0, {
        duration: STRIKE_MS,
        easing: curves.standard,
      }),
    );
  }, [struck, reach]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scaleX: reach.get() }],
  }));
  return (
    <Reanimated.View pointerEvents="none" style={[styles.strike, style]} />
  );
}

const BANDS: Record<Band, ViewStyle> = {
  solo: { borderRadius: radius.md },
  start: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  middle: {},
  end: {
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
};

const styles = StyleSheet.create({
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  // The honey band runs a little wider than the rows, so what sits in it
  // still lines up with the rows below.
  band: {
    marginHorizontal: -ROW_BAND,
    paddingHorizontal: ROW_BAND,
    backgroundColor: palette.honeyWash,
  },
  expired: { opacity: EXPIRED_OPACITY },
  pressed: { backgroundColor: palette.mocha },
  middle: { flex: 1, gap: NOTE_GAP, justifyContent: 'center' },
  amount: { alignSelf: 'flex-start' },
  figure: { ...typography.row },
  dim: { color: palette.dust },
  unit: { ...typography.meta, color: palette.steam, fontWeight: '400' },
  strike: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 1.5,
    borderRadius: 1,
    backgroundColor: palette.dust,
    transformOrigin: 'left',
  },
  note: { ...typography.meta, color: palette.steam },
  side: { alignItems: 'flex-end', gap: space.xxs },
  time: { ...typography.meta, color: palette.steam },
});
