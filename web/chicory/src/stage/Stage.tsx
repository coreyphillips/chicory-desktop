import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  AppState,
  Platform,
  RefreshControl,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import type { AppStateStatus } from 'react-native';
import Reanimated, { LayoutAnimationConfig } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { WalletSnapshot } from '@beignet/wallet-core';
import { copy } from '../design/copy';
import { Bloom } from '../glyphs/Bloom';
import { WhisperProvider } from '../glyphs/Whisper';
import { wakeAmbient, wakeOnTouch } from '../motion/ambient';
import { slideIn, slideOut } from '../motion/presets';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { useStaleAfter } from '../services/clock';
import { recordDiagnostic } from '../services/diagnosticLog';
import { STALE_AFTER_MS } from '../services/useWalletSession';
import type { useWalletSession } from '../services/useWalletSession';
import { LockScreen } from '../scenes/phases/Locked';
import { Transit } from '../scenes/phases/Transit';
import { Opening } from '../scenes/phases/Opening';
import { Saved } from '../scenes/phases/Saved';
import { Welcome } from '../scenes/phases/Welcome';
import { Picker } from '../scenes/phases/Picker';
import { OpeningWallet } from '../scenes/phases/Loading';
import { OfflineWallet } from '../scenes/phases/Offline';
import {
  bloomTone,
  openingNetwork,
  QUIET_MS,
  SIZES,
} from '../scenes/phases/visual';
import { BackupTile } from '../scenes/home/BackupTile';
import { vesselVisual } from '../scenes/home/visual';
import { useAppActive } from '../scenes/home/useAppActive';
import { colors, space } from '../theme';
import { Canvas, useCanvasView } from './Canvas';
import type { Backup } from './Canvas';
import { BackupPanel } from './layers/BackupPanel';
import { CreateSheet } from './layers/CreateSheet';
import { SceneSlot } from './panes/SceneSlot';
import { backupPending, walletOpen } from './phase';
import type { Phase } from './phase';
import type { Arrival } from './layout';
import { systemPromptOpen } from './systemPrompt';
import { useBackHandler } from './useBackHandler';
import { useStage } from './StageContext';

type Session = ReturnType<typeof useWalletSession>;

/**
 * The whole app below the providers: the view for the shell phase, or the
 * wallet canvas once there is a wallet to show, the new wallet sheet above
 * either, and the lock above everything.
 */
