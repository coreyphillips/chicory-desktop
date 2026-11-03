import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { ReceiveRequest, ReceiveStatus } from '@beignet/wallet-core';
import { RECEIPT_MARK, ReceiveReceipt } from '../../components/ReceiveReceipt';
import { copy } from '../../design/copy';
import { Glyph, HISTORY_GLYPH } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { palette } from '../../design/palette';
import { ExpiryRing } from '../../glyphs/ExpiryRing';
import { inlineAmount } from '../../glyphs/InlineAmount';
import { QR_SETTLED, QrBloom } from '../../glyphs/QrBloom';
import { Whisper } from '../../glyphs/Whisper';
import { dissolve } from '../../motion/effects';
import {
  dropOut,
  fadeOut,
  riseIn,
  smooth,
  stagger,
} from '../../motion/presets';
import { curves } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { MASK, radius, space, type as typography } from '../../theme';
import type { Unit } from '../../theme';
import {
  CONTROL_ROW,
  ErrorPip,
  GlyphButton,
  TARGET,
  WarningPips,
} from './controls';
import type { Focus } from './focus';
import { useReceiveHost } from './host';
import { ListeningPing } from './ListeningPing';
import { Rock } from './loops';
import type { Refused, RequestFace } from './model';
import { useBloom, useTestNetwork } from './tone';
import { lateAt, remainderSats, requestRails } from './model';

/**
 * The glyph of the way to the payment list from a receipt, the one Send's
 * results draw too (`HISTORY_GLYPH`). The orbit is money in flight
 * (REDESIGN.md 6), so under a done mark it would read as still on its way.
 */
export const ACTIVITY: GlyphName = HISTORY_GLYPH;

/** The expiry ring runs this far outside the card. */
export const RING_GAP = 8;

/** A request's frame for a code's card `qr` points across. */
export const frameSide = (qr: number) => qr + RING_GAP * 2;

/** The size of the amount lines, the request's and what is still owed. */
const LINE = typography.line.fontSize;

/**
 * A request and what becomes of it (REDESIGN.md 6, Receive). The code
 * blooms in a frame whose ring runs down to the request's expiry, turning
 * honey near the end; under it the amount or an infinity, the note, and how
 * it can be paid, with a rocking moon when it is payable offline. While the
 * code can be paid and is not lifted, once it has bloomed in, the frame
 * listens: a ping sets out from it every 2400ms (REDESIGN.md 5, Listening
 * ping), behind the ring and clear of the code.
 *
 * An expired request dissolves and a reused address scatters, and either
 * way share and copy go, leaving plus as the way on. Money arriving implodes
 * the code, its cream card contracting and rounding onto the receipt's
 * 120pt mark at the code's centre, Send's done disc, with the amount under
 * it (P10, 42-c3: the code had faded as a flat taupe square onto a 275pt
 * ring). The mark is under the card, so the card lands on it and hands over.
 * The controls hand over by the overlap rule (REDESIGN.md 3.5): what the
 * request said of itself drops out, share and copy dissolve as a pair, the
 * history control rises in and plus crossfades to the way on, the row
 * gliding as it centres again, rather than each cutting to the next.
 *
 * In the scene (`room`) the controls are pinned to the bottom of the step,
 * in the row the amount and the quote keep theirs in, so the thumb stays
 * where it was from step to step; a refusal sits beside them.
 */
