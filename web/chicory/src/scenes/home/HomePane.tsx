import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useAnimatedReaction } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { announce } from '../../design/announce';
import { copy } from '../../design/copy';
import { haptics } from '../../design/haptics';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { HomeScreen } from '../../screens/wallet/Home';
import type { RegionProps } from '../../stage/Canvas';
import {
  heldRequest,
  heldVersion,
  subscribeHeld,
} from '../../stage/heldRequests';
import { canvasScene, launchLook } from '../../stage/layout';
import { useBuild } from '../../stage/panes/Build';
import { usePanes } from '../../stage/panes/Pane';
import { useStage } from '../../stage/StageContext';
import { nextFace } from '../../theme';
import { reviewOpensLive } from '../send/model';
import type { Point } from './ActionCircle';
import { rowBack } from './motion';
import type { Launch } from './motion';
import { useSafetySignal } from './signals';
import { useAppActive } from './useAppActive';
import { isTestNetwork } from './visual';

/**
 * Everything the home pane shows under the status row: the balance, its
 * vessel and the actions. The canvas places the pane; `hero` and `bar` from
 * its panes move what is in it.
 *
 * It also holds what Home's safety states owe beyond the screen (REDESIGN.md
 * rule 4): an old balance, a recovery phrase still to save and a test
 * network are each felt, spoken and logged as they begin, once however
 * often Home is drawn again or the app comes back while they last, and
 * spoken once focus has landed, together and in order of how much they
 * matter. A state that begins while the app is away, or as it leaves, is
 * felt once the app is in front again. A refresh that fails is spoken too,
 * politely, since the notice that once said so is now the mark's value.
 *
 * An old balance is spoken for by the scene in front: while Send or Receive
 * is open it is theirs to warn about, so Home stays quiet rather than warn
 * twice, and one Home has felt is not felt again as they close.
 *
 * A cached launch opens on old figures while the wallet starts. The dormant,
 * ratcheting mark says so. The live figures are expected any moment, so the
 * actions stay open, and Send and Receive wait inside for them, and the
 * warning waits too: once they are overdue (LIVE_OVERDUE_MS) the old
 * balance gates the actions and is warned about like any other.
 *
 * Pulling the pane down refreshes. That is a pan of Home's own rather than a
 * scroll view's refresh control: it behaves the same on both platforms, and
 * the status row's mark opens its petals with it, through the canvas's
 * `pull`, instead of a spinner. The mark ratchets while the refresh runs.
 */
