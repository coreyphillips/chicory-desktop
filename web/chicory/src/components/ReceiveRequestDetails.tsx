import React, { useEffect, useRef, useState } from 'react';
import {
  Share,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Reanimated from 'react-native-reanimated';
import type { Activity, ReceiveRequest } from '@beignet/wallet-core';
import { announce } from '../design/announce';
import { copy } from '../design/copy';
import { Glyph } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { CopyChip } from '../glyphs/CopyChip';
import { QrBloom } from '../glyphs/QrBloom';
import { riseIn, sceneOut } from '../motion/presets';
import { ErrorPip, GlyphButton } from '../scenes/receive/controls';
import { detailFace, requestRails } from '../scenes/receive/model';
import { TestNetwork, bloomFor } from '../scenes/receive/tone';
import { useNow } from '../services/clock';
import { recordDiagnostic } from '../services/diagnosticLog';
import { usePaneActive } from '../stage/panes/Pane';
import { duringSystemPrompt } from '../stage/systemPrompt';
import { radius, space, type as typography } from '../theme';
import type { WalletAdapter } from '../services/wallet';

/**
 * The request a payment was asked for with, as its detail keeps it
 * (REDESIGN.md 6, Detail). While it can still be paid its code blooms, it
 * can be shared, and its string is a chip that copies it; once it is paid,
 * expired or its address reused, the code and share go, and the chip only
 * keeps the string as the record. How it can be paid is a line of glyphs
 * whose label says it.
 *
 * Its lines are the detail's own: they start at the detail's edge, each led
 * by a glyph in the same 20pt column as the reference and address chips
 * under it, `qr` for the request (`bolt` for an old invoice). So the chip
 * carries `copy` as theirs do while it copies, and nothing once it is only
 * the record (P10, 22-t4-detail).
 *
 * An older request saved only its Lightning invoice. Its original request
 * can be linked back with the chain and plus, which opens a well to paste
 * the original into.
 */
export function ReceiveRequestDetails({
  item,
  client,
  onRefresh,
  onBusy,
  test = false,
}: {
  item: Activity;
  client?: WalletAdapter;
  onRefresh?: () => void;
  onBusy?: (busy: boolean) => void;
  /** A wallet on a test network, where slate stands in for bloom. */
  test?: boolean;
}) {
  const live = usePaneActive();
  const [original, setOriginal] = useState('');
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<ReceiveRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const generation = useRef({ active: true });
  const { width } = useWindowDimensions();
  useEffect(() => {
    const lifetime = { active: true };
    generation.current = lifetime;
    return () => {
      lifetime.active = false;
    };
  }, [client, item.id]);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const request =
    item.receiveRequest && !item.receiveRequest.legacy
      ? item.receiveRequest
      : linked || item.receiveRequest;
  // The countdown only runs while there is a request to count down.
  const now = useNow(1000, !!request);
  if (!request) return null;
  const legacy = 'legacy' in request && !!request.legacy;
  const face = detailFace(item, request, now);
  const { shareable } = face;
  const reused = request.bitcoinTracking === 'ambiguous';
  const how = legacy
    ? copy.receive.legacy
    : reused
    ? copy.receive.reusedAddress
    : requestRails(request).length > 1
    ? copy.receive.unified
    : copy.receive.lightningOnly;

  /**
   * A link or a share that failed: the bang beside the controls, an error
   * haptic, the whole message at once for a screen reader, and the log.
   */
  function fail(said: string, code?: string) {
    haptics.error();
    setError(said);
    announce(said, { assertive: true });
    recordDiagnostic({ phase: 'ui', message: said, code });
  }

  async function link() {
    if (!client || !item.paymentHash || working.current || !original.trim())
      return;
    working.current = true;
    setBusy(true);
    setError('');
    const current = generation.current;
    try {
      const result = await client.importReceiveRequest(
        original.trim(),
        item.paymentHash,
      );
      if (!current.active) return;
      setLinked(result);
      setOriginal('');
      setLinking(false);
      onRefresh?.();
    } catch (e) {
      if (current.active)
        fail(
          e instanceof Error ? e.message : copy.receive.linkFailed,
          (e as { code?: string })?.code,
        );
    } finally {
      working.current = false;
      if (current.active) setBusy(false);
    }
  }

  async function paste() {
    const current = generation.current;
    // iOS may ask whether to allow the paste: a prompt the app raised, which
    // the privacy cover leaves the detail in place behind.
    const text = await duringSystemPrompt(() => Clipboard.getString());
    if (current.active && text) setOriginal(text.trim());
  }

  return (
    <TestNetwork.Provider value={test}>
      <View style={styles.card}>
        {face.qr ? (
          <View style={styles.qr}>
            <QrBloom
              value={request.uri}
              size={Math.min(244, Math.max(174, width - 136))}
              state={face.qr}
              accessibilityLabel={
                legacy ? copy.receive.legacyQr : copy.receive.originalQr
              }
            />
          </View>
        ) : null}
        <View style={styles.line}>
          <View style={styles.lead}>
            <Glyph
              name={legacy ? 'bolt' : 'qr'}
              size={20}
              color={palette.dust}
            />
          </View>
          <View style={styles.chip}>
            <CopyChip
              label={
                legacy ? copy.receive.legacyInvoice : copy.receive.original
              }
              value={request.uri}
              glyph={shareable && !busy ? 'copy' : null}
              copyable={shareable && !busy}
            />
          </View>
        </View>
        {/* Words for a screen reader, not a control: drawn as text, so a
            recycled view cannot lend it a button's role. */}
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={how}
          style={styles.line}
        >
          {requestRails({ ...request, legacy }).map((rail, i) => (
            <View key={rail} style={i ? undefined : styles.lead}>
              <Glyph name={rail} size={20} color={palette.steam} />
            </View>
          ))}
          {reused ? (
            <Glyph name="twin" size={20} color={palette.honey} />
          ) : null}
        </View>
        {error ? (
          <View style={styles.pip}>
            <ErrorPip message={error} />
          </View>
        ) : null}
        <View style={styles.controls}>
          {shareable ? (
            <>
              <GlyphButton
                glyph="share"
                label={copy.receive.shareOriginal}
                size={48}
                disabled={busy}
                onPress={() => {
                  if (!working.current)
                    Share.share({ message: request.uri }).catch(() =>
                      fail(copy.receive.shareFailed),
                    );
                }}
              />
            </>
          ) : null}
          {legacy && client && item.paymentHash && !linking ? (
            <GlyphButton
              glyph="linkPlus"
              label={copy.receive.linkOriginal}
              size={48}
              onPress={() => setLinking(true)}
            />
          ) : null}
          {linked ? (
            <Reanimated.View
              entering={riseIn(8)}
              accessible
              accessibilityLabel={copy.receive.linked}
              style={styles.linked}
            >
              <Glyph name="check" size={20} color={palette.sage} />
            </Reanimated.View>
          ) : null}
        </View>
        {legacy && client && item.paymentHash && linking ? (
          <Reanimated.View
            entering={riseIn(8)}
            exiting={sceneOut()}
            style={styles.linking}
          >
            <View style={styles.well}>
              <TextInput
                accessibilityLabel={copy.receive.original}
                accessibilityHint={copy.receive.originalHint}
                value={original}
                onChangeText={live ? setOriginal : undefined}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={!busy}
                maxFontSizeMultiplier={1.4}
                selectionColor={bloomFor(test).bloom}
                style={styles.field}
              />
              <GlyphButton
                glyph="clipboard"
                label={copy.receive.paste}
                size={48}
                disabled={busy}
                onPress={() => {
                  paste().catch(() => {});
                }}
              />
            </View>
            <View style={styles.controls}>
              <GlyphButton
                glyph="close"
                label={copy.receive.cancelLink}
                size={48}
                disabled={busy}
                onPress={() => {
                  setLinking(false);
                  setOriginal('');
                  setError('');
                }}
              />
              <GlyphButton
                glyph="linkPlus"
                label={copy.receive.link}
                size={56}
                tone="primary"
                busy={busy}
                disabled={!original.trim()}
                onPress={link}
              />
            </View>
          </Reanimated.View>
        ) : null}
      </View>
    </TestNetwork.Provider>
  );
}

const styles = StyleSheet.create({
  // No inset of its own: its lines start at the detail's edge, where the
  // detail's other lines and chips start.
  card: { gap: space.xs },
  qr: { alignItems: 'center', paddingBottom: space.sm },
  line: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  lead: { width: 20, alignItems: 'center' },
  // Its content's width, and no wider than the line leaves it.
  chip: { flexShrink: 1 },
  controls: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  linked: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.sageSoft,
  },
  pip: { alignSelf: 'center' },
  linking: { alignSelf: 'stretch', gap: space.md },
  well: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    padding: space.xs,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: palette.bark,
  },
  field: {
    ...typography.mono,
    flex: 1,
    minHeight: 88,
    paddingHorizontal: space.sm,
    color: palette.cream,
    textAlignVertical: 'top',
  },
});
