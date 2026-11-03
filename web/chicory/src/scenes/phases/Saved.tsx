import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Network } from '@beignet/wallet-core';
import { LinkButton } from '../../components/ui';
import { copy } from '../../design/copy';
import { Bloom } from '../../glyphs/Bloom';
import { NetworkSettings } from '../../screens/NetworkSettings';
import { useFocus } from '../../motion/focus';
import type { useWalletSession } from '../../services/useWalletSession';
import { usePhaseBack } from '../../stage/StageContext';
import { space } from '../../theme';
import {
  GlyphButton,
  nameStyle,
  PhaseRoot,
  refused,
  SetupPanel,
  StatusPip,
} from './parts';
import { bloomTone, DORMANT_OPEN, SIZES } from './visual';

type Session = ReturnType<typeof useWalletSession>;

/**
 * The wallet saved on this device, when it could not be opened, and the ways
 * back into it: a dormant bloom over the wallet's name, a radish pip that
 * holds the reason when there is one, a refresh that opens it again, and a
 * cog for the network editor, which opens as a setup panel in the Settings
 * language with the device's connection settings under it.
 */
export function Saved({
  name,
  network,
  error,
  switchError,
  connecting,
  networkEditor,
  openWallet,
  setError,
  setNetworkEditor,
  setDeviceVisible,
  switchNetwork,
}: Pick<
  Session,
  | 'error'
  | 'switchError'
  | 'connecting'
  | 'networkEditor'
  | 'openWallet'
  | 'setError'
  | 'setNetworkEditor'
  | 'setDeviceVisible'
  | 'switchNetwork'
> & {
  name?: string;
  network: Network;
}) {
  // Back closes the network editor before it leaves the app.
  usePhaseBack(() => {
    if (!networkEditor) return false;
    setNetworkEditor(false);
    return true;
  });
  const focus = useFocus();
  const reason = switchError || error;
  // The bloom speaks for what the screen no longer writes: whose wallet it is
  // when there is no name to show, and that it is still here.
  const spoken = [
    name ? '' : copy.phase.yourWallet,
    reason ? copy.phase.saved : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <PhaseRoot>
      <View style={styles.identity}>
        <View style={styles.bloom}>
          <Bloom
            size={SIZES.loader}
            open={DORMANT_OPEN}
            tone="dormant"
            accessibilityLabel={spoken || undefined}
          />
          {reason ? (
            <View style={styles.pip}>
              <StatusPip tone="radish" label={reason} />
            </View>
          ) : null}
        </View>
        {name ? <Text style={styles.name}>{name}</Text> : null}
      </View>
      <View style={styles.controls}>
        <GlyphButton
          ref={focus}
          glyph="refresh"
          look="fill"
          tone={bloomTone(network)}
          size={SIZES.retry}
          label={copy.phase.openDevice}
          busy={connecting}
          onPress={() => {
            openWallet().catch(refused(setError));
          }}
        />
        <GlyphButton
          glyph={networkEditor ? 'close' : 'cog'}
          size={SIZES.cog}
          label={
            networkEditor ? copy.phase.hideNetwork : copy.phase.changeNetwork
          }
          disabled={connecting}
          onPress={() => setNetworkEditor(!networkEditor)}
        />
      </View>
      {networkEditor ? (
        <SetupPanel network={network}>
          <NetworkSettings initialNetwork={network} onApply={switchNetwork} />
          <LinkButton
            label={copy.phase.deviceSettings}
            tone="muted"
            disabled={connecting}
            onPress={() => setDeviceVisible(true)}
          />
        </SetupPanel>
      ) : null}
    </PhaseRoot>
  );
}

const styles = StyleSheet.create({
  identity: { alignItems: 'center', gap: space.md },
  bloom: { width: SIZES.loader, height: SIZES.loader },
  pip: { position: 'absolute', right: 0, bottom: 0 },
  name: nameStyle,
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
});
