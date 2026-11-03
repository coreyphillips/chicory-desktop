import React, { useEffect } from 'react';
import type { ComponentRef, Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryExitAnimationFunction,
  SharedValue,
} from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { ExpiryRing } from '../../glyphs/ExpiryRing';
import { HoldButton } from '../../glyphs/HoldButton';
import { curves, durations } from '../../motion/tokens';
import { useNow } from '../../services/clock';
import { CONTROL, CircleControl, QuoteRefresh } from './Controls';
import { useTestNetwork } from './tone';

/** The ring round the hold, at r+8 from the control (REDESIGN.md 5). */
const RING = CONTROL + 16;

/**
 * The quote's ring leaving as the payment's render lets it go: from where
 * the commit's fade has taken it, which is gone by then on a phone, on to
 * gone within a tick, so it never comes back to be faded again.
 */
function ringOut(commit: SharedValue<number>): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const shown = 1 - commit.get();
    return {
      initialValues: { opacity: shown },
      animations: {
        opacity: withTiming(0, {
          duration: durations.tick * shown,
          easing: curves.standard,
          reduceMotion: ReduceMotion.Never,
        }),
      },
    };
  };
}

/**
 * Where a review is committed (REDESIGN.md 5 and 6, Send): the hold inside
 * the quote's ring. The ring stays through the quote running out, so it
 * retracts round the refresh that takes the hold's place. While the balance
 * is too old to spend against, the hold gives way to a dust control whose
 * tap shakes and refreshes the balance instead.
 *
 * Once the hold commits the quote is used: its ring fades away as the flash
 * rises, on the UI thread with the hold, rather than once the payment's
 * render comes (`spent`), and nothing it could say applies to the payment
 * any more, so the hold stays, with its orbit, whatever the quote's clock
 * or the balance's age would have made of it. Money is going out. The
 * comet that says so turns on `comet` where the screen keeps that clock,
 * so a result's mark carries it on (REDESIGN.md 7, T7).
 *
 * A screen reader commits the hold with one action, so the hold says the
 * whole review with it: `summary`, the total, the fee and every engine
 * warning, and then the time the quote has left, which the ring shows and
 * does not say. Handlers are given only while a tap does something, as the
 * controls on the canvas take them. `ref` is whichever control is shown, for
 * the screen to move a screen reader to it.
 */
export function Commit({
  accessibilityLabel,
  summary,
  expiresAt,
  createdAt,
  warning,
  expired,
  stale,
  busy,
  spent = false,
  auto = false,
  comet,
  onCommit,
  onRefreshQuote,
  onRefresh,
  ref,
}: {
  accessibilityLabel: string;
  summary: string;
  expiresAt: number;
  createdAt: number;
  warning: boolean;
  expired: boolean;
  stale: boolean;
  busy: boolean;
  /** The hold has committed: the payment is going out on this quote. */
  spent?: boolean;
  /**
   * Settings > Auto-pay committed it, with no hold: the hold plays its
   * complete for the payer as the payment goes out.
   */
  auto?: boolean;
  /** The clock the hold's comet turns on, where the screen keeps one. */
  comet?: SharedValue<number>;
  onCommit: () => void;
  onRefreshQuote?: () => void;
  onRefresh?: () => void;
  ref?: Ref<ComponentRef<typeof View>>;
}) {
  const test = useTestNetwork();
  // How far the hold's commit has taken the quote's ring away. A quote
  // that turns out not to be spent after all, refused as it was sent or
  // run out as the hold completed, brings its ring back.
  const commit = useSharedValue(0);
  useEffect(() => {
    if (!spent) commit.set(0);
  }, [spent, expired, commit]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: 1 - commit.get() }));
  const refresh = expired && !spent;
  const gated = stale && !spent && !refresh;
  // Only the words need the second: the ring runs down on its own timing.
  const now = useNow(1000, !expired && !stale && !spent);
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return (
    <View style={styles.commit}>
      {spent ? null : (
        <Reanimated.View
          exiting={ringOut(commit)}
          pointerEvents="none"
          style={[styles.ring, ringStyle]}
        >
          <ExpiryRing
            size={RING}
            expiresAt={expiresAt}
            createdAt={createdAt}
            test={test}
          />
        </Reanimated.View>
      )}
      <View style={styles.control}>
        {refresh ? (
          <QuoteRefresh ref={ref} onPress={onRefreshQuote} busy={busy} />
        ) : gated ? (
          <CircleControl
            ref={ref}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={copy.send.stale}
            onPress={onRefresh}
            stale
          />
        ) : (
          <HoldButton
            ref={ref}
            accessibilityLabel={accessibilityLabel}
            accessibilityValue={{
              text: spent
                ? summary
                : `${summary} ${copy.send.quoteExpires(left)}`,
            }}
            onCommit={onCommit}
            warning={warning}
            busy={busy || spent}
            auto={auto}
            test={test}
            commit={commit}
            comet={comet}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  commit: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: { position: 'absolute', top: 0, left: 0 },
  control: { position: 'absolute' },
});
