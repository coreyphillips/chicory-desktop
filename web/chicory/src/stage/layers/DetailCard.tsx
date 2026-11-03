import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import type { Activity } from '@beignet/wallet-core';
import { palette } from '../../design/palette';
import {
  CARD_RADIUS,
  collapseTo,
  expandFrom,
} from '../../scenes/detail/motion';
import type { CardRest } from '../../scenes/detail/motion';
import { sceneOut } from '../../motion/presets';
import { curves, durations } from '../../motion/tokens';
import { motionReduced } from '../../services/motion';
import type { Rect } from '../scene';

/**
 * Where a card rests, and where a closing card goes back to: `card`, the
 * slot the canvas keeps for it, in window coordinates, and `back`, the row it
 * came from, or null to fade. The detail's layer keeps `back` current and
 * gives both here; a card drawn without them fades in and out.
 */
export interface DetailPlace {
  card: CardRest;
  back: SharedValue<Rect | null>;
}

export const DetailReturn = createContext<DetailPlace | null>(null);

/**
 * How long a card's ground takes to come up as it grows out of its row:
 * the time the other rows take to fade out and drop (REDESIGN.md 7, T4).
 */
export const GROUND_MS = durations.exit;

/**
 * A payment's detail, as a card on the sheet at its compact stop (REDESIGN.md
 * 7, T4). The canvas places it and keys it by scene, so each open is a new
 * card; `children` are laid out from its top edge.
 *
 * `from` is the tapped row's rect in window coordinates, when it could be
 * measured: the card grows out of it, its corners opening from a row's to a
 * pane's over 320ms, while what it holds stays laid out at its final size
 * and is uncovered as it grows. Its ground comes up over the first 140ms, as
 * the rows around the tapped one fade and drop, so they are seen to go
 * rather than swept away under its edges. Leaving, it folds back into the
 * row it came from while that row is where it was, and otherwise fades.
 * Without a rect, and under Reduce Motion, it only fades.
 */
export function DetailCard({
  from,
  children,
}: PropsWithChildren<{ item: Activity; from: Rect | null }>) {
  const place = useContext(DetailReturn);
  // Read once, as the card mounts: these only ever run at its two ends.
  const [grows] = useState(() => !!from && !!place && !motionReduced());
  const [entering] = useState(() => expandFrom(from, place?.card ?? null));
  const exiting = useMemo(() =>
    place ? collapseTo(place.back, place.card) : sceneOut(),
    [place?.back, place?.card],
  );
  const ground = useSharedValue(grows ? 0 : 1);
  useEffect(() => {
    if (!grows) return;
    ground.set(withTiming(1, { duration: GROUND_MS, easing: curves.standard }));
  }, [grows, ground]);
  const groundStyle = useAnimatedStyle(() => ({ opacity: ground.get() }));
  return (
    <Reanimated.View entering={entering} exiting={exiting} style={styles.card}>
      <Reanimated.View
        pointerEvents="none"
        style={[styles.ground, groundStyle]}
      />
      {children}
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    overflow: 'hidden',
    borderRadius: CARD_RADIUS,
  },
  ground: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.espresso,
  },
});