export function HomePane({
  snapshot,
  session,
  view,
  stale,
  opening = false,
  backup,
  arrived,
}: RegionProps & {
  /** Home is the scene the canvas shows, whether or not Settings covers it. */
  home: boolean;
}) {
  const { state, actions } = useStage();
  const panes = usePanes();
  const { hidden, setHidden, unit, symbol, setFace } = view;
  const network = snapshot.wallet.network;

  // On its way to Send or Receive the hero shows what can be spent rather
  // than the total (REDESIGN.md 7, T1), changing in place: nothing moved.
  const shown = canvasScene(state);
  const spending = shown === 'send' || shown === 'receive';
  // The circle that opened Send or Receive is kept while the canvas comes
  // home, so it travels back into the row rather than snapping there, and
  // the mini strip grows from the band it rested in. It is let go once the
  // row is back (`rowBack`): from then on the three circles move as one
  // row, as the sheet's drag moves them, and the strip heads for the status
  // row. Anywhere else it is let go at once.
  const [launched, setLaunched] = useState<Launch>('none');
  const launching: Launch = spending
    ? shown
    : shown === 'home'
    ? launched
    : 'none';
  if (launching !== launched) setLaunched(launching);
  const returning = shown === 'home' && launching !== 'none';
  // What the control the circle lands on looks like as its scene opens: a
  // review whose request can be paid and names its amount
  // (`reviewOpensLive`), or a Continue an empty amount can take, is live;
  // otherwise it waits in dust. Kept while the circle comes home, so it
  // leaves from the look it landed with.
  //
  // A request that is held, or already paid, never reaches a review: Send
  // takes it straight to the held ring or its paid mark, which draw no
  // control (REDESIGN.md rule 6). So the circle has nowhere to land, and a
  // live pay control must never be seen over that screen: it goes with the
  // other two instead (`landless`). Settled as the scene opens, so a
  // payment that answers while it shows moves nothing on Home.
  useSyncExternalStore(subscribeHeld, heldVersion);
  const test = isTestNetwork(network);
  const [landsOn, setLandsOn] = useState<{
    live: boolean;
    landless: boolean;
    key: number;
  } | null>(null);
  if (spending && state.scene.name === shown) {
    const scene = state.scene;
    const landless =
      landsOn?.key === scene.key
        ? landsOn.landless
        : scene.name === 'send' &&
          heldRequest(scene.prefill, snapshot.activity) !== null;
    // Send's hold waits for a live balance whichever way the wallet is
    // opening. Receive's Continue is held back only by a gated old balance:
    // while the wallet opens it takes the tap and waits for the live read.
    const live =
      scene.name === 'send'
        ? !stale && reviewOpensLive(scene.prefill)
        : !(stale && !opening) && snapshot.balance.receivableSats > 0;
    if (
      landsOn?.live !== live ||
      landsOn.landless !== landless ||
      landsOn.key !== scene.key
    ) {
      setLandsOn({ live, landless, key: scene.key });
    }
  }
  const landless = launching !== 'none' && !!landsOn?.landless;
  const lands = useMemo(
    () =>
      launching === 'none' || !landsOn || landsOn.landless
        ? null
        : launchLook(launching, { live: landsOn.live, test }),
    [launching, landsOn, test],
  );
  useAnimatedReaction(
    () => panes.bar.get(),
    (bar, before) => {
      if (returning && rowBack(bar, before)) scheduleOnRN(setLaunched, 'none');
    },
    [returning, panes.bar],
  );

  // As the canvas builds in, the hero counts up from 0 on its beat (R-1):
  // it holds 0 until then, unseen, and rolls to the balance as it fades
  // in. The count is set going as the hero mounts, and waits for its beat
  // on the UI thread on the steady clock, as the fade does, so the two set
  // out together: a count that waited for the JavaScript thread to hear
  // the beat left the hero faded up on "0 sats" for a second of a cold
  // launch. A hidden balance, and one under Reduce Motion, simply shows.
  const { reduced } = useMotionPrefs();
  const build = useBuild();
  const [beats] = useState(() => build?.beats);
  const [countUp] = useState(() =>
    build && !hidden && !reduced ? build.beats.hero : undefined,
  );

  // Each safety state is felt once as it begins, while the app is in front,
  // and not again as Home is drawn anew or the app comes back while it
  // lasts (`signalStep`). An old balance waits while Send or Receive, which
  // warn about it themselves, is in front.
  const active = useAppActive();
  const wallet = snapshot.wallet.id;
  const aged = stale && !opening;
  useSafetySignal(aged, copy.health.stale, haptics.warning, 'stale', {
    wallet,
    front: active && !spending,
  });
  useSafetySignal(
    !!backup?.pending,
    copy.health.backupPending,
    haptics.warning,
    'backup',
    { wallet, front: active },
  );
  useSafetySignal(
    isTestNetwork(network),
    copy.health.testNetwork(network),
    haptics.tick,
    'testNetwork',
    { wallet, front: active },
  );
  useEffect(() => {
    if (session.error) announce(copy.health.refreshFailedDetail(session.error));
  }, [session.error]);

  // The canvas runs to the bottom edge. The pane ends at the sheet, well above
  // it, unless the screen is so short that the sheet's home stop falls into
  // the bottom inset; then the actions keep clear of it.
  const { bottom } = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const clear = Math.max(0, panes.stops.home - (height - bottom));

  // Send opens empty, whatever a control passes its handler.
  const openSend = useCallback(() => actions.openSend(), [actions]);
  const openScan = useCallback(
    (origin?: Point) => actions.openScan(origin),
    [actions],
  );
  const toggleUnit = useCallback(
    () => setFace(nextFace(unit, symbol)),
    [unit, symbol, setFace],
  );
  const toggleHidden = useCallback(
    () => setHidden(value => !value),
    [setHidden],
  );
  return (
    <View style={[styles.region, { paddingBottom: clear }]}>
      <HomeScreen
        snapshot={snapshot}
        hidden={hidden}
        unit={unit}
        symbol={symbol}
        stale={stale}
        gated={aged}
        countUp={countUp}
        spendable={spending}
        build={beats}
        progress={panes}
        launching={launching}
        lands={lands}
        landless={landless}
        arrived={arrived}
        onSend={openSend}
        onReceive={actions.openReceive}
        onScan={openScan}
        onActivity={actions.openActivity}
        onDetail={actions.openDetail}
        onToggleUnit={toggleUnit}
        onToggleHidden={toggleHidden}
        onRefresh={session.manualRefresh}
      />
    </View>
  );
}

export { LIVE_OVERDUE_MS } from './signals';

const styles = StyleSheet.create({ region: { flex: 1 } });
