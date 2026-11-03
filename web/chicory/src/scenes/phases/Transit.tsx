import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryAnimationsValues,
  EntryExitAnimationFunction,
} from 'react-native-reanimated';
import type { Network } from '@beignet/wallet-core';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomEvent } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { useFocus } from '../../motion/focus';
import { curves, durations, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { motionReduced } from '../../services/motion';
import type { useWalletSession } from '../../services/useWalletSession';
import { PhaseRoot } from './parts';
import {
  BUD_OPEN,
  markFlight,
  markPoint,
  SIZES,
  transitVisual,
} from './visual';
import type { Point, TransitKind } from './visual';

type Session = ReturnType<typeof useWalletSession>;

/**
 * The wait while a wallet closes, is erased, or hands over to another
 * network. The wallet's mark flies from the status row to the centre and
 * grows to the loader's size (R-6), then says which it is: closing folds the
 * petals, a switch ratchets the bloom round as it recolors toward the new
 * network's tone, and erasing lets the petals fall until only a husk bud is
 * left breathing. The sentence the screen used to show is what a screen
 * reader hears, with the wait marked busy.
 */
export function Transit({
  erasing,
  closing,
  switchTarget,
  network,
}: Pick<Session, 'erasing' | 'closing' | 'switchTarget'> & {
  /** The network the wallet is on as it leaves, so a switch recolors from it. */
  network?: Network;
}) {
  const look = transitVisual({ erasing, closing, switchTarget, network });
  const insets = useSafeAreaInsets();
  const { reduced } = useMotionPrefs();
  const event = useArrivalEvent(look.kind, reduced);
  const focus = useFocus();

  // A switch recolors toward its target once the mark has landed. A colour
  // moves nothing, so under Reduce Motion it still plays, as a crossfade,
  // and still waits for the mark.
  const toward = useSharedValue(0);
  useEffect(() => {
    if (look.kind !== 'switching') return;
    toward.set(
      withDelay(
        durations.move,
        withTiming(1, {
          duration: reduced ? durations.crossfade : durations.celebrate,
          easing: curves.standard,
          reduceMotion: ReduceMotion.Never,
        }),
        ReduceMotion.Never,
      ),
    );
  }, [look.kind, toward, reduced]);
  const towardStyle = useAnimatedStyle(() => ({ opacity: toward.get() }));

  // What erasing leaves: a husk bud that surfaces as the last petals fall.
  const husk = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (look.kind !== 'erasing') return;
    husk.set(
      reduced
        ? 1
        : withDelay(
            FALL_MS,
            withTiming(1, {
              duration: durations.celebrate,
              easing: curves.enter,
            }),
          ),
    );
  }, [look.kind, reduced, husk]);
  const huskStyle = useAnimatedStyle(() => ({ opacity: husk.get() }));

  return (
    <PhaseRoot>
      <Whisper label={look.label}>
        <View
          ref={focus}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={look.label}
          accessibilityState={{ busy: true }}
        >
          <Reanimated.View
            entering={flyIn(markPoint(insets))}
            style={styles.bloom}
          >
            {look.kind === 'erasing' ? (
              <>
                {reduced ? null : (
                  <Bloom size={SIZES.loader} tone={look.from} event={event} />
                )}
                <Reanimated.View style={[styles.layer, huskStyle]}>
                  <Bloom
                    size={SIZES.loader}
                    open={BUD_OPEN}
                    tone="dormant"
                    mode="breathe"
                  />
                </Reanimated.View>
              </>
            ) : (
              <>
                <Bloom
                  size={SIZES.loader}
                  tone={look.from}
                  mode={look.mode}
                  event={event}
                />
                {look.to !== look.from ? (
                  <Reanimated.View style={[styles.layer, towardStyle]}>
                    <Bloom
                      size={SIZES.loader}
                      tone={look.to}
                      mode={look.mode}
                    />
                  </Reanimated.View>
                ) : null}
              </>
            )}
          </Reanimated.View>
        </View>
      </Whisper>
    </PhaseRoot>
  );
}

/**
 * The one-off each kind plays once the mark has landed: a fold for closing
 * and a fall for erasing. A switch has none; its ratchet is a loop. Under
 * Reduce Motion nothing falls or folds, and the husk bud simply stands.
 */
function useArrivalEvent(
  kind: TransitKind,
  reduced: boolean,
): BloomEvent | undefined {
  const [event, setEvent] = useState<BloomEvent | undefined>();
  useEffect(() => {
    const play =
      kind === 'closing' ? 'fold' : kind === 'erasing' ? 'fall' : null;
    if (!play || reduced) return;
    const landed = setTimeout(
      () => setEvent(last => ({ kind: play, key: (last?.key ?? 0) + 1 })),
      durations.move,
    );
    return () => clearTimeout(landed);
  }, [kind, reduced]);
  return event;
}

/** Twelve petals falling 60ms apart, each taking about as long as a draw. */
const FALL_MS = 11 * 60 + durations.draw;

/**
 * The mark leaving the status row: from its place and size there to the
 * centre at the loader's size, on the pane spring. Under Reduce Motion it
 * only fades in where it lands.
 */
function flyIn(mark: Point): EntryExitAnimationFunction {
  const reduced = motionReduced();
  return (values: EntryAnimationsValues) => {
    'worklet';
    if (reduced) {
      return {
        initialValues: { opacity: 0 },
        animations: {
          opacity: withTiming(1, {
            duration: durations.crossfade,
            reduceMotion: ReduceMotion.Never,
          }),
        },
      };
    }
    const flight = markFlight(
      mark,
      {
        x: values.targetGlobalOriginX + values.targetWidth / 2,
        y: values.targetGlobalOriginY + values.targetHeight / 2,
      },
      SIZES.loader,
    );
    return {
      initialValues: {
        opacity: 0,
        transform: [
          { translateX: flight.dx },
          { translateY: flight.dy },
          { scale: flight.scale },
        ],
      },
      animations: {
        opacity: withTiming(1, {
          duration: durations.enter,
          easing: curves.enter,
        }),
        transform: [
          { translateX: withSpring(0, springs.pane) },
          { translateY: withSpring(0, springs.pane) },
          { scale: withSpring(1, springs.pane) },
        ],
      },
    };
  };
}

const styles = StyleSheet.create({
  bloom: { width: SIZES.loader, height: SIZES.loader },
  layer: StyleSheet.absoluteFill,
});