export function RequestStep({
  request,
  createdAt,
  face,
  minutesLeft,
  receipt,
  trackingError,
  hidden,
  unit,
  symbol = false,
  qr,
  error,
  onLift,
  onCopy,
  copies,
  onShare,
  onAgain,
  onActivity,
  focus,
  qrFocus,
  lifted = false,
}: {
  request: ReceiveRequest;
  createdAt: number;
  face: RequestFace;
  minutesLeft: number;
  receipt: ReceiveStatus | null;
  /** Why the request's status cannot be read, when it cannot. */
  trackingError?: string;
  hidden: boolean;
  unit: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  /** How wide the code's card is drawn, its quiet zone included. */
  qr: number;
  error: Refused | null;
  onLift: () => void;
  onCopy: () => void;
  /** How many times the request has been copied, for the copy control's check. */
  copies: number;
  onShare: () => void;
  onAgain: () => void;
  onActivity: () => void;
  /** Takes what the request now says: the receipt, a safety state, or itself. */
  focus: Focus;
  /** The code, where a screen reader goes back to as a lifted code is set down. */
  qrFocus?: Focus;
  /** The code is lifted over the step, so the frame here is not the one seen. */
  lifted?: boolean;
}) {
  const test = useTestNetwork();
  const { room } = useReceiveHost();
  const side = frameSide(qr);
  // The frame listens once the code has bloomed in, and for as long as the
  // code shown can be paid and is not lifted away from it.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), QR_SETTLED);
    return () => clearTimeout(timer);
  }, [request.uri]);
  const listening = face.shareable && !lifted && settled;
  const remainder = remainderSats(request.amountSats, receipt);
  const scattered = face.qr === 'scattered';
  const status =
    face.qr === 'expired'
      ? copy.receive.expired
      : scattered
      ? `${copy.receive.reused} ${copy.receive.reusedShare}`
      : null;
  return (
    <View style={[styles.request, room !== undefined && { minHeight: room }]}>
      <View style={styles.body}>
        <View style={styles.stage}>
          {/* Under the code, so the card lands on the mark and hands over. The
            keys keep the code the same code as the receipt arrives before
            it, so it implodes rather than mounting again. */}
          {receipt ? (
            <ReceiveReceipt
              key="receipt"
              status={receipt}
              amountSats={request.amountSats}
              hidden={hidden}
              unit={unit}
              symbol={symbol}
              celebrate
              size={RECEIPT_MARK}
              room={side}
              focusRef={focus}
            />
          ) : null}
          <View
            key="code"
            pointerEvents="box-none"
            style={receipt ? styles.over : undefined}
          >
            <View style={[styles.frame, { width: side, height: side }]}>
              <ListeningPing
                side={side}
                radius={radius.qr + RING_GAP}
                running={listening}
              />
              {/* Kept through expiry, so the ring can collapse as it ends. */}
              {face.qr === 'shown' || face.qr === 'expired' ? (
                <View pointerEvents="none" style={styles.fill}>
                  <ExpiryRing
                    size={side}
                    shape="rect"
                    width={side}
                    height={side}
                    radius={radius.qr + RING_GAP}
                    expiresAt={request.expiresAt}
                    createdAt={createdAt}
                    lateAt={lateAt(createdAt, request.expiresAt)}
                    test={test}
                  />
                </View>
              ) : null}
              <QrBloom
                ref={qrFocus}
                value={request.uri}
                size={qr}
                lands={RECEIPT_MARK}
                state={face.qr}
                onPress={face.shareable ? onLift : undefined}
                onLongPress={face.shareable ? onCopy : undefined}
                accessibilityLabel={copy.receive.qr}
              />
              {status ? (
                <View
                  ref={focus}
                  accessible
                  accessibilityLabel={status}
                  accessibilityValue={
                    scattered && trackingError
                      ? { text: trackingError }
                      : undefined
                  }
                  pointerEvents="none"
                  style={styles.fill}
                />
              ) : null}
              {receipt && face.reused ? (
                <Badge
                  key="twin"
                  glyph="twin"
                  label={trackingError ?? copy.receive.reusedAddress}
                />
              ) : trackingError && !scattered ? (
                <Badge key="question" glyph="question" label={trackingError} />
              ) : null}
            </View>
          </View>
          {receipt ? null : (
            <About
              key="about"
              request={request}
              face={face}
              minutesLeft={minutesLeft}
              symbol={symbol}
              focus={status ? undefined : focus}
            />
          )}
        </View>
        {receipt || !request.warnings.length ? null : (
          <Reanimated.View key="pips" exiting={fadeOut()}>
            <WarningPips warnings={request.warnings} />
          </Reanimated.View>
        )}
      </View>
      <Reanimated.View entering={stagger(2)} style={styles.controls}>
        <View style={styles.side} />
        <View style={styles.buttons}>
          {receipt ? (
            <Reanimated.View
              key="history"
              entering={stagger(0)}
              layout={smooth()}
            >
              <GlyphButton
                glyph={ACTIVITY}
                label={copy.receive.viewActivity}
                onPress={onActivity}
              />
            </Reanimated.View>
          ) : face.shareable ? (
            <Reanimated.View
              key="share"
              exiting={dissolve()}
              layout={smooth()}
              style={styles.pair}
            >
              <GlyphButton
                glyph="share"
                label={copy.receive.share}
                onPress={onShare}
              />
              <GlyphButton
                glyph="copy"
                label={copy.receive.copy}
                confirm={copies}
                onPress={onCopy}
              />
            </Reanimated.View>
          ) : null}
          <Reanimated.View key="again" layout={smooth()}>
            <GlyphButton
              glyph="plus"
              label={
                remainder !== null
                  ? copy.receive.requestRemaining
                  : copy.receive.createAnother
              }
              tone={face.shareable && !receipt ? 'raised' : 'primary'}
              halo={scattered}
              pulse={face.qr === 'expired' ? 1 : undefined}
              value={
                remainder === null
                  ? undefined
                  : hidden
                  ? copy.amount.hidden
                  : copy.amount.spoken(remainder)
              }
              onPress={onAgain}
            >
              {/* What is owed gives away what arrived, so it hides with it. */}
              {remainder === null
                ? null
                : hidden
                ? MASK
                : inlineAmount(remainder, 'sats', symbol, LINE)}
            </GlyphButton>
          </Reanimated.View>
        </View>
        <View style={[styles.side, styles.end]}>
          {error ? (
            <ErrorPip message={error.message} code={error.code} />
          ) : null}
        </View>
      </Reanimated.View>
    </View>
  );
}

