import React from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton } from '../../components/ui';
import { RecoveryPhrase } from '../../components/RecoveryPhrase';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { SettingsNetwork, SettingsSurface } from '../../scenes/settings/ui';
import { space } from '../../theme';
import { STATUS_ROW } from '../layout';
import { SceneSlot } from '../panes/SceneSlot';
import { usePhaseBack } from '../StageContext';
import type { Backup } from '../Canvas';

/**
 * A new wallet's recovery phrase, to reveal and save before the wallet is
 * open (REDESIGN.md 6, Backup and setup). The shield tile over a shell phase
 * opens it, since a phase has no Settings to lead to.
 *
 * It is a setup surface, drawn in the Settings language with its safety
 * lines in words (REDESIGN.md rule 2), so its root carries the settings
 * marker. The stage draws it in place of the phase, so it is never drawn
 * beside a phase's own setup panel, and a phase that changes under it does
 * not take away a phrase being written down. `onClose` lets it go, and so
 * does Android back; saving the phrase ends the backup, which closes it.
 */
export function BackupPanel({
  backup,
  network,
  onClose,
}: {
  backup: Backup;
  /**
   * The wallet's network: on a test network the phrase draws slate where it
   * would draw bloom, as it does in Settings.
   */
  network: string;
  onClose: () => void;
}) {
  usePhaseBack(() => {
    onClose();
    return true;
  });
  return (
    <SettingsSurface style={styles.panel} accessibilityViewIsModal>
      <View style={styles.header}>
        <IconButton
          name="close"
          tone="plain"
          accessibilityLabel={copy.phase.close}
          onPress={onClose}
        />
      </View>
      <SceneSlot label={copy.scene.backup}>
        <SettingsNetwork network={network}>
          <RecoveryPhrase
            loadPhrase={backup.loadPhrase}
            onSaved={backup.onSaved}
            focus
          />
        </SettingsNetwork>
      </SceneSlot>
    </SettingsSurface>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: palette.roast },
  header: {
    height: STATUS_ROW,
    paddingHorizontal: space.xl,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
});
