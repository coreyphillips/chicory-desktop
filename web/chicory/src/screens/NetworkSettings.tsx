import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Network } from '@beignet/wallet-core';
import { copy } from '../design/copy';
import {
  Action,
  Field,
  NetworkChoice,
  Note,
  Toggle,
  Working,
} from '../scenes/settings/ui';
import { space } from '../theme';
import {
  NETWORKS,
  loadNetworkPreferences,
  saveNetworkPreferences,
  validateProfile,
} from '../services/networks';
import type { NetworkPreferences, NetworkProfile } from '../services/networks';
import {
  loadDevicePreferences,
  validateDeviceSettings,
} from '../embedded/client';
import { seedSourceNetwork } from '../embedded/seed';

const words = copy.settings.network;

/**
 * Each network's servers and primary node, in the Settings language. Nothing
 * here applies until the explicit save or switch at the bottom, and a switch
 * that fails leaves the phone on the network it is still on.
 *
 * The default primary node only seeds a wallet created on that network; a
 * wallet that exists keeps its own node. An open wallet's Settings leaves it
 * out (`defaultPrimary={false}`), so Primary node is the one place there that
 * changes the node, and a save here carries the stored default through.
 */
export function NetworkSettings({
  initialNetwork,
  busy = false,
  defaultPrimary = true,
  onApply,
}: {
  initialNetwork?: Network;
  busy?: boolean;
  defaultPrimary?: boolean;
  onApply: (profile: NetworkProfile) => Promise<void>;
}) {
  const [preferences, setPreferences] = useState<NetworkPreferences | null>(
    null,
  );
  const [profile, setProfile] = useState<NetworkProfile | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [seedSource, setSeedSource] = useState<Network | null>(null);
  // A switch replaces this screen with a full-page wait, so anything written
  // after the await below lands on a component nobody is looking at.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    loadDevicePreferences()
      .then(value => {
        if (!active) return;
        setPreferences(value);
        setProfile(value.profiles[initialNetwork || value.selectedNetwork]);
      })
      .catch(e => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [initialNetwork]);
  useEffect(() => {
    let active = true;
    seedSourceNetwork()
      .then(network => active && setSeedSource(network))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const disabled = busy || working;
  const update = (fields: Partial<NetworkProfile>) =>
    setProfile(value => value && { ...value, ...fields });
  async function apply() {
    if (!profile || !preferences || disabled) return;
    setWorking(true);
    setError('');
    try {
      validateProfile(profile, true);
      validateDeviceSettings(profile);
      // Reload before saving so a separate settings action cannot erase a legacy mapping.
      const current = await loadNetworkPreferences();
      current.profiles[profile.network] = profile;
      // The selected network deliberately stays where it is. Opening the vault
      // is what moves it, so a switch that fails leaves the phone pointed at
      // the network it is actually still on, and the next launch goes back
      // there rather than retrying the one that just failed.
      await saveNetworkPreferences(current);
      if (mounted.current) setPreferences(current);
      await onApply(profile);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : words.failed);
    } finally {
      if (mounted.current) setWorking(false);
    }
  }
  return (
    <View style={styles.stack}>
      {error ? <Note tone="error">{error}</Note> : null}
      {profile && seedSource && seedSource !== profile.network ? (
        <Note glyph="key">{words.reuses(profile.network, seedSource)}</Note>
      ) : null}
      {profile && preferences ? (
        <>
          <NetworkChoice
            options={NETWORKS}
            value={profile.network}
            disabled={disabled}
            labelFor={words.select}
            onChange={network => {
              if (network === profile.network) return;
              setPreferences({
                ...preferences,
                profiles: {
                  ...preferences.profiles,
                  [profile.network]: profile,
                },
              });
              setProfile(preferences.profiles[network]);
            }}
          />
          <View style={styles.group}>
            <Field
              label={words.server}
              accessibilityHint={words.serverHint}
              value={profile.electrum.host}
              autoCapitalize="none"
              editable={!disabled}
              onChangeText={host =>
                update({ electrum: { ...profile.electrum, host: host.trim() } })
              }
            />
            <Field
              label={words.port}
              value={String(profile.electrum.port)}
              keyboardType="number-pad"
              editable={!disabled}
              onChangeText={port =>
                update({
                  electrum: { ...profile.electrum, port: Number(port) },
                })
              }
            />
            <Toggle
              label={words.tls}
              accessibilityLabel={words.tlsLabel}
              value={profile.electrum.tls}
              disabled={disabled}
              onValueChange={tls =>
                update({ electrum: { ...profile.electrum, tls } })
              }
            />
          </View>
          <View style={styles.group}>
            {defaultPrimary ? (
              <Field
                label={words.primary}
                accessibilityHint={words.primaryHint}
                value={profile.primaryUri}
                autoCapitalize="none"
                multiline
                mono
                editable={!disabled}
                onChangeText={primaryUri => update({ primaryUri })}
              />
            ) : null}
          </View>
          <Action
            label={
              initialNetwork === profile.network
                ? words.save
                : words.use(profile.network)
            }
            glyph={initialNetwork === profile.network ? 'check' : 'swap'}
            busy={disabled}
            disabled={disabled || !profile.electrum.host.trim()}
            onPress={apply}
          />
        </>
      ) : (
        <View style={styles.waiting}>
          <Working size={24} accessibilityLabel={words.loading} />
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  stack: { gap: space.lg },
  group: { gap: space.md },
  waiting: { minHeight: 96, alignItems: 'center', justifyContent: 'center' },
});
