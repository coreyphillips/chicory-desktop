import 'react-native-url-polyfill/auto';
import React, { useCallback, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { ToastProvider } from './src/components/Toast';
import { colors } from './src/theme';
import { useWalletSession } from './src/services/useWalletSession';
import type { Tab } from './src/services/useWalletSession';
import { setHapticsEnabled } from './src/services/haptics';
import { loadHapticsPreference } from './src/services/hapticsPreference';
import { loadAutoPayPreference } from './src/services/autoPayPreference';
import { useReducedMotion } from './src/services/motion';
import { useAppLock } from './src/services/useAppLock';
import { usePaymentLinks } from './src/services/links';
import { derivePhase, phaseInput } from './src/stage/phase';
import { tabOf } from './src/stage/scene';
import { Stage } from './src/stage/Stage';
import { StageProvider, useStageStore } from './src/stage/StageContext';
import { BrowserShell } from '../platform/BrowserShell';

function WalletApp() {
  useReducedMotion();
  // Settings > Haptics holds from the first frame, not only once Settings
  // has been opened (REDESIGN.md rule 7). It only reads the secure store.
  useEffect(() => {
    loadHapticsPreference().then(setHapticsEnabled);
  }, []);
  // Settings > Auto-pay is read as the app opens, so a code scanned before
  // Settings is ever opened is judged by it. Until it answers it reads as
  // off, which pays nothing on its own.
  useEffect(() => {
    loadAutoPayPreference();
  }, []);
  const stage = useStageStore();
  const { dispatch } = stage;
  // The session moves the wallet itself, a close, a switch or a wallet
  // created, and every such move outranks whatever scene is showing.
  const onTab = useCallback(
    (tab: Tab) => dispatch({ type: 'tab', tab }),
    [dispatch],
  );
  const onCloseSheet = useCallback(
    () => dispatch({ type: 'reset' }),
    [dispatch],
  );
  const lock = useAppLock();
  // A locked app does not restore: no engine is started and no balance is read
  // until whoever is holding the phone has authenticated.
  const session = useWalletSession({
    tab: tabOf(stage.state),
    onTab,
    onCloseSheet,
    paused: lock.checking || lock.locked,
  });

  /** A tapped bitcoin:/lightning: link goes to the reviewed send flow, never straight to a payment. */
  const onLink = useCallback(
    (request: string) => dispatch({ type: 'link', request }),
    [dispatch],
  );
  usePaymentLinks(!!session.walletId && !!session.snapshot, onLink);

  const phase = derivePhase(phaseInput(lock, session));
  return (
    <StageProvider value={stage}>
      <BrowserShell session={session} phase={phase}>
        <Stage phase={phase} session={session} onUnlock={lock.prompt} />
      </BrowserShell>
    </StageProvider>
  );
}

/**
 * The whole app fades in on a worklet, so the first frame after launch already
 * proves the animation runtime is alive on the UI thread.
 */
function Root({ children }: { children: React.ReactNode }) {
  const shown = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: shown.get() }));
  React.useEffect(() => {
    shown.set(withTiming(1, { duration: 220 }));
  }, [shown]);
  return (
    <Reanimated.View style={[styles.flex, style]}>{children}</Reanimated.View>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ToastProvider>
          <Root>
            <WalletApp />
          </Root>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
});
