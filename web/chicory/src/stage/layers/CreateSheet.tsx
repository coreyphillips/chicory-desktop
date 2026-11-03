import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { WalletRecord } from '@beignet/wallet-core';
import { CreateWalletScreen } from '../../screens/Settings';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { SettingsNetwork, SettingsSurface } from '../../scenes/settings/ui';
import type { NetworkProfile } from '../../services/networks';
import type { WalletAdapter } from '../../services/wallet';
import { space } from '../../theme';
import { STATUS_ROW } from '../layout';
import { CORNER_REACH, CornerControl } from '../panes/CornerControl';
import { SceneSlot } from '../panes/SceneSlot';
import { useStage } from '../StageContext';

/**
 * A new or restored wallet, drawn over whatever the shell is showing: the
 * picker, the first-run screen or the wallet itself.
 *
 * It is a setup surface, drawn in the Settings language with its safety
 * lines in words (REDESIGN.md rule 2), so its root carries the settings
 * marker. It only opens from a shell phase, and opening a wallet closes it,
 * so it is never drawn beside Settings.
 *
 * It draws in the tone of the network the wallet is made on: slate in place
 * of bloom on a test network, so play money is never made in the colour of
 * real money.
 */
export function CreateSheet({
  client,
  profile,
  restoring,
  onCreated,
}: {
  client: WalletAdapter;
  profile: NetworkProfile;
  restoring: boolean;
  onCreated: (wallet: WalletRecord) => Promise<void>;
}) {
  const { actions } = useStage();
  return (
    <SettingsSurface style={styles.sheet} accessibilityViewIsModal>
      <View style={styles.header}>
        <CornerControl home={false} />
      </View>
      <SceneSlot label={copy.scene.create}>
        <SettingsNetwork network={profile.network}>
          <CreateWalletScreen
            client={client}
            profile={profile}
            initialRestoring={restoring}
            onCreated={onCreated}
            onBusy={actions.setBusy}
          />
        </SettingsNetwork>
      </SceneSlot>
    </SettingsSurface>
  );
}

const styles = StyleSheet.create({
  sheet: { ...StyleSheet.absoluteFill, backgroundColor: palette.roast },
  // The close's 48pt target reaches past the page edge by CORNER_REACH, as
  // the canvas's cog does, so its glyph sits where the cog's sat.
  header: {
    height: STATUS_ROW,
    paddingLeft: space.xl,
    paddingRight: space.xl - CORNER_REACH,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
});
