import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Activity } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { DetailScreen } from '../../screens/wallet/Detail';
import type { RegionProps } from '../../stage/Canvas';
import { DetailCard, DetailReturn } from '../../stage/layers/DetailCard';
import { usePanes } from '../../stage/panes/Pane';
import { SceneSlot } from '../../stage/panes/SceneSlot';
import type { Rect } from '../../stage/scene';
import { useStage } from '../../stage/StageContext';
import { measureRow } from '../activity/rowRects';
import { DETAIL_DROP } from '../activity/sheet';
import { isTestNetwork } from '../home/visual';
import { DetailFlight } from './motion';

/**
 * A payment's detail, in the slot the canvas keeps at the sheet's compact
 * stop. `item` is the live payment, so a status that changes while it is
 * open changes here too; `from` is the tapped row, for the card to grow out
 * of.
 *
 * Grown out of a row, the card carries the header's ring and amount out of
 * it too, from where the row drew them. It folds back into its row when it
 * closes onto the list it came from, which stays at this stop. Back to home
 * the list is on its way down, so the card fades instead. While it is open a
 * poll can move the row, so it is found again whenever the history changes.
 */
export function DetailLayer({
  item,
  from,
  snapshot,
  client,
  view,
  session,
  browserFrame,
  browserSidebar = false,
}: RegionProps & {
  item: Activity;
  from: Rect | null;
  browserFrame?: { x: number; y: number; width: number };
  browserSidebar?: boolean;
}) {
  const { state, actions } = useStage();
  const panes = usePanes();
  const { top, bottom, left, right } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const below = state.stack[state.stack.length - 1]?.name;
  const returns = below === 'activity' || browserSidebar;
  const back = useSharedValue<Rect | null>(returns ? from : null);
  // The canvas keeps this slot at the compact stop, and narrows the canvas
  // only for a side cutout, which is where the card comes to rest. Read
  // once, as the card opens: it grows from here and folds back from here.
  const [nativeCard] = useState(() => ({
    x: left,
    y: panes.stops.compact,
    width: width - left - right,
  }));
  const card = browserFrame ?? nativeCard;
  const place = useMemo(() => ({ card, back }), [card, back]);
  const flight = useMemo(() => (from ? { from, card } : null), [from, card]);

  const opened = useRef(snapshot.activity);
  const lastFrame = useRef(card);
  useEffect(() => {
    if (!returns) {
      back.set(null);
      return;
    }
    // The first answer is the rect the row was tapped at.
    if (opened.current === snapshot.activity && lastFrame.current.x === card.x && lastFrame.current.y === card.y && lastFrame.current.width === card.width) return;
    opened.current = snapshot.activity;
    lastFrame.current = card;
    // The rows under a detail sit a little lower, and come back up as it
    // closes.
    const rect = measureRow(item.id);
    back.set(rect && { ...rect, y: rect.y - (browserFrame ? 0 : DETAIL_DROP) });
  }, [returns, snapshot.activity, item.id, back, browserFrame, card]);

  return (
    <DetailReturn value={place}>
      <DetailFlight value={flight}>
        <DetailCard item={item} from={from}>
          <SceneSlot
            label={copy.scene.detail}
            offset={panes.stops.compact - top}
          >
            <DetailScreen
              item={item}
              client={client}
              hidden={view.hidden}
              unit={view.unit}
              symbol={view.symbol}
              onRefresh={session.refresh}
              onBusy={actions.setBusy}
              test={isTestNetwork(snapshot.wallet.network)}
            />
            {/* The canvas runs under the system bars; the end of the detail
                stays clear of them. */}
            <View style={{ height: bottom }} />
          </SceneSlot>
        </DetailCard>
      </DetailFlight>
    </DetailReturn>
  );
}
