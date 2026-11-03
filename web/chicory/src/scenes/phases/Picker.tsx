import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { HostInstance } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { WalletRecord } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import type { BloomTone } from '../../glyphs/Bloom';
import { useFocus } from '../../motion/focus';
import { stagger } from '../../motion/presets';
import { curves, durations } from '../../motion/tokens';
import { NetworkSettings } from '../../screens/NetworkSettings';
import type { useWalletSession } from '../../services/useWalletSession';
import { usePhaseBack, useStage } from '../../stage/StageContext';
import { radius, space } from '../../theme';
import { handOff } from './handoff';
import {
  GlyphButton,
  nameStyle,
  PhaseRoot,
  refused,
  SetupPanel,
  StatusPip,
} from './parts';
import { bloomTone, SIZES } from './visual';

type Session = ReturnType<typeof useWalletSession>;

/**
 * The device is open and no wallet is chosen yet: the saved ones, and how to
 * add one (REDESIGN.md 6, picker). Each wallet is a row of its mark, in its
 * network's tone, and its name, with a flask on a test network. A sprout row
 * under them always makes another. Restore, the network settings and the
 * lock sit along the bottom, under the rows. Choosing a wallet starts the
 * chase on its mark and dims the other rows while it opens, and the wallet's
 * page takes that mark from the row as it arrives (R-2).
 */
export function Picker({
  wallets,
  activeProfile,
  error,
  switchError,
  networkEditor,
  selecting,
  switchNetwork,
  setNetworkEditor,
  selectWallet,
  createDefaultWallet,
  disconnect,
  onCreateWallet,
}: Pick<
  Session,
  | 'activeProfile'
  | 'error'
  | 'switchError'
  | 'networkEditor'
  | 'selecting'
  | 'switchNetwork'
  | 'setNetworkEditor'
  | 'selectWallet'
  | 'createDefaultWallet'
  | 'disconnect'
> & {
  /** The saved wallets on the open network. */
  wallets: WalletRecord[];
  /** Opens the new wallet sheet, in restore mode when `restoring` is set. */
  onCreateWallet: (restoring: boolean) => void;
}) {
  // Back closes the network editor before it leaves the app.
  usePhaseBack(() => {
    if (!networkEditor) return false;
    setNetworkEditor(false);
    return true;
  });
  const focus = useFocus();
  const [chosen, setChosen] = useState<string | null>(null);
  const open = useCallback(
    (wallet: WalletRecord) => {
      setChosen(wallet.id);
      // The reason reaches the pip through the session's own error.
      selectWallet(wallet).catch(refused());
    },
    [selectWallet],
  );
  // The new wallet sheet is a settings-class surface of its own, drawn over
  // the picker, and a tree holds one at a time (REDESIGN.md 10.1): the
  // network editor closes as the picker opens the sheet, and is not drawn
  // under one opened any other way, as restore from Welcome lands here.
  const openSheet = (restoring: boolean) => {
    if (networkEditor) setNetworkEditor(false);
    onCreateWallet(restoring);
  };
  const covered = useStage().state.overlay?.name === 'create';
  const create = () => {
    // A network with no primary node cannot have a wallet made from its
    // defaults: the shared client refuses one without a node. Open the form
    // that asks for it instead of failing with a message about a URI nobody
    // was given a chance to type.
    if (!activeProfile.primaryUri.trim()) {
      openSheet(false);
      return;
    }
    setChosen(null);
    createDefaultWallet().catch(() => {});
  };
  const { network } = activeProfile;
  const tone = bloomTone(network);
  const reason = [...new Set([error, switchError].filter(Boolean))].join(' ');
  // The sprout chases only while it is what is being made; while a chosen
  // wallet opens it dims with the other rows.
  const creating = selecting && chosen === null;
  return (
    <PhaseRoot style={styles.picker}>
      <View style={styles.middle}>
        <View style={styles.header}>
          <View
            ref={focus}
            accessible
            accessibilityRole="header"
            accessibilityLabel={
              wallets.length ? copy.phase.chooseTitle : copy.phase.createTitle
            }
            accessibilityValue={{ text: network }}
            accessibilityHint={
              tone === 'test' ? copy.phase.testNetwork(network) : undefined
            }
            style={styles.mark}
          >
            <Bloom size={SIZES.cog} tone={tone} />
            {tone === 'test' ? (
              <Glyph name="flask" size={16} color={palette.slate} />
            ) : null}
          </View>
          {reason ? <StatusPip tone="radish" label={reason} /> : null}
        </View>
        <View style={styles.rows}>
          {wallets.map((wallet, index) => (
            <WalletRow
              key={wallet.id}
              wallet={wallet}
              index={index}
              busy={selecting}
              chosen={chosen === wallet.id}
              onOpen={open}
            />
          ))}
          <SproutRow
            index={wallets.length}
            busy={creating}
            disabled={selecting}
            dimmed={selecting && !creating}
            tone={tone}
            onPress={create}
          />
        </View>
        {networkEditor && !covered ? (
          <SetupPanel network={network}>
            <NetworkSettings initialNetwork={network} onApply={switchNetwork} />
          </SetupPanel>
        ) : null}
      </View>
      <View style={styles.bar}>
        <GlyphButton
          glyph="restore"
          size={SIZES.cog}
          label={copy.phase.restore}
          disabled={selecting}
          onPress={() => openSheet(true)}
        />
        <GlyphButton
          glyph={networkEditor ? 'close' : 'cog'}
          size={SIZES.cog}
          label={
            networkEditor ? copy.phase.hideNetwork : copy.phase.networkSettings
          }
          disabled={selecting}
          onPress={() => setNetworkEditor(!networkEditor)}
        />
        <GlyphButton
          glyph="lock"
          size={SIZES.cog}
          label={copy.phase.lockDevice}
          disabled={selecting}
          onPress={() => {
            disconnect();
          }}
        />
      </View>
    </PhaseRoot>
  );
}

