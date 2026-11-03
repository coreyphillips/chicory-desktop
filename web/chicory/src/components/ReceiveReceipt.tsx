import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import type { ReceiveStatus } from '@beignet/wallet-core';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import { palette } from '../design/palette';
import { PETAL_ART } from '../glyphs/Bloom';
import { CopyChip } from '../glyphs/CopyChip';
import { Odometer } from '../glyphs/Odometer';
import { curves } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { DrawnArc, DrawnGlyph } from '../scenes/receive/draw';
import type { Focus } from '../scenes/receive/focus';
import { Spin } from '../scenes/receive/loops';
import {
  BLOOM_SPAN,
  CELEBRATION,
  PETALS,
  PETAL_REACH,
  PETAL_ROOT,
  bloomPetalPose,
  receiptRing,
  receiptTransactions,
} from '../scenes/receive/model';
import { useBloom } from '../scenes/receive/tone';
import { useFlashTint } from '../stage/StageContext';
import { space } from '../theme';
import type { Unit } from '../theme';

/**
 * The mark a receipt lands on, Send's result's size (REDESIGN.md 5 and 6),
 * which a paid code's card contracts into.
 */
export const RECEIPT_MARK = 120;

/**
 * What arrived for a request (REDESIGN.md 5 and 6): a mark that is a cream
 * disc with an ink check and a sage rim when the payment is complete, as
 * Send's done disc is, a sage arc of what arrived over what was asked when
 * only part of it has, and an orbit while it confirms on chain; the amount
 * that arrived under it; and for a Bitcoin receipt, each transaction as a
 * chip with a small ring that closes once it confirms.
 *
 * `room` is the square the request's code filled: the mark sits at its
 * centre, where the code's card lands, with the amount under it.
 *
 * `celebrate` plays the arrival the first time it is seen: the ring draws,
 * the amount counts up, and a completed payment draws its check and opens
 * the bloom's petals round the mark as the ground behind the canvas flashes
 * sage (REDESIGN.md 3.2, G3), which fold back into the ring once the amount
 * has counted up. The words are in its label, masked like the amounts when
 * `hidden`.
 *
 * A payment's detail keeps the receipt `bare`: its header already draws the
 * ring and the amount, so a second ring and a second amount would give the
 * card two focal points (P10, 22-t4-detail). Bare, it keeps only what the
 * header does not say: what arrived over what was asked while only part of
 * it has, and each Bitcoin transaction with its own ring, led in the
 * detail's glyph column.
 */
