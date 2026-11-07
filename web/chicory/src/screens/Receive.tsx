import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Reanimated from 'react-native-reanimated';
import { parseSats } from '@beignet/wallet-core';
import type {
  PrimaryStatus,
  ReceiveQuote,
  ReceiveRequest,
  ReceiveStatus,
} from '@beignet/wallet-core';
import { announce } from '../design/announce';
import { copy } from '../design/copy';
import { haptics } from '../design/haptics';
import { focusAfterTransition } from '../motion/focus';
import { sceneIn, sceneOut } from '../motion/presets';
import { SAFETY_CODE, announceSafety } from '../motion/speech';
import { useFocusOn } from '../scenes/receive/focus';
import type { Focus } from '../scenes/receive/focus';
import { FormStep } from '../scenes/receive/FormStep';
import { useReceiveHost } from '../scenes/receive/host';
import { LiftedQr } from '../scenes/receive/LiftedQr';
import {
  amountCue,
  receiveRefusal,
  refusalLook,
  remainderSats,
  requestFace,
} from '../scenes/receive/model';
import type { Refused } from '../scenes/receive/model';
import { QuoteStep } from '../scenes/receive/QuoteStep';
import { RequestStep } from '../scenes/receive/RequestStep';
import { TestNetwork } from '../scenes/receive/tone';
import { useNow } from '../services/clock';
import { recordDiagnostic } from '../services/diagnosticLog';
import { useReceiveStatus } from '../services/useReceiveStatus';
import { errorMessage as message } from '../services/useWalletSession';
import type { WalletAdapter } from '../services/wallet';
import {
  loadOfflineReceiveDraft,
  saveOfflineReceiveDraft,
  clearOfflineReceiveDraft,
} from '../services/offlineReceiveDraft';
import type { OfflineReceiveDraft } from '../services/offlineReceiveDraft';
import { usePaneActive } from '../stage/panes/Pane';
import { useHoldTint } from '../stage/StageContext';
import type { Unit } from '../theme';

const codeOf = (e: unknown) => (e as { code?: string })?.code;

/**
 * Receive (REDESIGN.md 6): an amount, a quote for it, and the request it
 * becomes, which then shows what arrives for it. Everything a screen used
 * to say in sentences is said by glyphs, rings and motion here, and in the
 * labels a screen reader reads.
 */
