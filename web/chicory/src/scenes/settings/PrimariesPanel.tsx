import React, { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { parseSats, validatePrimaryUri } from '@beignet/wallet-core';
import type { PrimaryStatus, WalletSnapshot } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { dropOut, riseIn } from '../../motion/presets';
import { amountIn } from '../../theme';
import type { Unit } from '../../theme';
import { useFieldScan } from './fieldScan';
import { StatusMark } from './hub';
import type { StatusLook } from './hubModel';
import {
  Action,
  CopyLine,
  Field,
  Line,
  Link,
  Note,
  nodeAddressText,
  testNetwork,
} from './ui';

const words = copy.settings;

/**
 * Where a ranked primary's setup is, in words: ready, setting up or failed
 * (REDESIGN.md 6, Wallet health). Never the engine's own value.
 */
export function entrySetupWord(entry: {
  setup: string;
  setupError?: string;
}): string {
  const p = words.primary;
  if (entry.setup === 'ready') return p.setupReady;
  if (entry.setupError || entry.setup === 'failed') return p.setupFailed;
  return entry.setup ? p.setupPending : p.waiting;
}

/** The mark beside a ranked primary: live, sought, or stopped short. */
export function entryLook(entry: {
  connected: boolean;
  setup: string;
  setupError?: string;
}): StatusLook {
  if (entry.setupError || entry.setup === 'failed') return 'stopped';
  return entry.connected ? 'live' : 'seeking';
}

/**
 * What Primary nodes opens when the wallet ranks several primaries
 * (coreyphillips/beignet#1924): each node in rank order with its state, the
 * balance held with it and whether the next receive goes there; the way to
 * move one up or down, to remove one (in two presses, since its channels
 * stay but its receives stop) and to retry the connections; the soft fill
 * target; and a form to add another node, whose address can be scanned as
 * the one-primary panel's can (`useFieldScan`).
 *
 * Everything drawn comes from the snapshot the engine answered with: a
 * change calls the client and the screen reads the wallet again, so the list
 * is never reordered on screen ahead of the engine.
 */
export function PrimariesPanel({
  snapshot,
  feedback,
  busy,
  unit = 'sats',
  symbol = false,
  onAdd,
  onRemove,
  onMove,
  onThreshold,
  onRetry,
}: {
  snapshot: WalletSnapshot;
  /** The screen's outcome line, drawn where the one-primary panel draws its own. */
  feedback?: ReactNode;
  busy: boolean;
  unit?: Unit;
  symbol?: boolean;
  onAdd: (
    uri: string,
    done: () => void,
    fallbackUri?: string,
  ) => Promise<void>;
  onRemove: (pubkey: string) => Promise<void>;
  onMove: (pubkey: string, direction: 'up' | 'down') => Promise<void>;
  onThreshold: (sats: number | null) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const p = words.primaries;
  const primaries: PrimaryStatus[] = snapshot.primaries ?? [];
  const [adding, setAdding] = useState(false);
  const [uri, setUri] = useState('');
  const [fallback, setFallback] = useState('');
  // Removing is a second press: the first says what stays.
  const [removing, setRemoving] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(
    snapshot.primariesThresholdSat == null
      ? ''
      : String(snapshot.primariesThresholdSat),
  );
  // The target field follows the wallet it describes.
  useEffect(() => {
    setThreshold(
      snapshot.primariesThresholdSat == null
        ? ''
        : String(snapshot.primariesThresholdSat),
    );
  }, [snapshot.primariesThresholdSat]);
  const closeAdd = () => {
    setAdding(false);
    setUri('');
    setFallback('');
  };
  const scan = useFieldScan({
    purpose: 'primary',
    validate: validatePrimaryUri,
    onCode: setUri,
    test: testNetwork(snapshot.wallet.network),
  });
  const iroh = /@iroh:/i.test(uri);
  const anyAway = primaries.some(entry => !entry.connected);
  const thresholdValue = threshold.trim();
  const thresholdValid =
    thresholdValue === '' || /^\d{1,16}$/.test(thresholdValue);
  const thresholdChanged =
    (thresholdValue === '' ? null : Number(thresholdValue)) !==
    (snapshot.primariesThresholdSat ?? null);
  return (
    <>
      <Note>{p.intro}</Note>
      {feedback}
      {primaries.map((entry, index) => (
        <View key={entry.pubkey}>
          <View
            accessibilityLabel={`${p.rank(entry.rank)}, ${nodeAddressText(
              entry.uri,
            )}`}
          >
            <Line
              label={p.rank(entry.rank)}
              value={
                entry.isReceiveTarget
                  ? `${entrySetupWord(entry)}. ${p.receiveTarget}`
                  : entrySetupWord(entry)
              }
              said={[
                p.rank(entry.rank),
                entry.connected ? words.primary.connected : words.primary.connecting,
                entrySetupWord(entry),
                entry.isReceiveTarget ? p.receiveTarget : '',
              ]
                .filter(Boolean)
                .join('. ')}
            />
            <StatusMark look={entryLook(entry)} />
          </View>
          <CopyLine
            label={words.primary.address}
            value={entry.uri}
            shown={nodeAddressText(entry.uri)}
            copyLabel={words.primary.copy}
            copiedLabel={words.primary.copied}
          />
          <Line
            label={p.balance}
            value={`${amountIn(entry.balanceSat, unit, symbol)}, ${
              entry.channelCount > 0
                ? p.channels(entry.channelCount)
                : p.noChannel
            }`}
          />
          {entry.setupError ? (
            <Note tone="error">{entry.setupError}</Note>
          ) : null}
          <Link
            label={p.moveUp(entry.rank)}
            glyph="refresh"
            disabled={busy || index === 0}
            onPress={() => onMove(entry.pubkey, 'up')}
          />
          <Link
            label={p.moveDown(entry.rank)}
            glyph="refresh"
            disabled={busy || index === primaries.length - 1}
            onPress={() => onMove(entry.pubkey, 'down')}
          />
          {removing === entry.pubkey ? (
            <>
              <Note>{p.removeKeeps}</Note>
              <Action
                label={p.confirmRemove}
                glyph="close"
                tone="danger"
                busy={busy}
                onPress={async () => {
                  await onRemove(entry.pubkey);
                  setRemoving(null);
                }}
              />
              <Link
                label={words.primary.cancel}
                tone="steam"
                disabled={busy}
                onPress={() => setRemoving(null)}
              />
            </>
          ) : (
            <Link
              label={p.remove(entry.rank)}
              glyph="close"
              tone="radish"
              disabled={busy}
              onPress={() => setRemoving(entry.pubkey)}
            />
          )}
        </View>
      ))}
      {anyAway ? (
        <Action
          label={p.retryAll}
          glyph="refresh"
          tone="quiet"
          onPress={onRetry}
          busy={busy}
        />
      ) : null}
      {adding ? (
        <Reanimated.View entering={riseIn()} exiting={dropOut(8)}>
          <View ref={scan.into} collapsable={false}>
            <Field
              label={words.primary.address}
              value={uri}
              onChangeText={setUri}
              autoCapitalize="none"
              multiline
              mono
              editable={!busy}
              focus={scan.landOn === 'field'}
            />
          </View>
          {scan.camera}
          <View ref={scan.from} collapsable={false}>
            <Action
              label={words.primary.scan}
              glyph="scan"
              tone="quiet"
              focus={scan.landOn === 'control'}
              onPress={scan.open}
            />
          </View>
          {iroh ? (
            <>
              <Note>{words.primary.iroh}</Note>
              <Field
                label={words.primary.fallback}
                value={fallback}
                onChangeText={setFallback}
                autoCapitalize="none"
                multiline
                mono
                editable={!busy}
              />
              <Note>{words.primary.fallbackHint}</Note>
            </>
          ) : null}
          <Note>{p.addHint}</Note>
          <Action
            label={words.primary.save}
            glyph="check"
            onPress={() =>
              onAdd(uri.trim(), closeAdd, iroh ? fallback.trim() : undefined)
            }
            busy={busy}
            disabled={!uri.trim()}
          />
          <Link
            label={words.primary.cancel}
            tone="steam"
            disabled={busy}
            onPress={closeAdd}
          />
        </Reanimated.View>
      ) : (
        <Link
          label={p.add}
          glyph="pencil"
          disabled={busy}
          onPress={() => {
            setAdding(true);
            scan.land('field');
          }}
        />
      )}
      <Field
        label={p.threshold}
        value={threshold}
        onChangeText={setThreshold}
        keyboardType="number-pad"
        editable={!busy}
      />
      <Note>
        {snapshot.primariesThresholdSat == null
          ? `${p.thresholdOff}. ${p.thresholdHint}`
          : p.thresholdHint}
      </Note>
      <Action
        label={p.saveThreshold}
        glyph="check"
        tone="quiet"
        busy={busy}
        disabled={!thresholdValid || !thresholdChanged}
        onPress={() =>
          onThreshold(thresholdValue === '' ? null : parseSats(thresholdValue))
        }
      />
    </>
  );
}
