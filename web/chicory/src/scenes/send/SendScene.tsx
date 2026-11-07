import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Activity } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { SendScreen } from '../../screens/Send';
import type { SendHandle } from '../../screens/Send';
import type { RegionProps } from '../../stage/Canvas';
import { MINI_STRIP, STATUS_ROW } from '../../stage/layout';
import { Arriving } from '../../stage/panes/Arriving';
import { usePaneActive } from '../../stage/panes/Pane';
import { SceneSlot } from '../../stage/panes/SceneSlot';
import {
  useIsCurrentScene,
  useSceneBack,
  useStage,
} from '../../stage/StageContext';
import { useScanReceiver } from '../../stage/useScanReceiver';
import { isTestNetwork } from '../home/visual';
import { slotRoom } from '../receive/host';
import type { Origin } from './RequestEntry';

/**
 * Send, in the top slot under the status row and the mini strip. `prefill`
 * is the request a scanned code or a tapped link brought with the scene,
 * never sent without a review, and without a hold only when the camera read
 * it (`scanned`) and Settings > Auto-pay allows it.
 *
 * `sceneKey` is the key of the scene this Send is. A scan started from this
 * Send delivers its code here: the receiver is armed by this Send's own scan
 * button and stays registered, through `useIsCurrentScene(sceneKey)`, while
 * the overlay covers the pane (REDESIGN.md 2.3). Android back steps from the
 * review to compose before the stage closes the scene. A completed payment
 * goes home on its own, and a held one opens the payment it waits on.
 * Amounts follow the balance: hidden while it is, and in its unit. On a
 * test network slate stands in for bloom, as it does across the canvas.
 *
 * Send lays no ground of its own: the canvas's backdrop shows through, with
 * the tints the screen asks for, honey while an outcome is unknown and a
 * radish flash as a payment fails (REDESIGN.md 3.2, G3).
 */
export function SendScene({
  prefill,
  client,
  snapshot,
  stale,
  opening = false,
  session,
  view,
  sceneKey,
  scanned = false,
  slotHeight,
}: RegionProps & {
  sceneKey: number;
  prefill: string;
  /** The camera read `prefill` from home. */
  scanned?: boolean;
  /**
   * How tall the canvas says the slot will be, so the control is pinned in
   * the first frame it is drawn rather than a frame after it measures.
   */
  slotHeight?: number;
}) {
  const { actions, state, dispatch, felt } = useStage();
  const insets = useSafeAreaInsets();
  // As Receive has it: the slot's height, for compose to pin its way on to
  // the bottom of, so a short window never leaves it below the edge.
  const [slot, setSlot] = useState<number | null>(slotHeight ?? null);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setSlot(last => (last === height ? last : height));
  }, []);
  const screen = useRef<SendHandle>(null);
  const current = useIsCurrentScene(sceneKey);

  // An old balance closes Send's gate, which Send feels, logs and says
  // itself, while Home waits for it to go (REDESIGN.md rule 4). So the state
  // counts as felt for the wallet from then on, and Home, back in front
  // while it still holds, owes nothing more for it: it is felt once across
  // both. While the wallet is still opening the gate stays open and Send
  // waits for the live read instead, so nothing is felt then.
  const gated = stale && !opening;
  const wallet = snapshot.wallet.id;
  useEffect(() => {
    felt.set(wallet, 'stale', gated);
  }, [felt, wallet, gated]);

  // Armed from the scan button until the overlay it opened closes, so only
  // a scan this Send asked for fills in its request.
  const [armed, setArmed] = useState(false);
  const scanOpen = state.overlay?.name === 'scan';
  useEffect(() => {
    if (armed && !scanOpen) setArmed(false);
  }, [armed, scanOpen]);
  const scan = useCallback(
    (origin: Origin | null) => {
      setArmed(true);
      actions.openScan(origin ?? undefined);
    },
    [actions],
  );
  useScanReceiver(
    useCallback((code: string) => screen.current?.receive(code, true), []),
    current && armed,
  );
  useSceneBack(() => screen.current?.back() ?? false, usePaneActive());

  // Send opens no payment's detail itself, so a held payment opens by way
  // of Activity, which does. Back from its detail then returns to the
  // history the payment sits in.
  const openHeld = useCallback(
    (item: Activity) => {
      dispatch({ type: 'open', scene: { name: 'activity' } });
      dispatch({ type: 'open', scene: { name: 'detail', item, from: null } });
    },
    [dispatch],
  );

  return (
    <Arriving>
      {/* The balance rests here as the mini strip, so Send leaves it
          clear. */}
      <View style={styles.mini} />
      <View style={styles.fill} onLayout={measure}>
        <SceneSlot label={copy.scene.send} offset={STATUS_ROW + MINI_STRIP}>
          <View style={[styles.fill, { paddingBottom: insets.bottom }]}>
            <SendScreen
              ref={screen}
              client={client}
              initialRequest={prefill}
              scanned={scanned}
              disabled={gated}
              opening={opening}
              primaryConnected={snapshot.primary.connected}
              quoteRevision={snapshot.updatedAt}
              balance={snapshot.balance}
              activity={snapshot.activity}
              onActivity={actions.openActivity}
              onRefresh={session.refresh}
              onBusy={actions.setBusy}
              onScan={scan}
              onDetail={openHeld}
              onDone={actions.home}
              masked={view.hidden}
              unit={view.unit}
              symbol={view.symbol}
              test={isTestNetwork(snapshot.wallet.network)}
              leaving={!current}
              room={slot === null ? undefined : slotRoom(slot, insets.bottom)}
            />
          </View>
        </SceneSlot>
      </View>
    </Arriving>
  );
}

const styles = StyleSheet.create({
  mini: { height: MINI_STRIP },
  fill: { flex: 1 },
});