export function ReceiveScreen({
  client,
  receivableSats = 0,
  offlineReceivableSats,
  walletId,
  primaryOfflineAvailable,
  primaries,
  disabled = false,
  opening = false,
  hidden = false,
  unit = 'sats',
  symbol = false,
  onActivity,
  onRefresh,
  onBusy,
  completionsFelt = false,
  test = false,
}: {
  client: WalletAdapter;
  receivableSats?: number;
  /**
   * The most an offline receive can take right now, 0 when no channel can
   * hold one. Undefined when the engine does not say.
   */
  offlineReceivableSats?: number;
  walletId?: string;
  primaryOfflineAvailable?: boolean | null;
  /**
   * The ranked primaries, when the engine ranks several: a quote then names
   * the one that took it, and a saved offline request is quoted at its own.
   */
  primaries?: PrimaryStatus[];
  /** Set when the wallet's balance is too old to quote against. */
  disabled?: boolean;
  /**
   * Set while the wallet is still opening on the figures it last saw. A
   * request asked for then waits, busy, for the wallet's first live read
   * and is made as it lands, rather than refused.
   */
  opening?: boolean;
  /** Amounts that arrive are masked, as the balance is. */
  hidden?: boolean;
  /** The unit amounts that arrive are shown in. */
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). Entry stays in sats. */
  symbol?: boolean;
  onActivity: () => void;
  onRefresh?: () => void;
  onBusy: (busy: boolean) => void;
  /**
   * Set where each payment that completes is felt elsewhere, as the canvas
   * feels it once for every region when the wallet reads it (`useIncoming`,
   * REDESIGN.md 10.1). Receive then leaves a completed payment to that, and
   * feels only what the wallet's history does not show as arrived: money
   * seen on its way, or part of what was asked.
   */
  completionsFelt?: boolean;
  /** A wallet on a test network, where slate stands in for bloom. */
  test?: boolean;
}) {
  const { useBack } = useReceiveHost();
  const live = usePaneActive();
  const { width } = useWindowDimensions();
  const [capacityChanged, setCapacityChanged] = useState(false);
  // With several primaries, the one a quote names, said by rank: a screen
  // reader hears which node takes the receive, and Settings draws the names.
  const peerLabel = (pubkey: string | undefined): string | undefined => {
    if (!pubkey || !primaries || primaries.length <= 1) return undefined;
    const entry = primaries.find(candidate => candidate.pubkey === pubkey);
    return entry
      ? copy.settings.primaries.rank(entry.rank)
      : `${pubkey.slice(0, 8)}…`;
  };
  // Receiving offline is an opt-in, never the default: the ordinary request
  // is paid over the home channel or provisioned by the primary just in
  // time. The switch is offered only when the engine advertises offline
  // receiving; the primary still has to offer settlement, and the engine
  // says so at quote time when it does not.
  const [offlineAvailable, setOfflineAvailable] = useState(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let active = true;
    // Read through a promise so a client without the method (the demo
    // client, older hosts) leaves the switch off rather than breaking the
    // form.
    Promise.resolve()
      .then(() => client.getConfig())
      .then(config => {
        if (active)
          setOfflineAvailable(config?.offlineReceiveAvailable === true);
      })
      .catch(() => {
        if (active) setOfflineAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [client]);
  // The engine reports remaining capacity and the primary's negotiated support.
  const offlineOffered =
    offlineAvailable &&
    primaryOfflineAvailable !== false &&
    (offlineReceivableSats === undefined || offlineReceivableSats > 0);
  // An amount is needed when the primary has to provide the capacity (a
  // just-in-time receive is quoted on it), when it changed under a quote, and
  // for an offline receive, whose slot holds one fixed amount.
  const amountRequired = receivableSats <= 0 || capacityChanged || offline;
  const pendingOffline = useRef<OfflineReceiveDraft | null>(null);
  const [amount, setAmount] = useState('');
  const cue = amountCue({
    amount,
    required: amountRequired,
    offline,
    cap: pendingOffline.current ? undefined : offlineReceivableSats,
  });
  const ready = !(amountRequired && cue.empty) && !cue.over && !cue.under;
  const [description, setDescription] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [quote, setQuote] = useState<ReceiveQuote | null>(null);
  const [quotedAt, setQuotedAt] = useState(0);
  // The engine can call a quote expired a moment before this clock does.
  const [lapsed, setLapsed] = useState(false);
  const [request, setRequest] = useState<ReceiveRequest | null>(null);
  const [createdAt, setCreatedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  // A request asked for while the wallet was still opening, made as its
  // first live read lands (`opening`).
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<Refused | null>(null);
  // Each refusal of a control shakes it once.
  const [refusals, setRefusals] = useState(0);
  const [offlineRefusals, setOfflineRefusals] = useState(0);
  const [draftReady, setDraftReady] = useState(!walletId);
  const [draftReadFailed, setDraftReadFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!walletId) return;
    setDraftReady(false);
    loadOfflineReceiveDraft(walletId)
      .then(draft => {
        if (!active) return;
        pendingOffline.current = draft;
        setDraftReadFailed(false);
        if (draft) {
          setAmount(String(draft.amountSats));
          setDescription(draft.description);
          setOffline(true);
        }
        setDraftReady(true);
      })
      .catch(e => {
        if (active) {
          setDraftReadFailed(true);
          setDraftReady(true);
          setError({
            message: message(e),
            code: 'REQUEST_SAVE_FAILED',
            amount: false,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [walletId]);
  const [lifted, setLifted] = useState(false);
  // Each copy of the request turns the copy control to a check and back.
  const [copies, setCopies] = useState(0);
  const amountError = useRef('');
  useEffect(() => {
    if (receivableSats > 0) {
      setCapacityChanged(false);
      const previousAmountError = amountError.current;
      if (previousAmountError)
        setError(previous =>
          previous?.message === previousAmountError ? null : previous,
        );
      amountError.current = '';
    }
  }, [receivableSats]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const working = useRef(false);
  const tracking = useReceiveStatus(client, request, onRefresh || (() => {}));
  const receipt =
    tracking?.status && tracking.status.phase !== 'waiting'
      ? tracking.status
      : null;
  // The clock is only read by the expiry checks below, so it runs only while
  // there is something that can expire; a request that has been paid no
  // longer can.
  const now = useNow(1000, (!!request && !receipt) || !!quote);
  const face = request
    ? requestFace({
        request,
        now,
        paid: !!receipt,
        ambiguous: !!tracking?.ambiguous,
        createdAt: request.createdAt ?? createdAt,
      })
    : null;
  const quoteExpired = quote ? lapsed || now >= quote.expiresAt : false;
  const step = request ? 'request' : quote ? 'quote' : 'form';
  // The night tint while the request being made, or shown, is an offline one.
  const night = request ? !!request.offlineReceive && !face?.expired : offline;
  useHoldTint(night ? 'night' : null);

  useArrival(receipt, request, completionsFelt);
  useWarning(!!face?.expired && !receipt && !tracking?.ambiguous, () => {
    recordDiagnostic({
      phase: 'ui',
      message: copy.receive.expired,
      code: SAFETY_CODE.expired,
    });
    return announceSafety(copy.receive.expired, 'expired');
  });
  useWarning(!!tracking?.ambiguous, () => {
    const said = tracking?.error ?? copy.receive.reusedAddress;
    recordDiagnostic({
      phase: 'ui',
      message: said,
      code: 'AMBIGUOUS_RECEIVE_ADDRESS',
    });
    return announceSafety(`${said} ${copy.receive.reusedShare}`, 'reused');
  });
  useWarning(quoteExpired, () => {
    // One the engine refused was logged in its own words as it did.
    if (!lapsed) {
      recordDiagnostic({
        phase: 'ui',
        message: copy.receive.quoteExpired,
        code: 'QUOTE_EXPIRED',
      });
    }
    return announceSafety(copy.receive.quoteExpired, 'expired');
  });
  // A stale balance holds back making a request (REDESIGN.md rule 4), which
  // a screen reader hears while there is one to make, once focus has landed.
  // The balance's own look and haptic are the canvas's.
  const heldBack = disabled && live && step !== 'request';
  useEffect(() => {
    if (heldBack) return announceSafety(copy.receive.stale, 'stale');
  }, [heldBack]);

  /**
   * Something asked for failed, and a screen reader hears why at once, in
   * Receive's words where it knows the refusal (`receiveRefusal`); the log
   * keeps the engine's own. How it looks and feels follows what it was
   * (`refusalLook`): the primary node away is a honey unplug and a warning,
   * and anything else a radish bang and an error, which shakes the control
   * that asked unless the amount answers for it. A refused amount turns
   * radish and shakes itself, as Send's amount does past what it can send,
   * with the warning its readout plays as it goes over, so the refusal is
   * felt once; the way on waits, dimmed, for another amount.
   */
  function refuse(e: unknown, shake = true): Refused {
    const raw = message(e);
    const code = codeOf(e);
    const { said, amount: refusedAmount } = receiveRefusal(raw, code);
    const look = refusalLook(code);
    if (refusedAmount) {
      // The readout plays its own as it turns radish.
    } else if (look.haptic === 'warning') haptics.warning();
    else haptics.error();
    const refused = { message: said, code, amount: refusedAmount };
    setError(refused);
    if (shake && look.shake && !refusedAmount) setRefusals(count => count + 1);
    announce(said, { assertive: true });
    recordDiagnostic({ phase: 'ui', message: raw, code });
    return refused;
  }

  async function price() {
    if (working.current || disabled || !ready || !draftReady) return;
    if (opening) {
      setWaiting(true);
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      if (offline && draftReadFailed)
        throw Error(
          'The saved request could not be read. Stop retrying it before creating another offline request.',
        );
      const pending = pendingOffline.current;
      const requestedAmount = amount.trim() ? parseSats(amount) : undefined;
      if (
        offline &&
        pending &&
        (pending.amountSats !== requestedAmount ||
          pending.description !== description.trim())
      )
        throw Error(
          'Resume the saved offline request with its original amount and note. Check Activity before creating another.',
        );
      // A saved request is quoted at the node it was quoted at; one whose
      // node is no longer a primary cannot be, and says so (the way out is
      // Stop retrying, which forgets it).
      if (
        offline &&
        pending?.peer &&
        primaries &&
        primaries.length > 0 &&
        !primaries.some(entry => entry.pubkey === pending.peer)
      )
        throw Object.assign(new Error(copy.receive.draftPeerGone), {
          code: 'OFFLINE_PEER_REMOVED',
        });
      const next = await client.quoteReceive({
        amountSats: amount.trim() ? parseSats(amount) : undefined,
        description: description.trim(),
        ...(offline
          ? {
              mode: 'offline' as const,
              requestId:
                pending?.id ??
                (quote?.mode === 'offline' ? quote.id : undefined),
              ...(pending?.peer ? { peer: pending.peer } : {}),
            }
          : {}),
      });
      setQuote(next);
      setQuotedAt(Date.now());
      setLapsed(false);
    } catch (e) {
      // The infinity shakes to a sprout instead: an amount is needed after all.
      const needsAmount = codeOf(e) === 'AMOUNT_REQUIRED';
      if (needsAmount) setCapacityChanged(true);
      // Keep the explicit mode when the engine refuses an offline request.
      const offlineRefused = offline && codeOf(e) === 'RECEIVE_UNAVAILABLE';
      if (offlineRefused) {
        setOfflineRefusals(count => count + 1);
      }
      const refused = refuse(e, !needsAmount && !offlineRefused);
      amountError.current = needsAmount ? refused.message : '';
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function create() {
    if (!quote || working.current || quoteExpired || disabled) {
      return;
    }
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      if (offline && walletId) {
        const draft: OfflineReceiveDraft = {
          id: quote.id,
          amountSats: quote.amountSats!,
          description: quote.description,
          mode: 'offline',
          // The node the quote was priced at, so a resumed draft returns to it.
          ...(quote.peer ? { peer: quote.peer } : {}),
        };
        await saveOfflineReceiveDraft(walletId, draft);
        pendingOffline.current = draft;
      }
      setRequest(await client.receive(quote));
      if (offline && walletId) {
        try {
          await clearOfflineReceiveDraft(walletId);
          pendingOffline.current = null;
        } catch (e) {
          recordDiagnostic({ phase: 'ui', message: message(e) });
        }
      }
      setCreatedAt(Date.now());
      setQuote(null);
      onRefresh?.();
    } catch (e) {
      if (codeOf(e) === 'QUOTE_EXPIRED') {
        // The quote stays, with refresh in place of create, as at zero.
        setLapsed(true);
        recordDiagnostic({ phase: 'ui', message: message(e), code: codeOf(e) });
      } else {
        refuse(e);
        if (!offline) setQuote(null);
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function dismissRetry() {
    if (working.current || !walletId) return;
    working.current = true;
    setBusy(true);
    try {
      await clearOfflineReceiveDraft(walletId);
      pendingOffline.current = null;
      setQuote(null);
      setOffline(false);
      setError(null);
      setDraftReady(true);
      setDraftReadFailed(false);
      announce(copy.receive.dismissRetryHint);
    } catch (e) {
      refuse(e);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  // The wallet has opened: a request asked for meanwhile is made now, or,
  // if the balance it opened on is still too old, held back as any is.
  useEffect(() => {
    if (!waiting) return;
    if (!live) {
      setWaiting(false);
      return;
    }
    if (opening) return;
    setWaiting(false);
    if (disabled) blocked();
    else price();
    // Runs as the wallet opens, with that render's price and gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, opening, live]);

  /** A stale balance holds a control back: it shakes, and the wallet refreshes. */
  function blocked() {
    haptics.warning();
    setRefusals(count => count + 1);
    onRefresh?.();
  }

  const shareable = !!face?.shareable;
  const uri = request?.uri;
  const lift = useCallback(() => {
    if (shareable) setLifted(true);
  }, [shareable]);
  const copyRequest = useCallback(() => {
    if (!shareable || !uri) return;
    Clipboard.setString(uri);
    announce(copy.receive.copied);
    setCopies(count => count + 1);
  }, [shareable, uri]);
  function share() {
    if (!shareable || !uri) return;
    Share.share({ message: uri }).catch(refuse);
  }
  /**
   * Another request, or the rest of this one: a partly paid request starts
   * the next at exactly what is still owed, and keeps its note.
   */
  function again() {
    const remainder = request
      ? remainderSats(request.amountSats, receipt)
      : null;
    setRequest(null);
    setLifted(false);
    setCapacityChanged(false);
    setError(null);
    setAmount(remainder !== null ? String(remainder) : '');
    if (receipt?.phase !== 'partial') {
      setDescription('');
      setNoteOpen(false);
    }
  }

  // Android back sets a lifted code down, and takes a quote back to the
  // amount it was for.
  const showLift = lifted && shareable;
  useBack(() => {
    if (showLift) {
      setLifted(false);
      return true;
    }
    if (step === 'quote' && !busy) {
      setQuote(null);
      setError(null);
      return true;
    }
    return false;
  }, live && (showLift || step === 'quote'));

  // A screen reader follows each step to what it is about, and a quote
  // running out to the refresh that replaced create.
  const focus: Focus = useRef(null);
  useFocusOn(
    focus,
    `${step} ${quoteExpired} ${face?.qr ?? ''} ${receipt?.phase ?? ''}`,
  );
  // A lifted code set down hands a screen reader back to the code it was
  // lifted from, while that code can still be paid; one that went for good
  // has the step's own focus to follow instead.
  const qrFocus: Focus = useRef(null);
  const wasLifted = useRef(false);
  useEffect(() => {
    const back = wasLifted.current && !showLift && shareable;
    wasLifted.current = showLift;
    if (back) return focusAfterTransition(() => qrFocus.current);
  }, [showLift, shareable]);

  const qr = Math.min(264, Math.max(174, width - 96));
  const amountMessage =
    error && error.message === amountError.current ? error.message : '';
  return (
    <TestNetwork.Provider value={test}>
      <View style={styles.root}>
        {/* Under a lifted code, the step it covers is out of a screen
            reader's reach, as it is out of a finger's. */}
        <Reanimated.View
          key={step}
          entering={sceneIn()}
          exiting={sceneOut()}
          accessibilityElementsHidden={showLift}
          importantForAccessibility={showLift ? 'no-hide-descendants' : 'auto'}
        >
          {request && face ? (
            <RequestStep
              request={request}
              createdAt={request.createdAt ?? createdAt}
              face={face}
              minutesLeft={Math.ceil(
                Math.max(0, request.expiresAt - now) / 60000,
              )}
              receipt={receipt}
              trackingError={tracking?.error}
              hidden={hidden}
              unit={unit}
              symbol={symbol}
              qr={qr}
              error={error}
              onLift={lift}
              onCopy={copyRequest}
              copies={copies}
              onShare={share}
              onAgain={again}
              onActivity={onActivity}
              focus={focus}
              qrFocus={qrFocus}
              lifted={showLift}
            />
          ) : quote ? (
            <QuoteStep
              quote={quote}
              quotedAt={quotedAt}
              offline={offline}
              peerLabel={peerLabel(quote.peer)}
              receivableSats={receivableSats}
              expired={quoteExpired}
              busy={busy}
              stale={disabled}
              error={error}
              shake={refusals}
              onCreate={create}
              onRequote={() => {
                setQuote(null);
                price();
              }}
              onEdit={() => {
                setQuote(null);
                setError(null);
              }}
              onBlocked={blocked}
              onDismissRetry={
                pendingOffline.current || draftReadFailed
                  ? dismissRetry
                  : undefined
              }
              focus={focus}
              symbol={symbol}
            />
          ) : (
            <FormStep
              amount={amount}
              onAmount={next => {
                setAmount(next);
                // Another amount is another ask: a refusal of the last one
                // goes, and the way on is back.
                if (error?.amount) setError(null);
              }}
              cue={cue}
              cap={pendingOffline.current ? undefined : offlineReceivableSats}
              amountMessage={amountMessage}
              note={description}
              onNote={setDescription}
              noteOpen={noteOpen}
              onNoteOpen={setNoteOpen}
              offlineOffered={offlineOffered || offline}
              offline={offline}
              offlineRefused={offlineRefusals}
              onOffline={next => {
                setOffline(next);
                setError(null);
              }}
              busy={busy || waiting}
              stale={disabled}
              ready={ready}
              error={amountMessage ? null : error}
              shake={refusals}
              onContinue={price}
              onBlocked={blocked}
              onDismissRetry={
                pendingOffline.current || draftReadFailed
                  ? dismissRetry
                  : undefined
              }
              focus={focus}
              symbol={symbol}
            />
          )}
        </Reanimated.View>
        {showLift && request ? (
          <LiftedQr
            value={request.uri}
            from={qr}
            onClose={() => setLifted(false)}
          />
        ) : null}
      </View>
    </TestNetwork.Provider>
  );
}

/**
 * Money arriving (REDESIGN.md 3.6 and 5): the incoming haptic the first time
 * a request sees any, a success when it completes after that, and each new
 * phase said to a screen reader. Where completions are felt elsewhere, a
 * payment completing is left to that, so one arrival is felt once.
 */
function useArrival(
  receipt: ReceiveStatus | null,
  request: ReceiveRequest | null,
  completionsFelt: boolean,
) {
  const heard = useRef<{
    request: ReceiveRequest | null;
    phase: ReceiveStatus['phase'] | null;
  }>({ request: null, phase: null });
  useEffect(() => {
    if (!receipt || !request) return;
    const last = heard.current;
    const first = last.request !== request;
    if (!first && last.phase === receipt.phase) return;
    heard.current = { request, phase: receipt.phase };
    const completed = receipt.phase === 'completed';
    if (!(completed && completionsFelt)) {
      if (first) haptics.incoming();
      else if (completed) haptics.success();
    }
    announce(
      receipt.phase === 'completed'
        ? copy.receive.received
        : receipt.phase === 'partial'
        ? copy.receive.partial
        : copy.receive.detected,
    );
  }, [receipt, request, completionsFelt]);
}

/**
 * A safety state starting (REDESIGN.md rule 4): the warning haptic, once,
 * and whatever else it says, each time `on` turns true. `say` may return a
 * withdrawal, as `announceSafety` does, which runs if the state ends, or the
 * scene goes, before it is heard.
 */
function useWarning(on: boolean, say: () => (() => void) | void) {
  const said = useRef(say);
  said.current = say;
  const was = useRef(false);
  const withdraw = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (on && !was.current) {
      haptics.warning();
      withdraw.current = said.current() ?? null;
    } else if (!on) {
      withdraw.current?.();
      withdraw.current = null;
    }
    was.current = on;
  }, [on]);
  useEffect(() => () => withdraw.current?.(), []);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
