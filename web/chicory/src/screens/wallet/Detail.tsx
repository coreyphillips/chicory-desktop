import React, { useContext, useEffect, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import type { Activity } from '@beignet/wallet-core';
import { ReceiveReceipt } from '../../components/ReceiveReceipt';
import { ReceiveRequestDetails } from '../../components/ReceiveRequestDetails';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { CopyChip } from '../../glyphs/CopyChip';
import { InlineSign } from '../../glyphs/InlineAmount';
import { Odometer } from '../../glyphs/Odometer';
import { StatusRing } from '../../glyphs/StatusRing';
import { Whisper } from '../../glyphs/Whisper';
import { announceSafety } from '../../motion/speech';
import {
  RAIL_GLYPH,
  amountVisual,
  figureOf,
  railOf,
  ringVisual,
} from '../../scenes/activity/visual';
import type { AmountVisual, RingVisual } from '../../scenes/activity/visual';
import { feeShown, ringWords } from '../../scenes/detail/model';
import {
  DetailFlight,
  HEADER_GAP,
  HEADER_OPEN,
  HEADER_PAD,
  HEADER_RING,
  headerIn,
  lineIn,
} from '../../scenes/detail/motion';
import type { WalletAdapter } from '../../services/wallet';
import { MASK, dateLabel, space, type as typography } from '../../theme';
import type { Unit } from '../../theme';

/**
 * The lines' type grows with the system's text size up to this, as the row
 * amounts do (REDESIGN.md 3.3).
 */
const LINE_CAP = 1.4;
/** The size of a line's value, a fee among them. */
const ROW_SIZE = typography.row.fontSize;

const TONES: Record<AmountVisual['tone'], string> = {
  sage: palette.sage,
  cream: palette.cream,
  steam: palette.steam,
  dust: palette.dust,
};

/**
 * A payment's detail (REDESIGN.md 6, Detail): its ring at 96pt with the kind
 * glyph, the amount at 40pt, then a line for each thing known about it, each
 * led by a glyph (when, the rail and its fee, the note), and a chip for each
 * reference it can copy, led by the glyph of what it is, with the chip's own
 * copy glyph in it. A request's receipt and the request itself follow, in
 * the same lines: the header is the card's one ring and one amount, so the
 * receipt adds only what the header does not say. Opened from a row on the
 * canvas, the ring and the amount fly out of that row into place (T4).
 *
 * Money that came in has no fee line unless the engine says it cost
 * something: a fee of nothing, or one it could not read, means nothing on a
 * receive and read as a broken line (P10, 22-t4-detail).
 *
 * The outcome is the ring's to say: its sentence is what a screen reader
 * hears. An unknown outcome is held honey, announced assertively once the
 * card has settled, and never shown as done; so is a reused address.
 *
 * A hidden balance stays hidden here too; tapping a row must not be the way
 * around the mask. References keep showing, they are not amounts.
 */
export function DetailScreen({
  item,
  client,
  hidden = false,
  unit = 'sats',
  symbol = false,
  onRefresh,
  onBusy,
  test = false,
}: {
  item: Activity;
  client?: WalletAdapter;
  hidden?: boolean;
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  onRefresh?: () => void;
  onBusy?: (busy: boolean) => void;
  /** On a test network, whose ring is slate where it would be bloom. */
  test?: boolean;
}) {
  const words = ringWords(item);
  const visual = ringVisual(item);
  const look = amountVisual(item);
  useSafetyNotice(visual, words.label);
  const flight = useContext(DetailFlight);
  const [entering] = useState(() => headerIn(flight, item));

  const date = dateLabel(item.timestamp);
  const fee = figureOf(item.feeSats, unit, symbol);
  const feeUnknown = item.feeKnown === false;
  const feeLabel = feeUnknown
    ? copy.detail.feeUnavailable
    : hidden
    ? copy.detail.feeHidden(!!item.feeEstimated)
    : item.feeEstimated
    ? copy.detail.estimatedFee(item.feeSats)
    : copy.detail.fee(item.feeSats);
  const receipt =
    item.receiveStatus && item.receiveStatus.phase !== 'waiting'
      ? item.receiveStatus
      : null;
  const showsFee = feeShown(item);
  // A Bitcoin receipt lists its transactions with a ring that says whether
  // each has confirmed, so the payment's own txid is not drawn twice.
  const listed = new Set(
    receipt?.method === 'bitcoin'
      ? [...receipt.txids, ...(receipt.transactions ?? []).map(tx => tx.txid)]
      : [],
  );

  // Each reference once: the engine's reference is usually the txid or the
  // payment hash, which have chips of their own.
  const chips: { label: string; value: string; glyph: GlyphName }[] = [];
  if (
    item.reference &&
    item.reference !== item.txid &&
    item.reference !== item.paymentHash
  ) {
    chips.push({
      label: copy.detail.reference,
      value: item.reference,
      glyph: 'hash',
    });
  }
  for (const txid of new Set(
    item.drain?.txids ?? (item.txid ? [item.txid] : []),
  )) {
    if (!listed.has(txid))
      chips.push({
        label: copy.detail.transaction,
        value: txid,
        glyph: 'chain',
      });
  }
  if (item.paymentHash) {
    chips.push({
      label: copy.detail.paymentHash,
      value: item.paymentHash,
      glyph: 'bolt',
    });
  }
  const address = item.drain?.address ?? item.address;
  if (address) {
    chips.push({
      label: copy.detail.address,
      value: address,
      glyph: 'pin',
    });
  }

  let line = 0;
  return (
    <View style={styles.stack}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={item.title}
        style={styles.title}
      />
      <View style={styles.header}>
        {/* A safety state is announced once, by useSafetyNotice; a live
            region too would have Android read it twice. */}
        <Reanimated.View
          entering={entering.ring}
          accessible
          accessibilityRole={words.safety ? 'alert' : 'none'}
          accessibilityLabel={words.label}
          accessibilityValue={{ text: words.value }}
          accessibilityLiveRegion={words.safety ? 'none' : 'polite'}
        >
          <Whisper label={words.label}>
            <StatusRing size={HEADER_RING} visual={visual} test={test} />
          </Whisper>
        </Reanimated.View>
        {look.open ? (
          <Reanimated.View
            entering={entering.amount}
            accessible
            accessibilityLabel={copy.amount.any}
          >
            <Glyph
              name="infinity"
              size={HEADER_OPEN}
              color={TONES[look.tone]}
            />
          </Reanimated.View>
        ) : (
          <Reanimated.View entering={entering.amount}>
            <Odometer
              sats={item.amountSats}
              unit={unit}
              symbol={symbol}
              masked={hidden}
              variant="amountDetail"
              color={TONES[look.tone]}
              sign={look.sign === '+' ? '+' : look.sign === '−' ? '-' : null}
              accessibilityLabel={
                hidden
                  ? copy.detail.amountHidden
                  : copy.detail.amount(item.amountSats)
              }
            />
          </Reanimated.View>
        )}
      </View>
      <View style={styles.lines}>
        <Line index={line++} glyph="clock" label={copy.detail.date(date)}>
          <Text style={styles.value} maxFontSizeMultiplier={LINE_CAP}>
            {date}
          </Text>
        </Line>
        {showsFee ? (
          <Line
            index={line++}
            glyph={RAIL_GLYPH[railOf(item)]}
            label={feeLabel}
          >
            {feeUnknown ? (
              <Glyph name="question" size={20} color={palette.steam} />
            ) : (
              <>
                {item.feeEstimated ? (
                  <Text style={styles.value} maxFontSizeMultiplier={LINE_CAP}>
                    ≈
                  </Text>
                ) : null}
                <Text style={styles.value} maxFontSizeMultiplier={LINE_CAP}>
                  {hidden ? (
                    MASK
                  ) : fee.dim ? (
                    <>
                      {fee.value}
                      <Text style={styles.dim}>{fee.dim}</Text> {fee.suffix}
                    </>
                  ) : fee.suffix ? (
                    `${fee.value} ${fee.suffix}`
                  ) : (
                    <>
                      <InlineSign prefix={fee.prefix} size={ROW_SIZE} />
                      {fee.value}
                    </>
                  )}
                </Text>
              </>
            )}
          </Line>
        ) : null}
        {item.description ? (
          <Line
            index={line++}
            glyph="pencil"
            label={copy.detail.note(item.description)}
          >
            <Text
              style={[styles.value, styles.note]}
              maxFontSizeMultiplier={LINE_CAP}
            >
              {item.description}
            </Text>
          </Line>
        ) : null}
      </View>
      {receipt ? (
        <Reanimated.View entering={lineIn(line++)}>
          <ReceiveReceipt
            status={receipt}
            amountSats={item.receiveRequest?.amountSats ?? item.amountSats}
            hidden={hidden}
            unit={unit}
            symbol={symbol}
            bare
          />
        </Reanimated.View>
      ) : null}
      {item.receiveRequest ? (
        <Reanimated.View entering={lineIn(line++)}>
          <ReceiveRequestDetails
            item={item}
            client={client}
            onRefresh={onRefresh}
            onBusy={onBusy}
            test={test}
          />
        </Reanimated.View>
      ) : null}
      {chips.length ? (
        <Reanimated.View entering={lineIn(line++)} style={styles.chips}>
          {/* Led by a glyph for what the value is, like the lines above,
              each in a chip that hugs it and shows it copies. */}
          {chips.map(chip => (
            <View key={`${chip.label}:${chip.value}`} style={styles.line}>
              <Glyph name={chip.glyph} size={20} color={palette.dust} />
              <View style={styles.chip}>
                <CopyChip label={chip.label} value={chip.value} />
              </View>
            </View>
          ))}
        </Reanimated.View>
      ) : null}
    </View>
  );
}

/**
 * The safety states a detail can show (REDESIGN.md rule 4): an unknown
 * outcome, which must never be paid again, and a reused address, which cannot
 * tell whose coins arrived. A screen reader hears the ring's words
 * assertively whenever the detail shows one, through `announceSafety`, so
 * the canvas's focus move as the card settles does not cut them short, and
 * nothing is said if the detail closes first (REDESIGN.md 9). One that
 * begins while the detail is open is felt at once too: held for the outcome,
 * a warning for the address.
 */
function useSafetyNotice(visual: RingVisual, label: string) {
  const state =
    visual.pattern === 'held'
      ? 'held'
      : visual.glyph === 'twin'
      ? 'reused'
      : null;
  const was = useRef(state);
  useEffect(() => {
    if (!state) {
      was.current = null;
      return;
    }
    if (state !== was.current) {
      if (state === 'held') haptics.held();
      else haptics.warning();
    }
    was.current = state;
    return announceSafety(label, state);
  }, [state, label]);
}

/**
 * One thing known about the payment: a glyph for what it is, then its value.
 * A screen reader hears the words the value used to sit beside, as text:
 * set explicitly, so a view recycled from a heading never lends it that
 * role (P10, 22-t4-detail.ax, "Fee, Unavailable" read as a heading).
 */
function Line({
  index,
  glyph,
  label,
  children,
}: PropsWithChildren<{ index: number; glyph: GlyphName; label: string }>) {
  const [entering] = useState(() => lineIn(index));
  return (
    <Reanimated.View
      entering={entering}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={styles.line}
    >
      <Glyph name={glyph} size={20} color={palette.dust} />
      {children}
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.lg },
  // A point rather than nothing: a screen reader passes over an element with
  // no size at all.
  title: { position: 'absolute', top: 0, left: 0, width: 1, height: 1 },
  // The flight out of a row lands the ring and the amount where these put
  // them (HEADER_TOPS), so they are the motion's to set.
  header: { alignItems: 'center', gap: HEADER_GAP, paddingTop: HEADER_PAD },
  lines: { gap: space.xs },
  line: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  value: { ...typography.row, color: palette.cream },
  note: { flex: 1, color: palette.steam },
  dim: { color: palette.dust },
  chips: { gap: space.xs },
  // Its content's width, and no wider than the line leaves it.
  chip: { flexShrink: 1 },
});
