import React, { memo, useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { WalletRecord } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import { usePaneActive } from '../../stage/panes/Pane';
import { radius, space, type } from '../../theme';
import { Working, testNetwork } from './ui';

const words = copy.settings.picker;

/**
 * One saved wallet: its mark, its name, a flask on a test network. The one
 * being opened turns its chevron into an orbit, which is all the wait says.
 */
const WalletRow = memo(function WalletRowView({
  wallet,
  busy,
  opening,
  onSelect,
}: {
  wallet: WalletRecord;
  busy: boolean;
  opening: boolean;
  onSelect: (wallet: WalletRecord) => void;
}) {
  const live = usePaneActive();
  const test = testNetwork(wallet.network);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={words.open(wallet.name)}
      accessibilityHint={words.openHint}
      accessibilityValue={{ text: words.status(wallet.network, wallet.status) }}
      accessibilityState={{ disabled: busy, busy: opening }}
      disabled={busy}
      onPress={
        live
          ? () => {
              haptics.tick();
              onSelect(wallet);
            }
          : undefined
      }
      style={({ pressed }) => [
        styles.wallet,
        pressed && styles.pressed,
        busy && !opening && styles.inactive,
      ]}
    >
      <Bloom size={28} tone={test ? 'test' : 'live'} />
      <Text numberOfLines={1} style={styles.name}>
        {wallet.name}
      </Text>
      {test ? <Glyph name="flask" size={16} color={palette.slate} /> : null}
      {opening ? (
        <Working size={16} color={test ? palette.slate : palette.bloom} />
      ) : (
        <Glyph name="chevron" size={16} color={palette.dust} />
      )}
    </Pressable>
  );
});

/**
 * The wallets saved on this phone for the open network (REDESIGN.md 6,
 * picker): a row each, showing its name and nothing else, and when there are
 * none, a sprout that makes one. What the old heading said is the list's name
 * for a screen reader.
 */
export function WalletPicker({
  wallets,
  busy = false,
  onSelect,
  onCreate,
}: {
  wallets: WalletRecord[];
  busy?: boolean;
  onSelect: (wallet: WalletRecord) => void;
  onCreate: () => void;
}) {
  const live = usePaneActive();
  const [chosen, setChosen] = useState('');
  const select = useCallback(
    (wallet: WalletRecord) => {
      setChosen(wallet.id);
      onSelect(wallet);
    },
    [onSelect],
  );
  return (
    <View style={styles.stack}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={wallets.length ? words.choose : words.empty}
        style={styles.header}
      />
      {wallets.map(wallet => (
        <WalletRow
          key={wallet.id}
          wallet={wallet}
          busy={busy}
          opening={busy && wallet.id === chosen}
          onSelect={select}
        />
      ))}
      {wallets.length === 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={words.create}
          accessibilityHint={busy ? words.opening : undefined}
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={
            live
              ? () => {
                  haptics.tap();
                  onCreate();
                }
              : undefined
          }
          style={({ pressed }) => [styles.create, pressed && styles.pressed]}
        >
          {busy ? (
            <Working size={28} color={palette.ink} />
          ) : (
            <Glyph name="sprout" size={32} color={palette.ink} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const CREATE = 72;

const styles = StyleSheet.create({
  stack: { gap: space.xs },
  // A point rather than nothing: a screen reader passes over an element with
  // no size at all.
  header: { width: 1, height: 1 },
  wallet: {
    minHeight: 64,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    backgroundColor: palette.espresso,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  name: { ...type.row, fontWeight: '600', color: palette.cream, flex: 1 },
  pressed: { opacity: 0.6 },
  inactive: { opacity: 0.45 },
  create: {
    width: CREATE,
    height: CREATE,
    borderRadius: CREATE / 2,
    backgroundColor: palette.bloom,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginTop: space.md,
  },
});
