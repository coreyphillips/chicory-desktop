import React, { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { HostInstance } from 'react-native';
import Reanimated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { EntryExitAnimationFunction } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import type { Network } from '@beignet/wallet-core';
import { LinkButton } from '../../components/ui';
import { RecoveryPhrase } from '../../components/RecoveryPhrase';
import { copy } from '../../design/copy';
import { GLYPHS, strokeFor } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { useFocus } from '../../motion/focus';
import { riseIn, sceneOut } from '../../motion/presets';
import { curves, durations, springs } from '../../motion/tokens';
import { NetworkSettings } from '../../screens/NetworkSettings';
import { motionReduced } from '../../services/motion';
import type { NetworkProfile } from '../../services/networks';
import { usePhaseBack } from '../../stage/StageContext';
import { space } from '../../theme';
import {
  GlyphButton,
  nameStyle,
  PhaseRoot,
  SetupPanel,
  StatusPip,
  useRunning,
} from './parts';
import { bloomTone, DORMANT_OPEN, SIZES, UNPLUG_DRIFT } from './visual';

/**
 * The wallet is here, its network is not.
 *
 * The chase has stopped and the mark is dormant, with the hollow radish dot
 * the canvas uses for a refresh that failed; it holds the reason. Under it
 * the unplug glyph's halves drift apart and back (R-4). A refresh retries the
 * connection and a bolt retry reruns the wallet's Lightning setup, with a
 * honey pip when that setup has failed before.
 *
 * The cog opens a setup panel in the Settings language, holding the network
 * editor and the recovery phrase, and under it the lock, the glyph that
 * leaves this wallet. All stay reachable, because this is exactly the screen
 * where someone needs them.
 */
export function OfflineWallet({
  name,
  network,
  setupError,
  error,
  busy,
  networkEditor,
  onRetryConnection,
  onRetrySetup,
  onToggleNetwork,
  onApplyNetwork,
  onDisconnect,
  loadPhrase,
}: {
  name?: string;
  network: Network;
  setupError?: string;
  error: string;
  busy: boolean;
  networkEditor: boolean;
  onRetryConnection: () => void;
  onRetrySetup: () => void;
  onToggleNetwork: () => void;
  onApplyNetwork: (profile: NetworkProfile) => Promise<void>;
  onDisconnect: () => void;
  loadPhrase: () => Promise<string>;
}) {
  // An editor left open elsewhere opens the panel it lives in.
  const [panel, setPanel] = useState(networkEditor);
  // Closing the panel closes the editor inside it, so back never has an
  // unseen editor to close first.
  const togglePanel = () => {
    if (panel && networkEditor) onToggleNetwork();
    setPanel(!panel);
  };
  // Back closes the network editor, then the panel, before it leaves the app.
  usePhaseBack(() => {
    if (networkEditor) {
      onToggleNetwork();
      return true;
    }
    if (!panel) return false;
    setPanel(false);
    return true;
  });
  // The unplug says what this phase is, so a screen reader starts there.
  const focus = useFocus();
  // The connection dropped: the hand hears it as the unplug pops in.
  useEffect(() => {
    if (error) haptics.warning();
  }, [error]);
  // A retry asked for here that ends with the connection still down is felt
  // as a refusal. The app's own retries stay quiet. One that succeeds leaves
  // this phase for the wallet, whose first live read is felt there.
  const retried = useRef(false);
  useEffect(() => {
    if (busy || !retried.current) return;
    retried.current = false;
    if (error) haptics.error();
  }, [busy, error]);

  return (
    <PhaseRoot>
      <View style={styles.identity}>
        <View style={styles.mark}>
          <Bloom
            size={MARK}
            open={DORMANT_OPEN}
            tone="dormant"
            accessibilityLabel={name ? undefined : copy.phase.yourWallet}
          />
          {error ? (
            <View style={styles.pip}>
              <StatusPip tone="radish" hollow label={error} />
            </View>
          ) : null}
        </View>
        {name ? <Text style={styles.name}>{name}</Text> : null}
      </View>
      <Unplug
        ref={focus}
        label={error ? copy.phase.offline : copy.phase.connecting}
        apart={!!error}
      />
      <View style={styles.controls}>
        <GlyphButton
          glyph="boltRetry"
          look="outline"
          size={SIZES.secondary}
          label={copy.phase.retrySetup}
          hint={copy.phase.retrySetupHint}
          value={setupError}
          pip={setupError ? { tone: 'honey', label: setupError } : null}
          disabled={busy}
          onPress={onRetrySetup}
        />
        <GlyphButton
          glyph="refresh"
          look="fill"
          tone={bloomTone(network)}
          size={SIZES.retry}
          label={copy.phase.retryConnection}
          busy={busy}
          onPress={() => {
            retried.current = true;
            onRetryConnection();
          }}
        />
        <GlyphButton
          glyph={panel ? 'close' : 'cog'}
          size={SIZES.cog}
          label={panel ? copy.phase.close : copy.phase.settings}
          onPress={togglePanel}
        />
      </View>
      {panel ? (
        <SetupPanel network={network}>
          <LinkButton
            label={
              networkEditor ? copy.phase.hideNetwork : copy.phase.changeNetwork
            }
            disabled={busy}
            onPress={onToggleNetwork}
          />
          {networkEditor ? (
            <NetworkSettings
              initialNetwork={network}
              onApply={onApplyNetwork}
            />
          ) : null}
          <RecoveryPhrase loadPhrase={loadPhrase} />
        </SetupPanel>
      ) : null}
      {/* Leaving the wallet is not setup, so it keeps to a glyph, outside
          the panel's settings-class marker (REDESIGN.md 10.1). A retry is
          never a reason to keep the wallet open: one the network never
          answers would hold it for good, so the lock stays live through it. */}
      {panel ? (
        <Reanimated.View
          entering={riseIn()}
          exiting={sceneOut()}
          style={styles.leave}
        >
          <GlyphButton
            glyph="lock"
            size={SIZES.cog}
            label={copy.phase.lockDevice}
            onPress={onDisconnect}
          />
        </Reanimated.View>
      ) : null}
    </PhaseRoot>
  );
}

const MARK = 72;
const UNPLUG_SIZE = 48;
const [LEFT, RIGHT, SPARK] = GLYPHS.unplug;

/**
 * The unplug glyph, one static drawing per part so its halves can move on
 * their own. While the connection is down they drift apart and back; while
 * it is still being tried they rest together. It pops in when the phase
 * arrives and splits apart when the connection comes back (R-5).
 */
function Unplug({
  ref,
  label,
  apart,
}: {
  ref?: Ref<HostInstance>;
  label: string;
  apart: boolean;
}) {
  const running = useRunning(apart);
  const drift = useSharedValue(apart ? 1 : 0);
  useEffect(() => {
    if (!running) {
      cancelAnimation(drift);
      drift.set(withTiming(apart ? 1 : 0, { duration: durations.move }));
      return;
    }
    const half = { duration: durations.pulse / 2, easing: curves.sine };
    drift.set(
      withRepeat(withSequence(withTiming(0, half), withTiming(1, half)), -1),
    );
    return () => cancelAnimation(drift);
  }, [running, apart, drift]);
  const leftStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -UNPLUG_DRIFT * drift.get() }],
  }));
  const rightStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: UNPLUG_DRIFT * drift.get() }],
  }));
  return (
    <Whisper label={label}>
      <Reanimated.View
        ref={ref}
        entering={popIn()}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        style={styles.unplug}
      >
        <Reanimated.View
          exiting={splitOut(-1)}
          style={[styles.part, leftStyle]}
        >
          <Part d={LEFT.d} />
        </Reanimated.View>
        <Reanimated.View
          exiting={splitOut(1)}
          style={[styles.part, rightStyle]}
        >
          <Part d={RIGHT.d} />
        </Reanimated.View>
        <View style={styles.part}>
          <Part d={SPARK.d} />
        </View>
      </Reanimated.View>
    </Whisper>
  );
}