export function ReceiveReceipt({
  status,
  amountSats,
  hidden = false,
  unit = 'sats',
  symbol = false,
  celebrate = false,
  bare = false,
  size = 96,
  room,
  focusRef,
}: {
  status: ReceiveStatus;
  amountSats: number | null;
  hidden?: boolean;
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  /** Plays the arrival, where the request's code was. */
  celebrate?: boolean;
  /** No ring and no amount of its own, under a header that has them. */
  bare?: boolean;
  /** The mark's size. */
  size?: number;
  /** The square the request's code filled, whose centre the mark takes. */
  room?: number;
  /** Where a screen reader's focus is sent to hear what arrived. */
  focusRef?: Focus;
}) {
  const { reduced } = useMotionPrefs();
  const play = celebrate && !reduced;
  const ring = receiptRing(status, amountSats);
  const completed = status.phase === 'completed';
  const partial = status.phase === 'partial';
  const said = (value: number) =>
    hidden ? copy.amount.hidden : copy.amount.spoken(value);

  const title = completed
    ? copy.receive.received
    : partial
    ? copy.receive.partial
    : copy.receive.detected;
  const detail = completed
    ? copy.receive.receivedSats(said(status.receivedSats))
    : partial
    ? amountSats != null
      ? copy.receive.partialSplit(said(status.receivedSats), said(amountSats))
      : copy.receive.partialSoFar(said(status.receivedSats))
    : copy.receive.confirming;
  const summary = [title, detail, partial ? copy.receive.partialCheck : '']
    .filter(Boolean)
    .join(' ');
  const bitcoin = status.method === 'bitcoin';

  // The sage flash is a colour, so it plays under Reduce Motion too, at once
  // rather than with the burst it would have joined.
  const flash = useFlashTint();
  useEffect(() => {
    if (!celebrate || !completed) return;
    const timer = setTimeout(
      () => flash('sage'),
      play ? CELEBRATION.tint.delay : 0,
    );
    return () => clearTimeout(timer);
  }, [celebrate, completed, play, flash]);

  // The amount counts up from nothing once the ring has started to draw.
  const [counted, setCounted] = useState(play ? 0 : status.receivedSats);
  useEffect(() => {
    if (!play) {
      setCounted(status.receivedSats);
      return;
    }
    const timer = setTimeout(
      () => setCounted(status.receivedSats),
      CELEBRATION.count.delay,
    );
    return () => clearTimeout(timer);
  }, [play, status.receivedSats]);

  const transactions = bitcoin
    ? receiptTransactions(status).map(({ txid, confirmed }) => (
        <View key={txid} style={[styles.tx, bare && styles.led]}>
          <View style={bare ? styles.lead : undefined}>
            <TxRing confirmed={confirmed} />
          </View>
          <View style={styles.chip}>
            <CopyChip label={copy.receive.transaction} value={txid} />
          </View>
        </View>
      ))
    : null;

  if (bare) {
    const split = partial && amountSats != null;
    return (
      <View style={styles.bare}>
        {split ? (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={summary}
            accessibilityValue={
              bitcoin
                ? {
                    text: copy.receive.breakdown(
                      said(status.receivedSats),
                      said(status.confirmedSats),
                      said(status.pendingSats),
                    ),
                  }
                : undefined
            }
            style={styles.led}
          >
            <View style={styles.lead}>
              <Glyph name="receive" size={20} color={palette.dust} />
            </View>
            <Odometer
              sats={status.receivedSats}
              unit={unit}
              symbol={symbol}
              masked={hidden}
              variant="line"
              color={palette.sage}
              sign="+"
            />
            <View style={styles.slash} />
            <Odometer
              sats={amountSats}
              unit={unit}
              symbol={symbol}
              masked={hidden}
              variant="line"
              color={palette.steam}
            />
          </View>
        ) : null}
        {transactions}
      </View>
    );
  }

  return (
    // Where it celebrates, Receive says what arrived itself.
    <View
      accessibilityLiveRegion={celebrate ? 'none' : 'polite'}
      style={styles.stack}
    >
      <View
        ref={focusRef}
        accessible
        accessibilityLabel={summary}
        accessibilityValue={
          bitcoin
            ? {
                text: copy.receive.breakdown(
                  said(status.receivedSats),
                  said(status.confirmedSats),
                  said(status.pendingSats),
                ),
              }
            : undefined
        }
        style={[
          styles.head,
          celebrate && styles.crowned,
          room !== undefined && {
            minHeight: room,
            paddingTop: Math.max(0, (room - size) / 2),
          },
        ]}
      >
        <Ring
          size={size}
          kind={ring.kind}
          share={ring.share}
          completed={completed}
          center={bitcoin ? 'chain' : 'bolt'}
          play={play}
        />
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.amount}
        >
          <Odometer
            sats={counted}
            unit={unit}
            symbol={symbol}
            masked={hidden}
            variant={celebrate ? 'amount' : 'line'}
            color={completed ? palette.sage : palette.cream}
            sign="+"
            duration={play ? CELEBRATION.count.duration : undefined}
          />
          {partial && amountSats != null ? (
            <View style={styles.of}>
              <View style={styles.rule} />
              <Odometer
                sats={amountSats}
                unit={unit}
                symbol={symbol}
                masked={hidden}
                variant="line"
                color={palette.steam}
              />
            </View>
          ) : null}
        </View>
      </View>
      {transactions}
    </View>
  );
}

/** The mark's rim: Send's 5 on its 120pt mark, and in step with it smaller. */
const rimOf = (size: number) => Math.max(2.5, Math.round((size / 24) * 2) / 2);

