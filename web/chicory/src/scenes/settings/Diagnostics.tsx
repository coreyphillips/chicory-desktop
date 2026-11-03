import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import type { WalletDiagnostics } from '@beignet/wallet-core';
import { announce } from '../../design/announce';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { SAFETY_CODE } from '../../motion/speech';
import { recentDiagnostics } from '../../services/diagnosticLog';
import type { DiagnosticEntry } from '../../services/diagnosticLog';
import { threadCount } from '../../services/processInfo';
import type { WalletAdapter } from '../../services/wallet';
import { fonts, radius, space, type } from '../../theme';
import { Action, BREAK, Note, Working } from './ui';

const words = copy.settings.diagnostics;

// Built once: constructing a formatter is what costs on Hermes.
const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/** The local time of day an entry was recorded, to the second. */
const clock = (at: string) => TIME.format(Date.parse(at));

/**
 * An entry's code as it is drawn: a line may break after each underscore,
 * between the code's words, and nowhere else. Its underscores make a code
 * one word to a line, and at the largest text size AMBIGUOUS_RECEIVE_ADDRESS
 * is wider than the card, so it would break wherever the line ran out.
 */
export const codeText = (code: string): string =>
  code.replace(/_(?=.)/g, `_${BREAK}`);

/**
 * What an entry the app logged is, by the semantic colours (REDESIGN.md
 * 3.1): a test network, slate; a safety state that needs attention rather
 * than a failure (rule 4: a held or uncertain payment, a reused address, an
 * expiry, a stale balance, a backup to save), honey; anything else failed,
 * radish.
 */
export type EntryTone = 'test' | 'attention' | 'failed';

/**
 * The codes of the safety states that need attention rather than mark a
 * failure: those the safety signals log (`SAFETY_CODE`), and Send's
 * UNCERTAIN for a payment whose outcome is unknown and QUOTE_EXPIRED for a
 * quote that ran out, as Send and Receive log them.
 */
const ATTENTION_CODES = new Set([
  SAFETY_CODE.held,
  SAFETY_CODE.stale,
  SAFETY_CODE.expired,
  SAFETY_CODE.reused,
  SAFETY_CODE.backup,
  'UNCERTAIN',
  'QUOTE_EXPIRED',
]);

/** An entry's tone by its code, never by its words, which may change. */
export function entryTone(entry: DiagnosticEntry): EntryTone {
  if (entry.code === SAFETY_CODE.testNetwork) return 'test';
  if (entry.code && ATTENTION_CODES.has(entry.code)) return 'attention';
  return 'failed';
}

const WASH: Record<EntryTone, string> = {
  test: palette.slateSoft,
  attention: palette.honeyWash,
  failed: palette.radishWash,
};

/**
 * The errors the app showed only as a glyph (phase 'ui'), newest first, each
 * with every word of its message. Outside Settings an unmapped error is a
 * radish bang and a shake; this is where its words can be read. The safety
 * states logged beside them keep their own colour (`entryTone`), so a test
 * network's line is never drawn as a failure.
 */
function RecentErrors({ entries }: { entries: DiagnosticEntry[] }) {
  if (!entries.length) return null;
  return (
    <View style={styles.errors}>
      <Text accessibilityRole="header" style={styles.subheading}>
        {words.errors}
      </Text>
      {entries.map((entry, index) => (
        <View
          key={`${entry.at}${index}`}
          style={[styles.error, { backgroundColor: WASH[entryTone(entry)] }]}
        >
          <Text style={styles.meta}>
            {entry.code
              ? `${clock(entry.at)} · ${codeText(entry.code)}`
              : clock(entry.at)}
          </Text>
          <Text selectable style={styles.message}>
            {entry.message}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What the engine reports about itself, on request. Figures only, the way
 * the shared client reads them: setup, the last channelize decision and the
 * last direct-funding offer, the chain tip, peers, channels, coins. It exists
 * so a stuck move or a refused payer can be read off the phone instead of
 * guessed at. The process's thread count sits beside the engine's figures,
 * so a copied report shows a process growing towards the system's limit.
 * Above it sit the app's own recent errors, in full.
 *
 * It is what Settings > Help > Diagnostics opens, drawn only while its row
 * is open, so it reads the report as it opens and again on Refresh, and the
 * report is turned into text only then, never on every Settings render.
 */
export function DiagnosticsPanel({ client }: { client: WalletAdapter }) {
  const [report, setReport] = useState<WalletDiagnostics | null>(null);
  const [threads, setThreads] = useState<number | null>(null);
  const [events, setEvents] = useState<DiagnosticEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A report that lands after the row has closed is not drawn.
  const alive = useRef(true);
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    setEvents(recentDiagnostics());
    threadCount().then(count => {
      if (alive.current) setThreads(count);
    });
    try {
      const next = await client.diagnostics();
      if (alive.current) setReport(next);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : words.unreadable);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  const errors = useMemo(
    () => events.filter(entry => entry.phase === 'ui').reverse(),
    [events],
  );
  const text = useMemo(
    () =>
      report
        ? JSON.stringify(
            { ...report, ...(threads === null ? {} : { threads }), events },
            null,
            1,
          )
        : '',
    [report, threads, events],
  );
  return (
    <>
      <RecentErrors entries={errors} />
      {error ? <Note tone="error">{error}</Note> : null}
      {busy && !report ? (
        <Working size={24} accessibilityLabel={words.loading} />
      ) : null}
      {report ? (
        <View style={styles.errors}>
          <Text accessibilityRole="header" style={styles.subheading}>
            {words.report}
          </Text>
          <Text selectable style={styles.report}>
            {text}
          </Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <View style={styles.slot}>
          <Action
            label={words.refresh}
            glyph="refresh"
            tone="quiet"
            busy={busy}
            onPress={load}
          />
        </View>
        <View style={styles.slot}>
          <Action
            label={words.copy}
            glyph="copy"
            tone="quiet"
            disabled={!report}
            onPress={() => {
              Clipboard.setString(text);
              announce(words.copied);
            }}
          />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  errors: { gap: space.xs },
  subheading: { ...type.label, color: palette.steam },
  error: {
    gap: space.xxs,
    padding: space.sm,
    borderRadius: radius.sm,
  },
  meta: { ...type.meta, color: palette.steam },
  message: { fontSize: 14, lineHeight: 20, color: palette.cream },
  report: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 15,
    color: palette.steam,
  },
  // Side by side and equal while their words fit, one above the other once
  // the text size needs the width.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  slot: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: '45%' },
});