export function Stage({
  phase,
  session,
  onUnlock,
}: {
  phase: Phase;
  session: Session;
  onUnlock: () => void;
}) {
  const { state, actions, felt } = useStage();
  useBackHandler(phase.kind);
  // The safety states the open wallet has felt are kept while it stays
  // open, locked or offline included, and forgotten once none is.
  const open = walletOpen(phase.kind);
  useEffect(() => {
    if (!open) felt.forget();
  }, [open, felt]);
  const view = useCanvasView();
  const {
    snapshot,
    client,
    wallets,
    walletId,
    error,
    closing,
    switching,
    connecting,
    selecting,
    refreshing,
    networkEditor,
    activeProfile,
  } = session;
  const stale = useStale(snapshot?.updatedAt);
  // The network the launch restore opens on, once it is known: until then
  // the session's profile is a stand-in for mainnet, and the loader holds
  // back rather than chase in bloom and turn slate midway.
  const [firstProfile] = useState(activeProfile);
  const opensOn = openingNetwork(
    session.rememberedSession,
    activeProfile,
    firstProfile,
  );
  const savedWallet = useMemo(
    () => wallets.find(wallet => wallet.id === walletId),
    [wallets, walletId],
  );
  const walletsOnNetwork = useMemo(
    () => wallets.filter(wallet => wallet.network === activeProfile.network),
    [wallets, activeProfile.network],
  );
  const locked = phase.kind === 'locked';
  useRefreshFailures(phase.kind === 'wallet' ? phase.error : '');
  // How the canvas arrives, from the phase before the wallet's: over the
  // opening lock (R-1), back from offline (R-5), or from loading or anything
  // else (R-3). Kept until the next arrival, so the canvas is told once. A
  // lock that opened before its bud showed (QUIET_MS) had no bud to unfold,
  // so the canvas builds as it does after a load, rather than waiting on an
  // unfold nobody saw.
  const [shown, setShown] = useState(phase.kind);
  const [arrival, setArrival] = useState<Arrival>('load');
  const [lockedAt, setLockedAt] = useState(() =>
    phase.kind === 'locked' ? Date.now() : 0,
  );
  if (phase.kind !== shown) {
    setShown(phase.kind);
    if (phase.kind === 'locked') setLockedAt(Date.now());
    if (phase.kind === 'wallet') {
      setArrival(arrivalFrom(shown, Date.now() - lockedAt));
    }
  }

  // A pending backup sits above whatever is showing, the Activity list
  // included, rather than replacing it. Each surface draws it its own way.
  const backup: Backup | null = client
    ? {
        pending: backupPending(session),
        loadPhrase: () => client.getRecoveryPhrase(),
        onSaved: session.acknowledgeBackup,
      }
    : null;
  // Over a shell phase it is a shield tile, which opens the phrase in a
  // setup surface of its own (BackupPanel). The surface stays open across a
  // change of phase, the wallet opening included, so a phrase being written
  // down is never taken away, and it closes once the phrase is saved.
  const pending = !!backup?.pending;
  const [revealing, setRevealing] = useState(false);
  if (revealing && !pending) setRevealing(false);
  const openBackup = useCallback(() => setRevealing(true), []);
  const closeBackup = useCallback(() => setRevealing(false), []);
  const { reduced } = useMotionPrefs();
  const awake = useAppActive();
  const covered = usePrivacyCover();

  // Decoration wakes with anything worth seeing (REDESIGN.md 3.5): a touch
  // anywhere under the root view, which carries `wakeOnTouch`, the app
  // coming to the front, a new phase or scene, the balance going stale or
  // fresh, and a read that changed what the wallet shows. A read alone does
  // not: one lands every 12 seconds, and decoration would never rest.
  const shows = useMemo(() => (snapshot ? shownBy(snapshot) : ''), [snapshot]);
  useEffect(() => {
    wakeAmbient();
  }, [awake, phase.kind, state.scene, state.overlay, stale, shows]);

  let content: ReactNode = null;
  switch (phase.kind) {
    case 'transit':
      content = (
        <Transit
          erasing={session.erasing}
          closing={closing}
          switchTarget={session.switchTarget}
          network={activeProfile.network}
        />
      );
      break;
    case 'opening':
      content = (
        <Opening
          network={opensOn ?? activeProfile.network}
          known={opensOn !== null}
        />
      );
      break;
    case 'saved':
      content = (
        <Saved
          name={savedWallet?.name}
          network={activeProfile.network}
          error={error}
          switchError={session.switchError}
          connecting={connecting}
          networkEditor={networkEditor}
          openWallet={session.openWallet}
          setError={session.setError}
          setNetworkEditor={session.setNetworkEditor}
          setDeviceVisible={session.setDeviceVisible}
          switchNetwork={session.switchNetwork}
        />
      );
      break;
    case 'welcome':
      content = (
        <Welcome
          error={error}
          connecting={connecting}
          initializing={session.initializing}
          deviceVisible={session.deviceVisible}
          deviceHint={session.deviceHint}
          rememberedSession={session.rememberedSession}
          openDevice={session.openDevice}
          openWallet={session.openWallet}
          setError={session.setError}
          setDeviceVisible={session.setDeviceVisible}
          onCreateWallet={actions.openCreate}
          network={activeProfile.network}
        />
      );
      break;
    case 'picker':
      content = (
        <Picker
          wallets={walletsOnNetwork}
          activeProfile={activeProfile}
          error={error}
          switchError={session.switchError}
          networkEditor={networkEditor}
          selecting={selecting}
          switchNetwork={session.switchNetwork}
          setNetworkEditor={session.setNetworkEditor}
          selectWallet={session.selectWallet}
          createDefaultWallet={session.createDefaultWallet}
          disconnect={session.disconnect}
          onCreateWallet={actions.openCreate}
        />
      );
      break;
    case 'loading':
      // Drawn as the canvas is, edge to edge, with the tile where the
      // canvas puts it, beside the mark.
      content = (
        <OpeningWallet
          name={savedWallet?.name}
          network={savedWallet?.network || activeProfile.network}
          onDisconnect={session.disconnect}
          tile={
            pending ? (
              <BackupTile
                running={awake && !reduced}
                hint={copy.phase.backupHint}
                onOpen={openBackup}
              />
            ) : null
          }
        />
      );
      break;
    // The phase already promises a client, and a snapshot for the wallet. The
    // checks below only carry that promise to the compiler.
    case 'offline':
      content = client ? (
        <OfflineWallet
          name={savedWallet?.name}
          network={savedWallet?.network || activeProfile.network}
          setupError={savedWallet?.lfbw?.setupError}
          error={session.switchError || error}
          busy={refreshing || connecting || selecting}
          networkEditor={networkEditor}
          onRetryConnection={session.manualRefresh}
          onRetrySetup={session.retrySetup}
          onToggleNetwork={() => session.setNetworkEditor(!networkEditor)}
          onApplyNetwork={session.switchNetwork}
          onDisconnect={session.disconnect}
          loadPhrase={() => client.getRecoveryPhrase()}
        />
      ) : null;
      break;
    case 'wallet':
      content =
        client && snapshot ? (
          <Canvas
            scene={state.scene}
            overlay={state.overlay}
            client={client}
            snapshot={snapshot}
            session={session}
            stale={stale}
            backup={backup}
            view={view}
            arrival={arrival}
          />
        ) : null;
      break;
  }

  // The new wallet sheet, over whatever the shell is showing. Locking the
  // app unmounts it, as it does the recovery phrase: nothing of a wallet
  // stays drawn under the lock.
  const overlay = state.overlay;
  const creating =
    !locked && overlay?.name === 'create' && client ? (
      <CreateSheet
        key={overlay.key}
        client={client}
        profile={activeProfile}
        restoring={overlay.restoring}
        onCreated={wallet => session.selectWallet(wallet, true)}
      />
    ) : null;
  // The whisper pill is drawn above every phase and the canvas alike, the
  // lock included, from the window's own origin, so it lands where the
  // finger is. The lock is the last child, over whatever arrives as it
  // opens, so its bud can unfold and fly to the mark over the wallet
  // (REDESIGN.md 7, R-1). Nothing of a wallet is drawn under it: locking
  // drops the wallet with none of its exits played, so no balance or review
  // fades out where the phone's next holder could see it, and an opaque
  // cover is up under the lock from its first frame, before the bud fades
  // in. Unlocking takes the cover down at once, so the wallet builds in
  // under the flying bud.
  return (
    <WhisperProvider>
      <StatusBar barStyle="light-content" />
      <View style={styles.root} {...wakeOnTouch}>
        {locked ? null : (
          <LayoutAnimationConfig skipExiting>
            <View style={styles.root}>
              {revealing && backup ? (
                // In place of the phase, so no other setup surface is drawn
                // beside it.
                <SafeAreaView style={styles.root} edges={EDGES}>
                  <Reanimated.View
                    entering={slideIn()}
                    exiting={slideOut()}
                    style={styles.flex}
                  >
                    <BackupPanel
                      backup={backup}
                      network={savedWallet?.network || activeProfile.network}
                      onClose={closeBackup}
                    />
                  </Reanimated.View>
                </SafeAreaView>
              ) : phase.kind === 'wallet' || phase.kind === 'loading' ? (
                // The canvas draws edge to edge, under the system bars, and
                // keeps its own content clear of them, and so does the
                // loading page drawn as it.
                content
              ) : (
                <SafeAreaView style={styles.root} edges={EDGES}>
                  <View
                    style={styles.root}
                    importantForAccessibility={
                      creating ? 'no-hide-descendants' : 'auto'
                    }
                    accessibilityElementsHidden={!!creating}
                  >
                    <SceneSlot
                      refreshControl={
                        client && walletId && !closing && !switching ? (
                          // The phase views show their own wait, so the pull
                          // only starts a refresh.
                          <RefreshControl
                            refreshing={false}
                            onRefresh={session.manualRefresh}
                            tintColor={colors.primary}
                            colors={[colors.primary]}
                          />
                        ) : undefined
                      }
                    >
                      {/* Each phase enters and leaves through its own
                          PhaseRoot. */}
                      <View style={styles.stack}>
                        {pending ? (
                          <View style={styles.tile}>
                            <BackupTile
                              running={awake && !reduced}
                              hint={copy.phase.backupHint}
                              onOpen={openBackup}
                            />
                          </View>
                        ) : null}
                        {content}
                      </View>
                    </SceneSlot>
                  </View>
                </SafeAreaView>
              )}
              {/* A setup surface, so it slides over the phase as Settings
                  slides over the canvas. */}
              {creating ? (
                <Reanimated.View
                  entering={slideIn()}
                  exiting={slideOut()}
                  style={styles.layer}
                >
                  <SafeAreaView style={styles.flex} edges={EDGES}>
                    {creating}
                  </SafeAreaView>
                </Reanimated.View>
              ) : null}
            </View>
          </LayoutAnimationConfig>
        )}
        {locked ? <View testID="lock-cover" style={styles.layer} /> : null}
        {locked ? (
          <LockScreen
            prompting={phase.prompting}
            error={phase.error}
            onUnlock={onUnlock}
          />
        ) : null}
        {/* While the app is not in front, as the app switcher shows it, a
            roast ground and the mark cover whatever is drawn, so the
            switcher's picture of the app holds no balance. Behind a prompt
            the app raised itself, paste or the camera, the screen stays,
            so the person sees what they are answering for
            (`coverAfter`). Once up it stays up until the app is in front
            again. It is up and down at once, the mark's petals too, with no
            fade: the picture is taken as the app leaves. The lock hides the
            wallet itself. */}
        {covered && !locked ? (
          <LayoutAnimationConfig skipEntering skipExiting>
            <View
              testID="privacy-cover"
              style={[styles.layer, styles.cover]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {/* On iOS the native cover the switcher keeps is plain, and
                  this one is what shows for a moment on the way back, so it
                  is plain there too: one look, not a step to the mark. */}
              {Platform.OS === 'ios' ? null : (
                <Bloom
                  size={SIZES.loader}
                  tone={bloomTone(activeProfile.network)}
                />
              )}
            </View>
          </LayoutAnimationConfig>
        ) : null}
      </View>
    </WhisperProvider>
  );
}
Stage.displayName = 'Stage';

/**
 * How the canvas arrives after the phase `before` (REDESIGN.md 7): an
 * unlock when the lock's bud was seen, `lockedFor` ms having passed its
 * QUIET_MS, a reconnect after offline, and a load after anything else,
 * the lock that opened before its bud showed included.
 */
export function arrivalFrom(before: Phase['kind'], lockedFor: number): Arrival {
  if (before === 'locked') return lockedFor >= QUIET_MS ? 'unlock' : 'load';
  return before === 'offline' ? 'reconnect' : 'load';
}

/**
 * Whether the privacy cover is up once the app's state changes to `state`,
 * given whether it was (`covered`) and whether a system prompt the app
 * raised may be up (`prompting`, `systemPromptOpen`). It goes up with the
 * first step out of the front: the background always, since that is where
 * the app switcher takes its picture, and inactive, since the switcher and
 * its animation start there, except behind a prompt the app asked for,
 * which makes the app inactive as well: the paste permission over Send, or
 * the camera's over the scan, where the screen behind is what the person is
 * answering for. Once up it stays up until the app is in front again: no
 * later step on the way out or back lowers it, a prompt's window included,
 * nor a state the app cannot name. Only `active` does.
 */
export function coverAfter(
  covered: boolean,
  state: AppStateStatus | string | null | undefined,
  prompting: boolean,
): boolean {
  if (state === 'active') return false;
  if (state === 'background') return true;
  if (state === 'inactive') return covered || !prompting;
  return covered;
}

/**
 * Whether the privacy cover is up, stepped on as each change of the app's
 * state arrives, when whether a prompt the app raised is up can be read.
 */
function usePrivacyCover(): boolean {
  const [covered, setCovered] = useState(() =>
    coverAfter(false, AppState.currentState, systemPromptOpen()),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const prompting = systemPromptOpen();
      setCovered(was => coverAfter(was, state, prompting));
    });
    return () => subscription.remove();
  }, []);
  return covered;
}