function Ring({
  size,
  kind,
  share,
  completed,
  center,
  play,
}: {
  size: number;
  kind: 'full' | 'split' | 'orbit';
  share: number;
  completed: boolean;
  center: 'chain' | 'bolt';
  play: boolean;
}) {
  const arc = useSharedValue(play ? 0 : share);
  const check = useSharedValue(!play && completed ? 1 : 0);
  // The bloom's clock, in ms from its first petal: each petal reads its own
  // pose from it (`bloomPetalPose`).
  const bloom = useSharedValue(0);
  // The husk track stays out of sight while the code implodes under it.
  const track = useSharedValue(play ? 0 : 1);
  const first = useRef(true);
  useEffect(() => {
    if (!play) {
      track.set(1);
      return;
    }
    const { track: beat } = CELEBRATION;
    track.set(
      withDelay(
        beat.delay,
        withTiming(1, { duration: beat.duration, easing: curves.enter }),
      ),
    );
    return () => cancelAnimation(track);
  }, [play, track]);
  const trackStyle = useAnimatedStyle(() => ({ opacity: track.get() }));
  useEffect(() => {
    const delay = first.current ? CELEBRATION.ring.delay : 0;
    first.current = false;
    arc.set(
      play
        ? withDelay(
            delay,
            withTiming(share, {
              duration: CELEBRATION.ring.duration,
              easing: curves.enter,
            }),
          )
        : share,
    );
    return () => cancelAnimation(arc);
  }, [arc, share, play]);
  useEffect(() => {
    if (!completed) {
      check.set(0);
      return;
    }
    if (!play) {
      check.set(1);
      return;
    }
    const { check: drawn, bloom: petals } = CELEBRATION;
    check.set(
      withDelay(
        drawn.delay,
        withTiming(1, { duration: drawn.duration, easing: curves.enter }),
      ),
    );
    bloom.set(0);
    bloom.set(
      withDelay(
        petals.delay,
        withTiming(BLOOM_SPAN, { duration: BLOOM_SPAN, easing: curves.linear }),
      ),
    );
    return () => {
      cancelAnimation(check);
      cancelAnimation(bloom);
    };
  }, [completed, play, check, bloom]);

  const stroke = rimOf(size);
  const c = size / 2;
  // On the mark's edge, as Send's result ring is and the sage arc is.
  const r = c - stroke / 2;
  const around = 2 * Math.PI * r;
  // Send's check is 56 on its 120pt disc; the other glyphs a little less.
  const glyph = Math.round(size * (completed ? 0.47 : 0.37));
  const box = { width: size, height: size };
  const sage = (
    <DrawnArc size={size} stroke={stroke} color={palette.sage} share={arc} />
  );
  return (
    <View style={box}>
      {/* Done, it is Send's done disc, cream with an ink check, rimmed in
          sage for money that came in. It is there from the start, under the
          code's card, which lands on it and hands over (P10, 42-c3). */}
      {completed ? (
        <View
          testID="receipt-disc"
          style={[styles.disc, { borderRadius: size / 2 }]}
        />
      ) : null}
      {/* The disc is its own ground when done; a husk track under the rim
          would read as a dark outline on the cream while the rim draws. */}
      {completed ? null : (
        <Reanimated.View
          testID="receipt-track"
          style={[StyleSheet.absoluteFill, trackStyle]}
        >
          <Svg width={size} height={size}>
            <Circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={palette.husk}
              strokeWidth={stroke}
            />
          </Svg>
        </Reanimated.View>
      )}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        {kind === 'split' ? (
          <Circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={palette.honey}
            strokeWidth={stroke}
            strokeDasharray={[stroke * 1.2, stroke * 2]}
            strokeDashoffset={-around * share}
            transform={`rotate(-90 ${c} ${c})`}
          />
        ) : null}
        {kind === 'orbit' ? null : sage}
      </Svg>
      {kind === 'orbit' ? (
        <Spin style={StyleSheet.absoluteFill}>
          <Svg width={size} height={size}>
            {sage}
          </Svg>
        </Spin>
      ) : null}
      {/* Over the rim and under the check, as a flower's petals are. */}
      {play && completed ? <Petals size={size} progress={bloom} /> : null}
      <View style={styles.center}>
        {completed ? (
          <DrawnGlyph
            name="check"
            size={glyph}
            color={palette.ink}
            progress={check}
          />
        ) : (
          <Glyph
            name={kind === 'split' ? 'receive' : center}
            size={glyph}
            color={kind === 'split' ? palette.honey : palette.sage}
          />
        )}
      </View>
    </View>
  );
}

/** The petal's drawing, from its base to its tip, in the bloom's units. */
const PETAL_SPAN = PETAL_ART.tip - PETAL_ART.base;