/** How far the rows not chosen fade while the chosen one opens. */
const DIMMED = 0.35;

function useDim(dimmed: boolean) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(
      withTiming(dimmed ? DIMMED : 1, {
        duration: durations.move,
        easing: curves.standard,
      }),
    );
  }, [dimmed, opacity]);
  return useAnimatedStyle(() => ({ opacity: opacity.get() }));
}

/**
 * One saved wallet. Its network and state, which the row used to write
 * under the name, are spoken after it.
 */
const WalletRow = memo(function SavedWallet({
  wallet,
  index,
  busy,
  chosen,
  onOpen,
}: {
  wallet: WalletRecord;
  index: number;
  busy: boolean;
  chosen: boolean;
  onOpen: (wallet: WalletRecord) => void;
}) {
  const tone = bloomTone(wallet.network);
  const dim = useDim(busy && !chosen);
  const mark = useRef<HostInstance>(null);
  return (
    <Reanimated.View entering={stagger(index)} style={dim}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.phase.openWallet(wallet.name)}
        accessibilityHint={copy.phase.openWalletHint}
        accessibilityValue={{ text: `${wallet.network} · ${wallet.status}` }}
        accessibilityState={{ disabled: busy, busy: busy && chosen }}
        disabled={busy}
        onPress={() => {
          haptics.tick();
          // Measured before the wallet opens: the page that follows flies its
          // mark in from this one (R-2).
          mark.current?.measureInWindow((x, y, width, height) =>
            handOff({ x, y, width, height }),
          );
          onOpen(wallet);
        }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View ref={mark} collapsable={false}>
          <Bloom
            size={SIZES.mark}
            tone={tone}
            mode={busy && chosen ? 'chase' : 'still'}
          />
        </View>
        <Text numberOfLines={1} style={styles.name}>
          {wallet.name}
        </Text>
        {tone === 'test' ? (
          <Glyph name="flask" size={16} color={palette.slate} />
        ) : null}
      </Pressable>
    </Reanimated.View>
  );
});

/**
 * Makes a wallet from the network's defaults: a sprout, then the chase. It
 * comes after the saved wallets, the last row to rise in.
 */
function SproutRow({
  index,
  busy,
  disabled,
  dimmed,
  tone,
  onPress,
}: {
  index: number;
  busy: boolean;
  disabled: boolean;
  dimmed: boolean;
  tone: BloomTone;
  onPress: () => void;
}) {
  const dim = useDim(dimmed);
  return (
    <Reanimated.View entering={stagger(index)} style={dim}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copy.phase.createWallet}
        accessibilityValue={
          busy ? { text: copy.phase.startingWallet } : undefined
        }
        accessibilityState={{ disabled, busy }}
        disabled={disabled}
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={({ pressed }) => [
          styles.row,
          styles.sprout,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.seed}>
          {busy ? (
            <Bloom size={SIZES.mark} tone={tone} mode="chase" />
          ) : (
            <Glyph
              name="sprout"
              size={20}
              color={tone === 'test' ? palette.slate : palette.bloom}
            />
          )}
        </View>
      </Pressable>
    </Reanimated.View>
  );
}

const ROW = 64;

const styles = StyleSheet.create({
  // The rows in the middle of the page, and the tools at its foot.
  picker: { alignItems: 'stretch', justifyContent: 'space-between' },
  middle: { flexGrow: 1, justifyContent: 'center', gap: space.xl },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  mark: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  rows: { gap: space.xs },
  row: {
    minHeight: ROW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    backgroundColor: palette.espresso,
  },
  pressed: { backgroundColor: palette.mocha },
  sprout: { justifyContent: 'center' },
  name: { ...nameStyle, flex: 1, textAlign: 'left' },
  seed: {
    width: SIZES.mark + space.sm,
    height: SIZES.mark + space.sm,
    borderRadius: radius.round,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: palette.bark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.xxl,
  },
});
