import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { parsePayment } from '@beignet/wallet-core';
import type {
  DrainProgress,
  SendResult,
  SendReview,
  WalletSnapshot,
} from '@beignet/wallet-core';
import { announce } from '../../design/announce';
import { copy } from '../../design/copy';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { chipText } from '../../glyphs/chipText';
import { HoldButton } from '../../glyphs/HoldButton';
import { dropOut, riseIn } from '../../motion/presets';
import { announceSafety } from '../../motion/speech';
import { overlap } from '../../motion/tokens';
import { recordDiagnostic } from '../../services/diagnosticLog';
import { errorMessage } from '../../services/useWalletSession';
import type { WalletAdapter } from '../../services/wallet';
import { usePaneActive } from '../../stage/panes/Pane';
import { duringSystemPrompt } from '../../stage/systemPrompt';
import { amountIn, space, type } from '../../theme';
import type { Unit } from '../../theme';
import { errorCode } from '../send/model';
import { SPENT_OPACITY } from '../send/ReviewLines';
import { untilInFront } from '../send/untilInFront';
import { useFieldScan } from './fieldScan';
import { useSettingsHost } from './host';
import {
  Action,
  CopyLine,
  Field,
  Line,
  Link,
  Note,
  testNetwork,
  wholeWords,
} from './ui';
import type { NoteTone } from './ui';

const words = copy.settings.empty;

/** How often a drain under way is read again while it is shown, in ms. */
export const DRAIN_POLL_MS = 5000;

const inProgress = (snapshot: WalletSnapshot) =>
  snapshot.activity.find(
    row => row.drain && !['completed', 'failed'].includes(row.status),
  )?.drain;
const mergeProgress = (old: DrainProgress | undefined, next: DrainProgress) =>
  !old || (old.requestId === next.requestId && next.revision >= old.revision)
    ? next
    : old;

/**
 * An amount as Settings writes it in a line of text, in the unit the
 * balance is shown in: `261,000 sats`, `₿261,000` (BIP 177) or
 * `0.00261 BTC`. A screen reader hears it in sats wherever it is drawn
 * (`copy.amount.spoken`).
 */
export function amountText(sats: number, unit: Unit, symbol = false): string {
  const shown = amountIn(sats, unit, symbol);
  return `${shown.prefix}${shown.value}${
    shown.suffix ? ` ${shown.suffix}` : ''
  }`;
}

/**
 * What the progress note says of a drain in `phase`, and its tone. In
 * flight, whether preparing, closing the channel, sweeping or waiting on
 * confirmations, it is pending, with the accent's orbit; cancelling is
 * pending too, in its own words, since the channel is staying. A drain in
 * review after the hold is one whose start the wallet has not confirmed: a
 * safety state, in honey. Completed is sage, and cancelled only says so.
 */
export function progressNote(phase: DrainProgress['phase']): {
  tone: NoteTone;
  message: string;
} {
  switch (phase) {
    case 'completed':
      return { tone: 'success', message: words.completed };
    case 'cancelled':
      return { tone: 'info', message: words.cancelled };
    case 'review':
      return { tone: 'warning', message: words.uncertain };
    case 'cancelling':
      return { tone: 'pending', message: words.cancelling };
    case 'preparing':
    case 'closing':
    case 'sweeping':
    case 'pending':
      return { tone: 'pending', message: words.pending };
  }
}

/** What the surface is doing for the person: one operation at a time. */
type Work = 'review' | 'send' | 'keep' | 'paste';

/**
 * An engine call whose failure is written to the diagnostic log with the
 * engine's own words and code, as Send logs its refusals (REDESIGN.md 6,
 * Engine errors), and then passed on to be shown.
 */
async function logged<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (reason) {
    recordDiagnostic({
      phase: 'ui',
      code: errorCode(reason) || undefined,
      message: errorMessage(reason),
    });
    throw reason;
  }
}

/** Whether the app is in front, which a read nobody would see waits for. */
const inFront = () =>
  AppState.currentState !== 'background' &&
  AppState.currentState !== 'inactive';

