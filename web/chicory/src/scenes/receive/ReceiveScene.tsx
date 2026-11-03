import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy } from '../../design/copy';
import { ReceiveScreen } from '../../screens/Receive';
import { isTestNetwork } from '../home/visual';
import type { RegionProps } from '../../stage/Canvas';
import { MINI_STRIP, STATUS_ROW } from '../../stage/layout';
import { Arriving } from '../../stage/panes/Arriving';
import { SceneSlot } from '../../stage/panes/SceneSlot';
import { useSceneBack, useStage } from '../../stage/StageContext';
import { ReceiveHostContext, slotRoom } from './host';
import type { ReceiveHost } from './host';

/**
 * Receive, in the top slot under the status row and the mini strip, where
 * the balance rests while it is open (REDESIGN.md 7, T2). `sceneKey` is the
 * key of the scene this Receive is, for anything in it that must tell
 * whether it is still the scene the stage shows, overlays aside
 * (`useIsCurrentScene`).
 *
 * The scene answers Android back for the screen, and leaves a payment that
 * completes to the canvas to feel, which it does once for every region
 * (`useIncoming`). It lays no ground of its own: the canvas's backdrop shows
 * through, and draws the tints the screen asks for, night while an offline
 * receive is chosen and sage as a request is paid (REDESIGN.md 3.2, G3). It
 * runs to the bottom edge, so it keeps its content clear of the system bar,
 * and it measures its slot, since the screen inside the scroll view cannot:
 * the amount step fits that room with its way on pinned to the bottom.
 */
export function ReceiveScene({
  snapshot,
  client,
  stale,
  opening = false,
  session,
  view,
}: RegionProps & { sceneKey: number }) {
  const { actions } = useStage();
  const { bottom } = useSafeAreaInsets();
  // The slot's height, outside its keyboard padding, so the room stays put
  // while a keyboard is up and the slot scrolls instead.
  const [slot, setSlot] = useState<number | null>(null);
  const measure = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setSlot(last => (last === height ? last : height));
  }, []);
  const host = useMemo<ReceiveHost>(
    () => ({
      useBack: useSceneBack,
      room: slot === null ? undefined : slotRoom(slot, bottom),
    }),
    [slot, bottom],
  );
  return (
    <Arriving>
      {/* The balance rests here as the mini strip, so Receive leaves it
          clear. */}
      <View style={styles.mini} />
      <ReceiveHostContext.Provider value={host}>
        <View testID="receive-slot" style={styles.slot} onLayout={measure}>
          <SceneSlot
            label={copy.scene.receive}
            offset={STATUS_ROW + MINI_STRIP}
          >
            <View style={[styles.content, { paddingBottom: bottom }]}>
              <ReceiveScreen
                client={client}
                receivableSats={snapshot.balance.receivableSats}
                offlineReceivableSats={snapshot.balance.offlineReceivableSats}
                walletId={snapshot.wallet.id}
                primaryOfflineAvailable={
                  snapshot.primary?.offlineReceiveAvailable
                }
                disabled={stale && !opening}
                opening={opening}
                hidden={view.hidden}
                unit={view.unit}
                symbol={view.symbol}
                onRefresh={session.refresh}
                onActivity={actions.openActivity}
                onBusy={actions.setBusy}
                completionsFelt
                test={isTestNetwork(snapshot.wallet.network)}
              />
            </View>
          </SceneSlot>
        </View>
      </ReceiveHostContext.Provider>
    </Arriving>
  );
}

const styles = StyleSheet.create({
  mini: { height: MINI_STRIP },
  slot: { flex: 1 },
  content: { flexGrow: 1 },
});
