import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import type {
  CreatedWallet,
  HostConfig,
  WalletRecord,
} from '@beignet/wallet-core';
import { RecoveryPhrase } from '../../components/RecoveryPhrase';
import { announce } from '../../design/announce';
import { copy } from '../../design/copy';
import { haptics } from '../../design/haptics';
import { riseIn, smooth } from '../../motion/presets';
import { seedSourceNetwork, seedSourceWallet } from '../../embedded/seed';
import type { SeedSourceWallet } from '../../embedded/seed';
import { defaultProfile } from '../../services/networks';
import type { NetworkProfile } from '../../services/networks';
import type { WalletAdapter } from '../../services/wallet';
import { fullBackupAvailable, restoreFullBackup } from '../../services/fullBackup';
import { space } from '../../theme';
import { countWords, phraseBloom } from './motion';
import { PhraseBloom } from './PhraseBloom';
import {
  Action,
  Body,
  Field,
  Line,
  Link,
  NetworkChoice,
  Note,
  Section,
  Title,
  testNetwork,
} from './ui';

type DeviceNetwork = 'mainnet' | 'regtest' | 'testnet';

const NETWORKS: readonly DeviceNetwork[] = ['mainnet', 'regtest', 'testnet'];

const words = copy.settings.create;

/**
 * A new wallet, or one restored from its phrase, in the Settings language
 * (REDESIGN.md rule 2): a setup surface, so its safety lines stay in words.
 *
 * Restoring lights a petal of the bloom for each word typed, and the restore
 * control wakes only at exactly 12 or 24. A wallet made here shows its new
 * phrase once, and only a held confirmation that it is written down opens it.
 */