/**
 * The review of a drain: what arrives and what the network fees take, in
 * the wallet's unit and heard in sats, the address in full, and the hold
 * that sends everything.
 *
 * The hold is Send's (REDESIGN.md rule 5 and 5, HoldButton), always warned:
 * it closes a channel and sends every coin, so it fills in honey over
 * 1000ms, timed on the UI thread, and turns to an orbit while the send is
 * under way. As it commits, the figures fade to .4 with the flash, as
 * Send's sum does, so the review reads as money going out rather than one
 * still to check. A screen reader commits it with one action, so its value
 * says the review it commits. Its name is drawn under it for a finger,
 * which a screen reader hears from the hold itself.
 *
 * It is keyed by the review, so a new one starts with its figures whole.
 */
function DrainReview({
  review,
  unit,
  symbol,
  test,
  busy,
  disabled,
  onCommit,
}: {
  review: SendReview;
  unit: Unit;
  symbol: boolean;
  test: boolean;
  busy: boolean;
  disabled: boolean;
  onCommit: () => void;
}) {
  const commit = useSharedValue(0);
  const spent = useAnimatedStyle(() => ({
    opacity: 1 - (1 - SPENT_OPACITY) * commit.get(),
  }));
  const arrives = copy.amount.spoken(review.amountSats);
  const fees = copy.amount.spoken(review.feeSats);
  return (
    <Reanimated.View
      entering={riseIn(overlap.rise, overlap.enterDelay)}
      exiting={dropOut(8)}
      style={styles.stack}
    >
      <Reanimated.View style={[styles.stack, spent]}>
        <Line
          label={words.arrives}
          value={amountText(review.amountSats, unit, symbol)}
          said={arrives}
          focus
        />
        <Line
          label={words.fees}
          value={amountText(review.feeSats, unit, symbol)}
          said={fees}
        />
      </Reanimated.View>
      <CopyLine
        label={words.address}
        value={review.destination}
        shown={chipText(review.destination, true)}
        copyLabel={words.copy}
        copiedLabel={words.copied}
      />
      <Note>{words.estimate}</Note>
      <View style={styles.hold}>
        <HoldButton
          accessibilityLabel={words.send}
          accessibilityHint={words.hold}
          accessibilityValue={{ text: words.said(arrives, fees) }}
          onCommit={onCommit}
          warning
          busy={busy}
          disabled={disabled}
          test={test}
          commit={commit}
        />
        <Text
          {...wholeWords(words.send)}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.holdLabel, disabled && styles.holdLabelOff]}
        >
          {words.send}
        </Text>
      </View>
    </Reanimated.View>
  );
}

/**
 * Settings > Empty wallet to an address: closes the home channel and sends
 * its balance and every loose coin to one Bitcoin address. The coordinator
 * in the engine owns the money and its retries; this surface owns only a
 * review, the hold that commits it, and following what the coordinator
 * says after.
 *
 * Its link opens a warning, felt as it opens as Erase's is, an address field
 * that a scan or a paste can fill, and the review. The scan is the stage's
 * overlay, its disc growing from the scan button and collapsing into the
 * field as a code fills it (`useFieldScan`); a paste reads the clipboard
 * inside `duringSystemPrompt` and lands once the app is in front again.
 * Bitcoin links that name an amount, and anything not an address on the
 * wallet's network, are refused before any review, said and felt, but not
 * logged: nothing reached the engine.
 *
 * The form and the review swap in place, the one going as the other rises
 * (REDESIGN.md 3.5), and Android back steps from the review to the form,
 * keeping the address. One thing at a time is under way, and the control
 * that asked for it turns to an orbit: Review, Paste, the hold, or Keep my
 * channel. An engine's refusal is shown, felt as an error, and logged with
 * its own words.
 *
 * After the hold the drain is followed until it completes: a note in its
 * tone (`progressNote`), the address, and what came in since the review,
 * which stays in the wallet. A screen reader lands on the note the person's
 * own hold brought; later changes are said and felt, never moved to. A drain whose start the
 * wallet has not confirmed is a safety state (REDESIGN.md rule 4): honey,
 * the held haptic, an UNCERTAIN entry in the log and an assertive
 * announcement, and only Keep my channel, which the coordinator answers
 * only while cancelling is still safe. While shown and the app is in front,
 * the drain is read again every 5s, and the wallet with it, quietly, only
 * when the coordinator's revision has moved.
 *
 * Amounts are in the wallet's unit, the review's always shown, whatever
 * the balance's mask. A screen reader hears sats.
 *
 * Given `onClose`, a row of its own opens it: it starts open, draws no link,
 * and Keep my channel closes the row through `onClose`.
 */