/**
 * What a wallet read shows, as a key that changes only when something the
 * canvas draws from it would: the balance's figures, the vessel's look
 * (`vesselVisual`), the connection and the setup, and each payment's state.
 * It is built from what is drawn rather than from the records behind it,
 * which carry times of their own: the wallet's last channelize decision is
 * written again, with a new time, by every pass that decides nothing new,
 * and counted whole it woke decoration a moment after it came to rest.
 */
export function shownBy(snapshot: WalletSnapshot): string {
  const { balance, primary, wallet, activity } = snapshot;
  const lfbw = wallet.lfbw;
  return JSON.stringify([
    balance.totalSats,
    balance.availableSats,
    balance.pendingSats,
    vesselVisual(balance, lfbw, primary.connected),
    primary.connected,
    primary.setup,
    primary.setupError ?? null,
    lfbw ? [lfbw.enabled, lfbw.setup ?? null, lfbw.setupError ?? null] : null,
    activity.map(item => [
      item.id,
      item.status,
      item.receiveStatus?.phase,
      item.receiveStatus?.receivedSats,
      item.receiveStatus?.confirmedSats,
    ]),
  ]);
}

/**
 * A read of the wallet that keeps failing, written to the diagnostic log
 * once for each reason. The canvas keeps the last figures and only says they
 * are old (the stale look), so the reason is kept where it can be read:
 * Settings > Diagnostics, among the app's recent errors, in the engine's
 * own words.
 */
