import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { LinkButton } from '../../components/ui';
import { copy } from '../../design/copy';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomEvent } from '../../glyphs/Bloom';
import { Whisper } from '../../glyphs/Whisper';
import { useFocus } from '../../motion/focus';
import { riseIn, sceneOut } from '../../motion/presets';
import { DeviceSetup } from '../../screens/DeviceSetup';
import type { useWalletSession } from '../../services/useWalletSession';
import { usePhaseBack } from '../../stage/StageContext';
import { space } from '../../theme';
import {
  GlyphButton,
  PhaseRoot,
  refused,
  SetupPanel,
  StatusPip,
} from './parts';
import { SIZES, welcomeVisual } from './visual';

type Session = ReturnType<typeof useWalletSession>;

/**
 * Nothing is open and nothing is saved. There is no question left to ask: the
 * wallet runs on this phone, so the restore effect is already opening it. This
 * screen is the wait, and on the far side of a failure it is the one place
 * that shows so and offers the ways back in.
 *
 * The bloom unfolds the first time it appears and then breathes. While the
 * wallet opens its chase stands in for the controls. A failure half wilts it,
 * leaves a radish pip holding the reason, and turns the big control into a
 * refresh. Restore and the network settings sit either side, and the network
 * settings open the device setup, a setup surface in the Settings language.
 */
export function Welcome({
  error,
  connecting,
  initializing,
  deviceVisible,
  deviceHint,
  rememberedSession,
  openDevice,
  openWallet,
  setError,
  setDeviceVisible,
  onCreateWallet,
  network,
}: Pick<
  Session,
  | 'error'
  | 'connecting'
  | 'initializing'
  | 'deviceVisible'
  | 'deviceHint'
  | 'rememberedSession'
  | 'openDevice'
  | 'openWallet'
  | 'setError'
  | 'setDeviceVisible'
> & {
  /** Opens the new wallet sheet, in restore mode when `restoring` is set. */
  onCreateWallet: (restoring: boolean) => void;
  /** The active profile's network, whose tone the device setup draws in. */
  network?: string;
}) {
  const opening = connecting || initializing;
  const closeDevice = () => {
    setDeviceVisible(false);
    setError('');
  };
  // Back closes the device setup, as its own Back link does. While a wallet
  // is opening from it the press is held, since the link is disabled too.
  usePhaseBack(() => {
    if (!deviceVisible) return false;
    if (!connecting) closeDevice();
    return true;
  });
  const look = welcomeVisual({
    error,
    opening,
    returning: !!rememberedSession,
  });

  // The bloom stands for the screen, as a title would, so a screen reader
  // starts there and moves on to the controls.
  const focus = useFocus();
  // Closed on the first frame, so the bloom unfolds as the screen arrives.
  const [unfolded, setUnfolded] = useState(false);
  useEffect(() => setUnfolded(true), []);
  // Each new failure wilts it again, and the wilt lifts with the failure: a
  // bloom holds a wilt for as long as it is given one, so the chase after
  // Try again, and the bloom once the error clears, stand whole. The count
  // carries on across a lift, so the next failure is a new wilt that plays.
  const [wilt, setWilt] = useState<{ key: number; event?: BloomEvent }>({
    key: 0,
  });
  useEffect(() => {
    setWilt(last => {
      if (!look.wilted) return last.event ? { key: last.key } : last;
      const key = last.key + 1;
      return { key, event: { kind: 'wilt', key } };
    });
  }, [look.wilted, error]);

  if (deviceVisible) {
    return (
      <PhaseRoot key="device" style={styles.device}>
        <SetupPanel network={network}>
          <DeviceSetup
            busy={connecting}
            error={error}
            onOpen={settings =>
              openDevice(settings, {
                existingOnly: deviceHint || !!rememberedSession,
                ...(rememberedSession
                  ? {
                      walletId: rememberedSession.walletId,
                      prepared: rememberedSession.prepared,
                      backupPending: rememberedSession.backupPending,
                    }
                  : { allowEmpty: deviceHint }),
              })
            }
          />
          <LinkButton
            label={copy.phase.back}
            tone="muted"
            disabled={connecting}
            onPress={closeDevice}
          />
        </SetupPanel>
      </PhaseRoot>
    );
  }

  return (
    <PhaseRoot key="welcome">
      <View style={styles.bloom}>
        <Whisper
          label={opening ? copy.phase.openingWallet : copy.phase.tagline}
        >
          <View
            ref={focus}
            accessible
            accessibilityRole={opening ? 'progressbar' : 'image'}
            accessibilityLabel={copy.phase.tagline}
            accessibilityValue={
              opening ? { text: copy.phase.openingWallet } : undefined
            }
            accessibilityState={{ busy: opening }}
          >
            <Bloom
              size={SIZES.welcome}
              open={unfolded ? look.open : 0}
              mode={look.mode}
              event={wilt.event}
            />
          </View>
        </Whisper>
        {error ? (
          <View style={styles.pip}>
            <StatusPip tone="radish" label={error} />
          </View>
        ) : null}
      </View>
      {/* Only while nothing is opening, so there is nothing to disable. */}
      {look.primary ? (
        <Reanimated.View
          entering={riseIn()}
          exiting={sceneOut()}
          style={styles.controls}
        >
          <GlyphButton
            glyph="restore"
            look="outline"
            size={SIZES.secondary}
            label={copy.phase.restore}
            onPress={() => {
              openWallet({ restore: true })
                .then(() => onCreateWallet(true))
                .catch(refused(setError));
            }}
          />
          <GlyphButton
            glyph={look.primary.glyph}
            look="fill"
            size={SIZES.primary}
            label={look.primary.label}
            onPress={() => {
              openWallet().catch(refused(setError));
            }}
          />
          <GlyphButton
            glyph="cog"
            size={SIZES.cog}
            label={copy.phase.networkSettings}
            onPress={() => setDeviceVisible(true)}
          />
        </Reanimated.View>
      ) : null}
    </PhaseRoot>
  );
}

const styles = StyleSheet.create({
  device: { justifyContent: 'flex-start' },
  bloom: { width: SIZES.welcome, height: SIZES.welcome },
  pip: { position: 'absolute', right: space.xs, bottom: space.xs },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
});
