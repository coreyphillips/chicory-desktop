import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Reanimated from 'react-native-reanimated';
import type { ReceiveQuote } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { ExpiryRing } from '../../glyphs/ExpiryRing';
import { inlineAmount } from '../../glyphs/InlineAmount';
import { Whisper } from '../../glyphs/Whisper';
import { stagger } from '../../motion/presets';
import { usePaneActive } from '../../stage/panes/Pane';
import { amountIn, space, symbolBeside, type as typography } from '../../theme';
import {
  CONTROL,
  CONTROL_ROW,
  RING,
  ErrorPip,
  GlyphButton,
  WarningPips,
  turnIn,
} from './controls';
import type { Focus } from './focus';
import { useReceiveHost } from './host';
import { feeGlyph } from './model';
import type { Refused } from './model';
import { useBloom, useTestNetwork } from './tone';

/**
 * The sums' operator column, one width for "−" and "=" alike, so the values
 * after them start together (P10, 38-c3-quote).
 */
export const SIGN = 24;

/** The size the asked amount's figures are set at. */
const FIGURE = typography.amount.fontSize;
/** The size of the fee and net lines. */
const LINE = typography.line.fontSize;
/** How far the system's text size grows the asked amount. */
const FIGURE_SCALE = 1.2;

/**
 * A quote for a request (REDESIGN.md 6, Receive): the amount, what the
 * receive costs beside the glyph for how it arrives, and what is left. The
 * words for each line are its label, in the phrases the old rows used.
 *
 * The lines are a sum: a glyph column, an operator column of one width, and
 * the amounts set right in tabular figures, so they line up by place and the
 * net reads as the sum it is, as Send's review does.
 *
 * Creating the request is a tap on the control inside the quote's expiry
 * ring. When the quote runs out the control turns into refresh, which asks
 * for a new one; a stale balance holds either back, and a tap on it then
 * refreshes the wallet instead. Tapping the amount goes back to change it.
 * In the scene (`room`) the control is pinned to the bottom of the step,
 * where the amount step's Continue was, with a refusal beside it.
 */