/**
 * The bloom's twelve petals round the mark (REDESIGN.md 5, Received
 * celebration): the flower's own fringed petals, each rooted just inside
 * the rim and reaching PETAL_REACH past it, in bloomHi or slate on a test
 * network, opening in turn round the ring and folding back on `progress`,
 * the bloom's clock.
 */
function Petals({
  size,
  progress,
}: {
  size: number;
  progress: SharedValue<number>;
}) {
  const { hi } = useBloom();
  return (
    <View pointerEvents="none" style={styles.petals}>
      {Array.from({ length: PETALS }, (_, i) => (
        <Petal key={i} index={i} size={size} progress={progress} color={hi} />
      ))}
    </View>
  );
}

/**
 * One petal: a still drawing in a box whose bottom centre sits on the
 * mark's centre, which is where every transform turns about. It is scaled
 * along its length from its base, carried out to the rim, and turned round
 * the centre to its angle, so it grows out of the rim rather than from a
 * point in the air.
 */
function Petal({
  index,
  size,
  progress,
  color,
}: {
  index: number;
  size: number;
  progress: SharedValue<number>;
  color: string;
}) {
  const c = size / 2;
  const height = PETAL_REACH + PETAL_ROOT;
  const width = (PETAL_ART.width / PETAL_SPAN) * height;
  const style = useAnimatedStyle(() => {
    const pose = bloomPetalPose(index, progress.get());
    return {
      opacity: pose.opacity,
      transform: [
        { rotate: `${pose.rotate}deg` },
        { translateY: -(c - PETAL_ROOT) },
        { scaleY: pose.open * pose.length },
      ],
    };
  });
  return (
    <Reanimated.View
      style={[
        styles.petal,
        { left: c - width / 2, top: c - height, width, height },
        style,
      ]}
    >
      <Svg
        width={width}
        height={height}
        viewBox={`${-PETAL_ART.width / 2} ${-PETAL_ART.tip} ${
          PETAL_ART.width
        } ${PETAL_SPAN}`}
      >
        <Path d={PETAL_ART.small} fill={color} />
      </Svg>
    </Reanimated.View>
  );
}

/** A transaction's own ring, 16pt: closed once confirmed, orbiting until. */
function TxRing({ confirmed }: { confirmed: boolean }) {
  const size = 16;
  const stroke = 2;
  const r = size / 2 - stroke;
  const around = 2 * Math.PI * r;
  const circle = (
    <Circle
      cx={size / 2}
      cy={size / 2}
      r={r}
      fill="none"
      stroke={palette.sage}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeDasharray={confirmed ? undefined : [around / 4, around]}
    />
  );
  return (
    <View
      accessible
      accessibilityLabel={
        confirmed ? copy.receive.txConfirmed : copy.receive.txConfirming
      }
      style={styles.txRing}
    >
      {confirmed ? (
        <Svg width={size} height={size}>
          {circle}
        </Svg>
      ) : (
        <Spin>
          <Svg width={size} height={size}>
            {circle}
          </Svg>
        </Spin>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md, alignItems: 'center', alignSelf: 'stretch' },
  head: { alignItems: 'center', gap: space.md },
  // Room under the mark for the petals that crown it as it celebrates.
  crowned: { gap: space.xxl },
  amount: { alignItems: 'center', gap: space.xxs },
  of: { alignItems: 'center', gap: space.xxs },
  rule: { width: 48, height: 1, backgroundColor: palette.husk },
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  petals: { ...StyleSheet.absoluteFill, overflow: 'visible' },
  petal: { position: 'absolute', transformOrigin: '50% 100%' },
  disc: { ...StyleSheet.absoluteFill, backgroundColor: palette.cream },
  tx: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: '100%',
  },
  txRing: { width: 16, height: 16 },
  chip: { flexShrink: 1 },
  // Bare, in a payment's detail: its lines start at the detail's edge, each
  // led by a glyph in the detail's 20pt column, as its other lines are.
  bare: { alignSelf: 'stretch', gap: space.xs },
  led: {
    alignSelf: 'stretch',
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  lead: { width: 20, alignItems: 'center' },
  // What arrived over what was asked, as a fraction's stroke.
  slash: {
    width: 1,
    height: 16,
    backgroundColor: palette.husk,
    transform: [{ rotate: '20deg' }],
  },
});