export function EmptyWallet({
  client,
  snapshot,
  disabled = false,
  onRead,
  unit = 'sats',
  symbol = false,
  onClose,
}: {
  client: WalletAdapter;
  snapshot: WalletSnapshot;
  disabled?: boolean;
  /** Reads the wallet again quietly, with no spinner and no resync. */
  onRead: () => unknown;
  /** The unit the balance is shown in. */
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  /** Closes the row this is drawn in, which opened it. */
  onClose?: () => void;
}) {
  const live = usePaneActive();
  const host = useSettingsHost();
  const test = testNetwork(snapshot.wallet.network);
  const [open, setOpen] = useState(() => !!onClose);
  const [address, setAddress] = useState('');
  const [review, setReview] = useState<SendReview | null>(null);
  const [progress, setProgress] = useState<DrainProgress | undefined>(() =>
    inProgress(snapshot),
  );
  const [working, setWorking] = useState<Work | null>(null);
  const [error, setError] = useState('');
  const [kept, setKept] = useState(false);
  // The note a screen reader lands on: the one the person's own hold
  // brought, and no later one.
  const [landing, setLanding] = useState('');
  const alive = useRef(true);
  const operation = useRef(0);
  const locked = useRef(false);
  const known = useRef(new Map<string, DrainProgress>());
  // What the engine said of a send whose start it has not confirmed, for
  // the log to keep its words.
  const engineSaid = useRef(new Map<string, string>());
  const remember = useCallback((next: DrainProgress) => {
    const latest = mergeProgress(known.current.get(next.requestId), next)!;
    known.current.set(next.requestId, latest);
    return latest;
  }, []);
  const read = useRef(onRead);
  read.current = onRead;
  const readWallet = useCallback(() => {
    Promise.resolve(read.current()).catch(() => {});
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    for (const row of snapshot.activity) if (row.drain) remember(row.drain);
    setProgress(old => {
      if (old) remember(old);
      const active = [...known.current.values()]
        .reverse()
        .filter(row => !['completed', 'cancelled'].includes(row.phase))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return active ?? (old && known.current.get(old.requestId));
    });
  }, [snapshot, remember]);
  const requestId = progress?.requestId;
  const settled =
    progress?.phase === 'completed' || progress?.phase === 'cancelled';
  // A quiet read of the drain while it is shown, and of the wallet only
  // when the coordinator has moved it on: restarting and resyncing the
  // wallet behind the pull's spinner every 5s told it nothing new.
  useEffect(() => {
    if (!requestId || settled || !live) return;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending || !inFront()) return;
      pending = true;
      try {
        const next = await client.getDrain(requestId);
        if (!active) return;
        const before = known.current.get(next.requestId);
        const latest = remember(next);
        setProgress(old => mergeProgress(old, latest));
        if (!before || latest.revision > before.revision) readWallet();
      } catch {
        /* Activity retains the durable identity while disconnected. */
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(poll, DRAIN_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, requestId, settled, live, remember, readWallet]);

  const validate = (value: string) => {
    const parsed = parsePayment(value, { network: snapshot.wallet.network });
    if (parsed.kind !== 'onchain') throw new Error(words.addressOnly);
    if (parsed.amountSats != null) throw new Error(words.noAmount);
    return parsed.address;
  };
  const change = (value: string) => {
    operation.current++;
    setAddress(value);
    setReview(null);
    setError('');
  };
  const scan = useFieldScan({
    purpose: 'address',
    validate,
    onCode: change,
    test,
  });
  const run = async (
    work: Work,
    action: (revision: number) => Promise<void>,
  ) => {
    if (locked.current) return;
    locked.current = true;
    const revision = ++operation.current;
    setWorking(work);
    setError('');
    try {
      await action(revision);
    } catch (reason) {
      if (alive.current && revision === operation.current) {
        haptics.error();
        setError(reason instanceof Error ? reason.message : words.failed);
      }
    } finally {
      locked.current = false;
      if (alive.current) setWorking(null);
    }
  };
  const prepare = () =>
    run('review', async revision => {
      // An address refused here never reached the engine: said, not logged.
      const target = validate(address);
      const next = await logged(client.prepareDrain({ address: target }));
      if (!alive.current || revision !== operation.current) return;
      scan.land(null);
      setReview(next);
    });
  const keep = () =>
    run('keep', async revision => {
      const id = progress?.requestId ?? review?.id;
      // The coordinator confirms the channel stays before it answers, which
      // can take a while: a screen reader hears that it is under way, as a
      // finger sees the link turn to an orbit.
      if (id) announce(words.keeping);
      if (id) remember(await logged(client.cancelDrain(id)));
      if (!alive.current || revision !== operation.current) return;
      setReview(null);
      setProgress(old => (old?.requestId === id ? undefined : old));
      readWallet();
      if (onClose) {
        onClose();
        return;
      }
      setOpen(false);
      setKept(true);
    });
  const submit = () =>
    run('send', async revision => {
      if (!review) return;
      let result: SendResult;
      try {
        result = await logged(client.send(review));
      } catch (reason) {
        if (alive.current && revision === operation.current) {
          setReview(null);
          scan.land('field');
        }
        throw reason;
      }
      if (!alive.current || revision !== operation.current) return;
      setReview(null);
      if (result.status === 'failed') {
        recordDiagnostic({
          phase: 'ui',
          code: 'FAILED',
          message: result.message,
        });
        scan.land('field');
        throw new Error(result.message);
      }
      if (result.drain) {
        const next = remember(result.drain);
        if (result.status === 'uncertain') {
          engineSaid.current.set(next.requestId, result.message);
        }
        setProgress(old => mergeProgress(old, next));
        setLanding(`${next.requestId}:${progressNote(next.phase).message}`);
        if (result.status === 'pending') haptics.soft();
        if (result.status === 'completed') haptics.success();
      }
      readWallet();
    });
  const paste = () =>
    run('paste', async revision => {
      let value: string;
      try {
        value = (await duringSystemPrompt(() => Clipboard.getString())) ?? '';
      } catch {
        await untilInFront();
        throw new Error(words.clipboardUnreadable);
      }
      // What the paste brings lands once the system's prompt has gone.
      await untilInFront();
      if (!value.trim()) throw new Error(words.clipboardEmpty);
      const taken = validate(value.trim());
      if (!alive.current || revision !== operation.current) return;
      change(taken);
      announce(words.pasted);
    });

  // Android back steps from the review to the form, keeping the address,
  // and lands on the field.
  host.useBack(() => {
    if (!review || working) return false;
    setReview(null);
    setError('');
    scan.land('field');
    return true;
  }, !!review && !working && live);

  // The warning is felt as it opens, as Erase's is: from the link, or as a
  // row of its own opens it.
  const following = useRef(progress);
  following.current = progress;
  useEffect(() => {
    if (open && !following.current) haptics.warning();
  }, [open]);

  // A drain whose start the wallet has not confirmed is a safety state
  // (REDESIGN.md rule 4): felt, logged and said each time it shows, and no
  // longer said once it has gone.
  const uncertain = progress?.phase === 'review' ? progress.requestId : '';
  useEffect(() => {
    if (!uncertain) return;
    haptics.held();
    recordDiagnostic({
      phase: 'ui',
      code: 'UNCERTAIN',
      message: engineSaid.current.get(uncertain) ?? words.uncertain,
    });
    return announceSafety(words.uncertainAnnouncement, 'held');
  }, [uncertain]);

  // A later change to the drain shown is said and felt, but takes no one's
  // focus: completed is a success, the rest a soft tap. An unknown start is
  // felt and said as its own safety state, above. What the page first shows
  // of a drain, and what the person's own hold brought, are not news.
  const note = progress ? progressNote(progress.phase) : null;
  const message = note?.message ?? '';
  const tone = note?.tone;
  const followed = progress?.requestId ?? '';
  const seen = useRef<{ id: string; message: string } | null>(null);
  useEffect(() => {
    const last = seen.current;
    seen.current = followed ? { id: followed, message } : null;
    if (!followed || !last || last.id !== followed) return;
    if (last.message === message) return;
    // The note the hold brought has gone, and no later one takes focus,
    // even one that says the same again, as a reorg's pending does.
    setLanding('');
    if (tone === 'warning') return;
    if (tone === 'success') haptics.success();
    else haptics.soft();
    announce(message);
  }, [followed, message, tone]);

  if (progress && note) {
    const noteKey = `${progress.requestId}:${note.message}`;
    const residual = progress.residualSats;
    return (
      <Reanimated.View
        key={`progress:${progress.requestId}`}
        entering={riseIn()}
        exiting={dropOut(8)}
        style={styles.stack}
      >
        <Note key={noteKey} tone={note.tone} focus={noteKey === landing}>
          {note.message}
        </Note>
        <CopyLine
          label={words.address}
          value={progress.address}
          shown={chipText(progress.address, true)}
          copyLabel={words.copy}
          copiedLabel={words.copied}
        />
        {residual ? (
          <Note said={words.residual(copy.amount.spoken(residual))}>
            {words.residual(amountText(residual, unit, symbol))}
          </Note>
        ) : null}
        {error ? <Note tone="error">{error}</Note> : null}
        {['review', 'preparing', 'cancelling'].includes(progress.phase) ? (
          <Link
            label={words.keep}
            tone="steam"
            busy={working === 'keep'}
            disabled={!!working}
            onPress={keep}
          />
        ) : null}
      </Reanimated.View>
    );
  }
  if (!open)
    return (
      <Link
        label={words.link}
        glyph="send"
        disabled={disabled}
        focus={kept}
        onPress={() => {
          setOpen(true);
          setKept(false);
        }}
      />
    );
  return (
    <Reanimated.View
      key="open"
      entering={riseIn()}
      exiting={dropOut(8)}
      style={styles.stack}
    >
      <Note tone="warning" focus>
        {words.warning}
      </Note>
      {error ? <Note tone="error">{error}</Note> : null}
      {review ? (
        <DrainReview
          key={`review:${review.id}`}
          review={review}
          unit={unit}
          symbol={symbol}
          test={test}
          busy={working === 'send'}
          disabled={disabled}
          onCommit={submit}
        />
      ) : (
        <Reanimated.View
          key="form"
          entering={riseIn(overlap.rise, overlap.enterDelay)}
          exiting={dropOut(8)}
          style={styles.stack}
        >
          {/* Measured as the scan opens: a code read collapses into the
              field, and the disc grows out of the button. */}
          <View ref={scan.into} collapsable={false}>
            <Field
              label={words.address}
              value={address}
              onChangeText={change}
              mono
              multiline
              autoCapitalize="none"
              editable={!working}
              focus={scan.landOn === 'field'}
            />
          </View>
          {scan.camera}
          <View ref={scan.from} collapsable={false}>
            <Action
              label={words.scan}
              glyph="scan"
              tone="quiet"
              disabled={!!working}
              focus={scan.landOn === 'control'}
              onPress={scan.open}
            />
          </View>
          <Action
            label={words.paste}
            glyph="clipboard"
            tone="quiet"
            disabled={!!working}
            busy={working === 'paste'}
            onPress={paste}
          />
          <Action
            label={words.review}
            glyph="check"
            disabled={!!working || disabled || !address.trim()}
            busy={working === 'review'}
            onPress={prepare}
          />
        </Reanimated.View>
      )}
      <Link
        label={words.keep}
        tone="steam"
        busy={working === 'keep'}
        disabled={!!working}
        onPress={keep}
      />
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.md },
  // The hold, centred, with its name under it.
  hold: {
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.xs,
  },
  holdLabel: {
    ...type.label,
    fontSize: 15,
    lineHeight: 20,
    color: palette.cream,
    textAlign: 'center',
  },
  holdLabelOff: { color: palette.dust },
});