export function QuoteStep({
  quote,
  quotedAt,
  offline,
  receivableSats,
  expired,
  busy,
  stale,
  error,
  shake,
  onCreate,
  onRequote,
  onEdit,
  onBlocked,
  onDismissRetry,
  focus,
  symbol = false,
}: {
  quote: ReceiveQuote;
  quotedAt: number;
  offline: boolean;
  receivableSats: number;
  expired: boolean;
  busy: boolean;
  stale: boolean;
  error: Refused | null;
  shake: number;
  onCreate: () => void;
  onRequote: () => void;
  onEdit: () => void;
  onBlocked: () => void;
  onDismissRetry?: () => void;
  focus: Focus;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
}) {
  const live = usePaneActive();
  const { bloom } = useBloom();
  const test = useTestNetwork();
  const { room } = useReceiveHost();
  const { fontScale } = useWindowDimensions();
  const asked = quote.amountSats
    ? amountIn(quote.amountSats, 'sats', symbol)
    : null;
  const glyph = feeGlyph({
    offline,
    feeSats: quote.feeSats,
    amountSats: quote.amountSats,
    receivableSats,
  });
  const how =
    glyph === 'moon'
      ? copy.receive.offlineOn
      : glyph === 'sprout'
      ? copy.receive.justInTime
      : '';
  const net = quote.amountSats && quote.netSats !== null ? quote.netSats : null;
  // What the fee's glyph says, heard and whispered.
  const feeWords = [copy.receive.fee(quote.feeSats), how]
    .filter(Boolean)
    .join(' ');
  return (
    <View style={[styles.quote, room !== undefined && { minHeight: room }]}>
      <View style={styles.body}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.receive.editAmount}
          accessibilityValue={{
            text: quote.amountSats
              ? copy.receive.requested(quote.amountSats)
              : copy.receive.senderChooses,
          }}
          disabled={busy}
          onPress={live ? onEdit : undefined}
          style={styles.amount}
        >
          {asked?.prefix ? (
            // The bitcoin sign as the keypad before this step drew it.
            <View style={styles.signed}>
              <Text
                style={[
                  styles.figure,
                  symbolBeside(
                    FIGURE,
                    typography.amount.lineHeight,
                    Math.min(fontScale, FIGURE_SCALE),
                  ),
                ]}
                maxFontSizeMultiplier={FIGURE_SCALE}
              >
                {asked.prefix}
              </Text>
              <Text style={styles.figure} maxFontSizeMultiplier={FIGURE_SCALE}>
                {asked.value}
              </Text>
            </View>
          ) : asked ? (
            <>
              <Text style={styles.figure} maxFontSizeMultiplier={FIGURE_SCALE}>
                {asked.value}
              </Text>
              <Text style={styles.unit} maxFontSizeMultiplier={FIGURE_SCALE}>
                {asked.suffix}
              </Text>
            </>
          ) : (
            <Glyph name="infinity" size={56} color={palette.cream} />
          )}
        </Pressable>
        {/* The lines share a glyph column, a sign column and a value
          column, as Send's review does. */}
        <View style={styles.lines}>
          <Whisper label={feeWords}>
            <Reanimated.View
              entering={stagger(1)}
              accessible
              accessibilityRole="text"
              accessibilityLabel={feeWords}
              style={styles.line}
            >
              <View style={styles.rail}>
                <Glyph name={glyph} size={20} color={bloom} />
              </View>
              <Text style={styles.sign} maxFontSizeMultiplier={1.4}>
                −
              </Text>
              <Text style={styles.value} maxFontSizeMultiplier={1.4}>
                {inlineAmount(quote.feeSats, 'sats', symbol, LINE)}
              </Text>
            </Reanimated.View>
          </Whisper>
          {net !== null ? (
            <Reanimated.View
              entering={stagger(2)}
              accessible
              accessibilityRole="text"
              accessibilityLabel={copy.receive.net(net)}
              style={styles.line}
            >
              <View style={styles.rail} />
              <Text style={styles.sign} maxFontSizeMultiplier={1.4}>
                =
              </Text>
              <Text
                style={[styles.value, styles.net]}
                maxFontSizeMultiplier={1.4}
              >
                {inlineAmount(net, 'sats', symbol, LINE)}
              </Text>
            </Reanimated.View>
          ) : null}
        </View>
        <WarningPips warnings={quote.warnings} />
      </View>
      <Reanimated.View entering={stagger(3)} style={styles.controls}>
        <View style={styles.side}>
          {onDismissRetry && (
            <GlyphButton
              glyph="close"
              label={copy.receive.dismissRetry}
              hint={copy.receive.dismissRetryHint}
              busy={busy}
              onPress={onDismissRetry}
            />
          )}
        </View>
        <View style={styles.create}>
          <View pointerEvents="none" style={styles.ring}>
            <ExpiryRing
              size={RING}
              expiresAt={quote.expiresAt}
              createdAt={quotedAt}
              test={test}
            />
          </View>
          {expired ? (
            <Reanimated.View entering={turnIn()}>
              <GlyphButton
                glyph="refresh"
                label={copy.receive.refreshQuote}
                hint={stale ? copy.receive.stale : copy.receive.quoteExpired}
                size={CONTROL}
                tone="primary"
                busy={busy}
                blocked={stale}
                shake={shake}
                onPress={onRequote}
                onBlocked={onBlocked}
                focusRef={focus}
              />
            </Reanimated.View>
          ) : (
            <GlyphButton
              glyph="qr"
              label={copy.receive.create}
              hint={stale ? copy.receive.stale : undefined}
              size={CONTROL}
              tone="primary"
              busy={busy}
              blocked={stale}
              shake={shake}
              onPress={onCreate}
              onBlocked={onBlocked}
              focusRef={focus}
            />
          )}
        </View>
        <View style={styles.side}>
          {error ? (
            <ErrorPip message={error.message} code={error.code} />
          ) : null}
        </View>
      </Reanimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  quote: { gap: space.md },
  body: { flexGrow: 1, alignItems: 'center', gap: space.md },
  amount: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
    minHeight: 56,
  },
  figure: { ...typography.amount, color: palette.cream },
  unit: { ...typography.heroUnit, color: palette.steam },
  // The bitcoin sign and the figures, with no gap between them.
  signed: { flexDirection: 'row' },
  // As wide as its widest line, and every line as wide, so each value set
  // to the right ends at one edge.
  lines: { alignItems: 'stretch', gap: space.xs },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rail: { width: 24, alignItems: 'center' },
  sign: {
    ...typography.line,
    width: SIGN,
    textAlign: 'center',
    color: palette.steam,
  },
  value: {
    ...typography.line,
    flexGrow: 1,
    textAlign: 'right',
    color: palette.steam,
  },
  net: { color: palette.cream },
  // The way on at the foot of the step, in the row every step keeps it in.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: CONTROL_ROW,
  },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  create: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: { position: 'absolute' },
});