/**
 * A honey mark at the frame's corner: a question, nodding once, while the
 * request's status cannot be read, and the twin when money arrived on a
 * reused address, once the scattered code that said so has given way to the
 * receipt.
 */
function Badge({
  glyph,
  label,
}: {
  glyph: 'question' | 'twin';
  label: string;
}) {
  const { reduced } = useMotionPrefs();
  const nod = useSharedValue(0);
  const nodded = useRef(false);
  useEffect(() => {
    if (glyph !== 'question' || nodded.current || reduced) return;
    nodded.current = true;
    const step = { duration: 150, easing: curves.sine };
    nod.set(
      withSequence(
        withTiming(-12, step),
        withTiming(12, step),
        withTiming(-6, step),
        withTiming(0, step),
      ),
    );
    return () => cancelAnimation(nod);
  }, [glyph, nod, reduced]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${nod.get()}deg` }],
  }));
  return (
    <Reanimated.View
      entering={riseIn(8)}
      accessible
      accessibilityLabel={label}
      style={[styles.badge, style]}
    >
      <Whisper label={label} style={styles.whole}>
        <Glyph name={glyph} size={18} color={palette.honey} />
      </Whisper>
    </Reanimated.View>
  );
}

/** What the request is for, and how it can be paid. */
function About({
  request,
  face,
  minutesLeft,
  symbol,
  focus,
}: {
  request: ReceiveRequest;
  face: RequestFace;
  minutesLeft: number;
  symbol: boolean;
  focus?: Focus;
}) {
  const { bloom } = useBloom();
  const rails = requestRails(request);
  const how = [
    rails.length > 1 ? copy.receive.unified : copy.receive.lightningOnly,
    request.offlineReceive && !face.expired ? copy.receive.offlineRequest : '',
  ]
    .filter(Boolean)
    .join(' ');
  const left = face.expired
    ? undefined
    : [
        copy.receive.expiresIn(minutesLeft),
        face.late ? copy.receive.nearExpiry : '',
      ]
        .filter(Boolean)
        .join('. ');
  return (
    <Reanimated.View
      entering={stagger(1)}
      exiting={dropOut(8)}
      style={styles.about}
    >
      <View
        ref={focus}
        accessible
        accessibilityLabel={copy.receive.yours(
          request.amountSats
            ? copy.amount.spoken(request.amountSats)
            : copy.receive.anyAmount,
        )}
      >
        {request.amountSats ? (
          <Text style={styles.amount} maxFontSizeMultiplier={1.4}>
            {inlineAmount(request.amountSats, 'sats', symbol, LINE)}
          </Text>
        ) : (
          <Glyph name="infinity" size={28} color={palette.cream} />
        )}
      </View>
      {request.description ? (
        <Text style={styles.note} maxFontSizeMultiplier={1.4}>
          {request.description}
        </Text>
      ) : null}
      {/* A place a finger can hold to hear how it can be paid whispered,
          48pt as every target is, and text rather than a control. */}
      <Whisper label={[how, left].filter(Boolean).join('. ')}>
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={how}
          accessibilityValue={left ? { text: left } : undefined}
          style={styles.rails}
        >
          {rails.map(rail => (
            <Glyph key={rail} name={rail} size={18} color={palette.steam} />
          ))}
          {request.offlineReceive && !face.expired ? (
            <Rock>
              <Glyph name="moon" size={18} color={bloom} />
            </Rock>
          ) : null}
        </View>
      </Whisper>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  request: { gap: space.lg },
  body: { flexGrow: 1, alignItems: 'center', gap: space.lg },
  stage: { alignItems: 'center', alignSelf: 'stretch', gap: space.md },
  over: { position: 'absolute', top: 0, alignSelf: 'center' },
  frame: { alignItems: 'center', justifyContent: 'center' },
  fill: { ...StyleSheet.absoluteFill },
  badge: {
    position: 'absolute',
    top: -space.xxs,
    right: -space.xxs,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cocoa,
  },
  about: { alignItems: 'center', gap: space.xs },
  amount: { ...typography.line, color: palette.cream },
  note: { ...typography.meta, color: palette.steam, textAlign: 'center' },
  rails: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minWidth: TARGET,
    minHeight: TARGET,
    paddingHorizontal: space.xs,
  },
  // The whole badge answers a long press, not only its glyph.
  whole: {
    alignSelf: 'stretch',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The way on at the foot of the step, in the row every step keeps it in.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: CONTROL_ROW,
  },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  end: { justifyContent: 'flex-end' },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  // Share and copy, which come and go together.
  pair: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
});