function Part({ d }: { d: string }) {
  return (
    <Svg
      width={UNPLUG_SIZE}
      height={UNPLUG_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke={palette.honey}
      strokeWidth={strokeFor(UNPLUG_SIZE)}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d={d} />
    </Svg>
  );
}

/** A pop on the reveal spring; under Reduce Motion a plain fade. */
function popIn(): EntryExitAnimationFunction {
  const reduced = motionReduced();
  return () => {
    'worklet';
    const fade = {
      duration: reduced ? durations.crossfade : durations.enter,
      easing: curves.enter,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: {
        opacity: 0,
        transform: [{ scale: reduced ? 1 : 0.6 }],
      },
      animations: {
        opacity: withTiming(1, fade),
        transform: [{ scale: withSpring(1, springs.reveal) }],
      },
    };
  };
}

/** A half of the plug leaving: it slides away on its own side and fades. */
function splitOut(side: -1 | 1): EntryExitAnimationFunction {
  const reduced = motionReduced();
  return () => {
    'worklet';
    const config = {
      duration: reduced ? durations.crossfade : durations.enter,
      easing: curves.exit,
      reduceMotion: ReduceMotion.Never,
    };
    return {
      initialValues: { opacity: 1, transform: [{ translateX: 0 }] },
      animations: {
        opacity: withTiming(0, config),
        transform: [
          { translateX: withTiming(reduced ? 0 : side * SPLIT, config) },
        ],
      },
    };
  };
}

/** How far each half slides as it leaves. */
const SPLIT = 8;

const styles = StyleSheet.create({
  identity: { alignItems: 'center', gap: space.md },
  mark: { width: MARK, height: MARK },
  pip: { position: 'absolute', right: -space.xxs, bottom: -space.xxs },
  name: nameStyle,
  unplug: { width: UNPLUG_SIZE, height: UNPLUG_SIZE },
  part: StyleSheet.absoluteFill,
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  leave: { flexDirection: 'row', justifyContent: 'center', gap: space.xxl },
});