export function CreateWalletScreen({
  client,
  profile,
  initialRestoring = false,
  onCreated,
  onBusy,
}: {
  client: WalletAdapter;
  profile?: NetworkProfile;
  /** Open straight into the recovery-phrase form. */
  initialRestoring?: boolean;
  onCreated: (wallet: WalletRecord) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState<string>(words.defaultName);
  const [network, setNetwork] = useState<DeviceNetwork>(
    profile?.network || 'mainnet',
  );
  const [primary, setPrimary] = useState(
    profile?.primaryUri ?? defaultProfile(profile?.network || 'mainnet').primaryUri,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<CreatedWallet | null>(null);
  // Restoring means the owner already holds the phrase: it is typed in here,
  // sent once, and never shown back.
  const [restoring, setRestoring] = useState(initialRestoring);
  const [phrase, setPhrase] = useState('');
  // The wallet refused the typed phrase, until it is changed.
  const [refused, setRefused] = useState(false);
  const phraseWords = countWords(phrase);
  const phraseReady = phraseBloom(phraseWords).ready;
  const [config, setConfig] = useState<HostConfig | null>(null);
  // Which existing wallet, if any, will supply this one's recovery phrase.
  // Creating a wallet on another network reuses the original seed, but the flow
  // said nothing about it, so it read as an entirely new wallet.
  const [seedSource, setSeedSource] = useState<DeviceNetwork | null>(null);
  // Restoring from a full backup file instead of a phrase, on desktop.
  const [fullRestore, setFullRestore] = useState(false);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const working = useRef(false);
  // On desktop, the open wallet whose phrase a wallet on another network
  // reuses, unless the owner asks for a separate one.
  const [sourceWallet, setSourceWallet] = useState<SeedSourceWallet | null>(null);
  const [separate, setSeparate] = useState(false);
  useEffect(() => {
    let active = true;
    seedSourceNetwork()
      .then(value => active && value && setSeedSource(value))
      .catch(() => {});
    seedSourceWallet(client)
      .then(value => {
        if (!active || !value) return;
        setSourceWallet(value);
        setSeedSource(value.network as DeviceNetwork);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client]);
  // The wallet whose phrase a new one here would reuse, if any.
  const source =
    !restoring && !separate && seedSource && seedSource !== network ? seedSource : null;
  // How the source is named: the wallet and its network on desktop.
  const sourceLabel = source && sourceWallet ? `${sourceWallet.name} (${sourceWallet.network})` : source;
  useEffect(() => {
    let active = true;
    client
      .getConfig()
      .then(value => {
        if (active) setConfig(value);
      })
      .catch(e => {
        if (active)
          setError(e instanceof Error ? e.message : words.unreadableConfig);
      });
    return () => {
      active = false;
    };
  }, [client]);
  useEffect(() => {
    onBusy(busy || !!created);
    return () => onBusy(false);
  }, [busy, created, onBusy]);
  function chooseNetwork(value: DeviceNetwork) {
    // A wallet of real money is a safety state (REDESIGN.md rule 4): turning
    // to mainnet is felt and read out at once, not only drawn in honey.
    if (!testNetwork(value) && testNetwork(network)) {
      haptics.warning();
      announce(words.mainnet, { assertive: true });
    }
    setNetwork(value);
    // One source for what a network starts with, so this form and the network
    // settings cannot disagree about a default.
    setPrimary(defaultProfile(value).primaryUri);
  }
  function typePhrase(value: string) {
    setPhrase(value);
    setRefused(false);
  }
  async function create() {
    if (working.current) {
      return;
    }
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const wallet = await client.createWallet({
        name: name.trim(),
        network,
        primaryUri: primary.trim(),
        // The engine is already configured for this network's server. The
        // record keeps it so a later open knows where this wallet was reading
        // the chain from.
        ...(profile?.electrum.host.trim()
          ? { electrum: profile.electrum }
          : {}),
        ...(restoring ? { mnemonic: phrase } : {}),
        // The service reads the phrase itself; only the reference is sent.
        ...(source && sourceWallet ? { seedFrom: { walletId: sourceWallet.walletId, network: sourceWallet.network } } : {}),
      } as Parameters<WalletAdapter['createWallet']>[0]);
      if (restoring) {
        // The phrase came from the owner; there is nothing new to write down.
        setPhrase('');
        const record = { ...wallet };
        delete record.mnemonic;
        if (record.warnings?.length) setCreated(record);
        else await onCreated(record);
      } else if (wallet.mnemonic) {
        setCreated(wallet);
      } else {
        // A wallet that committed without returning a phrase still carries any
        // warning the engine raised; surface it rather than dropping it.
        if (wallet.warnings?.length) setCreated(wallet);
        else await onCreated(wallet);
      }
    } catch (e) {
      if (restoring) setRefused(true);
      setError(
        e instanceof Error
          ? e.message
          : restoring
          ? words.restoreFailed
          : words.createFailed,
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  /**
   * Restores a full backup file the owner picks in the main process, then
   * opens the first wallet it brought back. Its channels stay on hold in the
   * engine until each peer shows their state is current.
   */
  async function restoreBackupFile() {
    if (working.current) return;
    const b = copy.settings.fullBackup;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await restoreFullBackup(backupPassphrase);
      if (!result) return;
      const names = result.failed.map(wallet => wallet.name).join(', ');
      if (!result.restored.length) throw new Error(result.failed.length ? b.partial(names) : b.nothing);
      announce(b.restored(result.restored.length));
      haptics.success();
      setBackupPassphrase('');
      const record = (await client.listWallets()).find(wallet => wallet.id === result.restored[0].id);
      if (!record) throw new Error(b.restoreFailed);
      await onCreated(record);
    } catch (e) {
      haptics.error();
      setError(e instanceof Error ? e.message : b.restoreFailed);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function finishBackup() {
    if (!created || working.current) {
      return;
    }
    working.current = true;
    setBusy(true);
    try {
      const record = { ...created };
      delete record.mnemonic;
      delete record.warnings;
      await onCreated(record);
      setCreated(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : words.openFailed);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const notices = (
    <>
      {created?.warnings?.map((warning, index) => (
        <Note key={index} tone="warning">
          {warning}
        </Note>
      ))}
      {error ? <Note tone="error">{error}</Note> : null}
    </>
  );
  if (created) {
    if (source)
      return (
        <View style={styles.stack}>
          <Title focus>{words.created}</Title>
          <Body>{words.sharedPhrase(network, source)}</Body>
          {notices}
          <Action
            label={words.openNetwork(network)}
            glyph="wallet"
            onPress={finishBackup}
            busy={busy}
          />
          <RecoveryPhrase initialPhrase={created.mnemonic} />
        </View>
      );
    // The honey section heads the sheet now, and a screen reader lands on
    // it: saving the phrase is the one thing left to do here.
    return (
      <View style={styles.stack}>
        {notices}
        {created.mnemonic ? (
          <RecoveryPhrase
            initialPhrase={created.mnemonic}
            onSaved={finishBackup}
            focus
          />
        ) : (
          <Action
            label={words.open}
            glyph="wallet"
            onPress={finishBackup}
            busy={busy}
            focus
          />
        )}
      </View>
    );
  }
  if (restoring && fullRestore) {
    const b = copy.settings.fullBackup;
    return (
      <View style={styles.stack}>
        <Title>{words.restoreTitle}</Title>
        <Note tone="warning" glyph="shield" focus>
          {b.restoreNote}
        </Note>
        <Field
          label={b.passphrase}
          value={backupPassphrase}
          onChangeText={value => {
            setBackupPassphrase(value);
            setError('');
          }}
          secureTextEntry
          autoCapitalize="none"
          editable={!busy}
        />
        {error ? <Note tone="error">{error}</Note> : null}
        <Action
          label={b.choose}
          glyph="restore"
          busy={busy}
          disabled={!backupPassphrase}
          onPress={restoreBackupFile}
        />
        <Link
          label={words.toRestore}
          glyph="restore"
          disabled={busy}
          onPress={() => {
            setFullRestore(false);
            setBackupPassphrase('');
            setError('');
          }}
        />
      </View>
    );
  }
  const test = testNetwork(network);
  return (
    <View style={styles.stack}>
      <Title>{restoring ? words.restoreTitle : words.title}</Title>
      {restoring ? (
        <Reanimated.View
          key="restore"
          entering={riseIn()}
          layout={smooth()}
          style={styles.stack}
        >
          <Note tone="warning" glyph="bolt">
            {words.restoreNote}
          </Note>
          <PhraseBloom count={phraseWords} test={test} wilted={refused} />
          <Field
            label={words.phrase}
            accessibilityHint={words.phraseHint}
            value={phrase}
            onChangeText={typePhrase}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            // Android's own suggestions would otherwise learn the words.
            keyboardType={
              Platform.OS === 'android' ? 'visible-password' : 'default'
            }
            secureTextEntry={false}
            editable={!busy}
          />
        </Reanimated.View>
      ) : null}
      <Section>
        <Field
          label={words.name}
          value={name}
          onChangeText={setName}
          maxLength={60}
          editable={!busy}
        />
        {profile ? (
          <Line label={words.network} value={network} />
        ) : (
          <NetworkChoice
            options={NETWORKS}
            value={network}
            disabled={busy}
            onChange={chooseNetwork}
          />
        )}
        <Field
          label={words.primary}
          value={primary}
          onChangeText={setPrimary}
          multiline
          mono
          autoCapitalize="none"
          editable={!busy}
        />
        {typeof window !== 'undefined' && window.chicoryDesktop ? <Note>{words.desktopPrimary}</Note> : null}
        <Line
          label={words.server}
          value={
            config?.defaultElectrum
              ? `${config.defaultElectrum.host}:${config.defaultElectrum.port}`
              : words.deviceServer
          }
        />
      </Section>
      {source && sourceLabel ? <Note glyph="key">{words.reuses(sourceLabel)}</Note> : null}
      {source && sourceWallet ? (
        <Link
          label={words.separatePhrase}
          glyph="sprout"
          disabled={busy}
          onPress={() => setSeparate(true)}
        />
      ) : null}
      {test ? (
        <Note glyph="flask">{words.testnet}</Note>
      ) : (
        <Note tone="warning">{words.mainnet}</Note>
      )}
      {error ? <Note tone="error">{error}</Note> : null}
      <Action
        label={restoring ? words.restore(network) : words.create(network)}
        glyph={restoring ? 'restore' : 'sprout'}
        busy={busy}
        disabled={
          !name.trim() || !primary.trim() || (restoring && !phraseReady)
        }
        onPress={create}
      />
      {restoring && fullBackupAvailable() ? (
        <Link
          label={copy.settings.fullBackup.restoreLink}
          glyph="shield"
          disabled={busy}
          onPress={() => {
            setFullRestore(true);
            setPhrase('');
            setRefused(false);
            setError('');
          }}
        />
      ) : null}
      <Link
        label={restoring ? words.toCreate : words.toRestore}
        glyph={restoring ? 'sprout' : 'restore'}
        disabled={busy}
        onPress={() => {
          setRestoring(!restoring);
          setPhrase('');
          setRefused(false);
          setError('');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ stack: { gap: space.lg } });