export function useRefreshFailures(error: string) {
  const logged = useRef('');
  useEffect(() => {
    if (!error) {
      logged.current = '';
      return;
    }
    if (error === logged.current) return;
    logged.current = error;
    recordDiagnostic({ phase: 'ui', code: 'REFRESH_FAILED', message: error });
  }, [error]);
}

/**
 * Whether the balance read at `updatedAt` is too old to spend against
 * (REDESIGN.md 6, stale), as of this render.
 *
 * The gate trips on its own, at the one moment it can, rather than by
 * re-rendering the whole app every few seconds to ask whether it has: the
 * timer only draws the stage again once the read goes old. The answer is
 * either the timer's flag or the read's age at this render, so neither can
 * hold the gate open alone. The age catches a clock stepped forward before
 * the timer fires; the flag holds when the clock was stepped back and the
 * age at the timer's render falls short of the threshold.
 *
 * The flag is set in an effect, a render behind each new read, so it only
 * counts for the read it was set for: a fresh read is never drawn as stale
 * on the strength of the old read's flag.
 */
export function useStale(updatedAt: number | undefined): boolean {
  const flag = useStaleAfter(updatedAt, STALE_AFTER_MS);
  // The read the flag was last set for. The timer's effect runs before this
  // one, so by the next render the flag answers for this read.
  const flagged = useRef<number | undefined>(undefined);
  useEffect(() => {
    flagged.current = updatedAt;
  }, [updatedAt]);
  if (updatedAt === undefined) return false;
  const aged = Date.now() - updatedAt >= STALE_AFTER_MS;
  return aged || (flag && flagged.current === updatedAt);
}

/** Every edge of the window that the phase views and the sheet keep clear of. */
const EDGES = ['top', 'bottom', 'left', 'right'] as const;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  layer: { ...StyleSheet.absoluteFill, backgroundColor: colors.background },
  cover: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  // Grows to the slot, so a phase root that grows can centre itself in it.
  stack: { gap: space.lg, flexGrow: 1 },
  tile: { alignSelf: 'flex-start' },
});
