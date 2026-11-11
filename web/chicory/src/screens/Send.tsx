import React, {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode, Ref } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { HostInstance } from 'react-native';
import Reanimated, { useSharedValue } from 'react-native-reanimated';
import Clipboard from '@react-native-clipboard/clipboard';
import { parseSats } from '@beignet/wallet-core';
import type {
  Activity,
  MaxQuote,
  SendInput,
  SendResult,
  SendReview,
  WalletSnapshot,
} from '@beignet/wallet-core';
import { Scanner } from '../components/Scanner';
import { Chip } from '../components/ui';
import { copy } from '../design/copy';
import { Glyph, HISTORY_GLYPH } from '../design/glyphs';
import type { GlyphName } from '../design/glyphs';
import { haptics } from '../design/haptics';
import { palette } from '../design/palette';
import { CopyChip } from '../glyphs/CopyChip';
import { Whisper } from '../glyphs/Whisper';
import { inlineAmount } from '../glyphs/InlineAmount';
import { useLoop } from '../motion/loops';
import {
  fadeIn,
  riseIn,
  sceneIn,
  sceneOut,
  smooth,
  vanishIf,
} from '../motion/presets';
import { announceSafety } from '../motion/speech';
import { durations, overlap } from '../motion/tokens';
import { useMotionPrefs } from '../motion/useMotionPrefs';
import { AmountReadout } from '../scenes/keypad/AmountReadout';
import { digitsOnly, grouped } from '../scenes/keypad/keys';
import type { AmountTone } from '../scenes/keypad/keys';
import { Amount } from '../scenes/send/Amount';
import { autoPayCandidate, autoPays } from '../scenes/send/autoPay';
import { ARRIVE_MS, watchCentre } from '../scenes/send/arrival';
import type { Arrival, Origin as Centre } from '../scenes/send/arrival';
import { Commit } from '../scenes/send/Commit';
import { CircleControl } from '../scenes/send/Controls';
import { FailureMark } from '../scenes/send/FailureMark';
import { FeeSlider } from '../scenes/send/FeeSlider';
import { GlyphButton } from '../scenes/send/GlyphButton';
import {
  BROADCAST_POLL_MS,
  BROADCAST_WATCH_MS,
  HOME_AFTER_MS,
  REQUOTE_BEAT_MS,
  SEND_GRACE_MS,
  alreadySubmitted,
  amountTone,
  amountWords,
  chainStage,
  errorCode,
  feeRange,
  fixedAmount,
  heldVisual,
  isUncertain,
  isPayAllReview,
  isRatedReview,
  previewReview,
  rateRefusal,
  resultVisual,
  reviewRail,
  requestRefusal,
  reviewWaiting,
  reviewWords,
  sendFailure,
} from '../scenes/send/model';
import type { Failure } from '../scenes/send/model';
import { RequestEntry } from '../scenes/send/RequestEntry';
import type { Origin } from '../scenes/send/RequestEntry';
import { ResultMark } from '../scenes/send/ResultMark';
import { LINE_SCALE, ReviewLines } from '../scenes/send/ReviewLines';
import { useLanding } from '../scenes/send/useLanding';
import { untilInFront } from '../scenes/send/untilInFront';
import { useScreenReader } from '../scenes/send/useScreenReader';
import { TestNetwork } from '../scenes/send/tone';
import type { Landing } from '../scenes/send/useLanding';
import { autoPayNow } from '../services/autoPayPreference';
import { recordDiagnostic } from '../services/diagnosticLog';
import { errorMessage } from '../services/useWalletSession';
import type { WalletAdapter } from '../services/wallet';
import {
  completedHere,
  heldRequest,
  heldVersion,
  holdRequest,
  submissionId,
  subscribeHeld,
} from '../stage/heldRequests';
import type { HeldOutcome } from '../stage/heldRequests';
import { CONTROL_ROW, PRIMARY_CONTROL } from '../stage/layout';
import { useLaunchLanding } from '../stage/panes/Launch';
import { usePaneActive } from '../stage/panes/Pane';
import { useFlashTint, useHoldTint } from '../stage/StageContext';
import { duringSystemPrompt } from '../stage/systemPrompt';
import { MASK, space, statusLabel, type as typography } from '../theme';
import type { Unit } from '../theme';

/** What a Send on the canvas asks of the screen inside it. */
export interface SendHandle {
  /** Android back: a step back inside Send, or false for the stage's own. */
  back: () => boolean;
  /**
   * A code the scan overlay read for this Send. `scanned` says the camera
   * read it, which is the only way a request may pay itself (Auto-pay).
   */
  receive: (code: string, scanned?: boolean) => void;
}

/**
 * The payment `result` is, once the history shows it: by its invoice's
 * payment hash, its transaction, or the row of this app's submission of it,
 * which is how a payment to an address the engine answered without its
 * transaction is found until the history names one.
 */
const paymentOf = (
  result: SendResult | HeldOutcome,
  activity: Activity[] = [],
) =>
  activity.find(
    payment =>
      (!!result.paymentHash && payment.paymentHash === result.paymentHash) ||
      (!!result.txid && payment.txid === result.txid) ||
      (!!result.id && payment.id === submissionId(result.id)),
  ) ?? null;

/**
 * What the history has shown of a payment broadcasting on chain since its
 * answer, kept once shown: that its transaction is out, and which one, or
 * that it came to nothing or to an unknown outcome first. Kept, because a
 * read can leave a pending row out, and the disc never turns back into the
 * orbit for it.
 */
type Followed =
  | { broadcast: true; txid?: string }
  | { broadcast?: false; status: 'failed' | 'uncertain' };

/**
 * The control under a result that opens the history. An orbit there would
 * read as money still moving, under a payment that is done or held, so it
 * is the history's own glyph, as Receive's receipt draws it.
 */
const ACTIVITY_GLYPH: GlyphName = HISTORY_GLYPH;

/**
 * What the Reference chip holds while it keeps its place, unseen: a space
 * that keeps the chip's line, and draws nothing.
 */
const NOTHING_YET = '\u00a0';

/** A quote this close to running out is said aloud once. */
const LATE_MS = 10_000;

/**
 * A quote that ran out on its clock. An expired quote is a safety state
 * (REDESIGN.md rule 4): the hold gives way to a refresh, and the change is
 * felt and logged as it happens, and said through `announceSafety` once a
 * screen reader has landed on the refresh. Returns the withdrawal, for a
 * quote refreshed, or a Send gone, before it is heard.
 */
function quoteExpired(): () => void {
  haptics.warning();
  recordDiagnostic({
    phase: 'ui',
    code: 'QUOTE_EXPIRED',
    message: copy.send.quoteExpired,
  });
  return announceSafety(copy.send.quoteExpired, 'expired');
}

/**
 * Paying a request (REDESIGN.md 6, Send). Compose takes the request in a
 * well and the amount on the keypad; review lays out the sum and holds the
 * payment behind a 700ms hold inside the quote's countdown; the result is a
 * mark that says how it went. A request whose earlier payment is pending or
 * unknown never reaches a review: it lands on the held ring (rule 6). Nor
 * does one that is paid: an invoice, or a Bitcoin request that names its
 * amount, lands on its paid mark at rest, however it comes back. The
 * request holds its place from step to step while what is under it
 * crossfades, so each step blends into the next rather than replacing it.
 *
 * The screen says nothing in words. Each state is a glyph, a ring, a colour
 * and a motion, and its words are what a screen reader hears and what a long
 * press shows.
 *
 * As each step settles a screen reader lands on its primary element
 * (REDESIGN.md 9), and what the step says aloud waits until it has: a review
 * lands on its amount, at the head of the sum, never on the hold; a quote
 * running out or the balance going stale lands on the control that takes
 * the hold's place, and a fresh quote back on the amount; a result or the
 * held ring on its mark; and back in compose, on the amount.
 *
 * Amounts are shown in `unit`, the one the balance is in, and sats as
 * `₿2,000` when `symbol` is on. While amounts are hidden (`masked`) a result
 * and the held ring show theirs as dots, as the fee paid; a review never
 * does, since it is where the payment is checked before it is sent. A screen
 * reader always hears sats.
 *
 * A payment holds the stage busy for SEND_GRACE_MS at most. One still out
 * after that lets the stage go and moves to the held ring, so Close works
 * and the history is a tap away while the call goes on; its answer is
 * recorded whenever it comes, and shown here if the held ring still is:
 * a payment that completed resolves the ring where it stands.
 *
 * On the canvas, `onScan` opens the scan overlay and the Send scene hands the
 * code back through `receive`. Rendered on its own, with no `onScan`, the
 * camera opens inside it instead. `onDone` takes a payment home once it has
 * been seen to complete, or to go out on chain, where the history follows
 * it (`confirming` in scenes/send/model), and `onDetail` opens the payment
 * a held request is waiting on.
 */
export function SendScreen({
  client,
  initialRequest = '',
  scanned = false,
  disabled = false,
  opening = false,
  primaryConnected = false,
  quoteRevision,
  onActivity,
  onRefresh,
  onBusy,
  initialScanning = false,
  balance,
  activity,
  onScan,
  onDetail,
  onDone,
  masked = false,
  unit = 'sats',
  symbol = false,
  test = false,
  leaving = false,
  ref,
  room,
}: {
  client: WalletAdapter;
  /**
   * Prefilled by a scanned code or a bitcoin:/lightning: link. Never sent
   * without a review, and only ever sent without a hold when the camera read
   * it (`scanned`) and Settings > Auto-pay allows it (`autoPays`).
   */
  initialRequest?: string;
  /** `initialRequest` was read by the camera, not brought by a link. */
  scanned?: boolean;
  /** Set when the wallet's balance is too old to spend against. */
  disabled?: boolean;
  /**
   * Set while the wallet is still opening on the figures it last saw. A
   * review asked for then waits, busy, for the wallet's first live read and
   * is prepared as it lands; nothing is paid before it.
   */
  opening?: boolean;
  /** A max is available only while the primary is connected. */
  primaryConnected?: boolean;
  /** A refreshed snapshot also refreshes the quote's fee and reserve figures. */
  quoteRevision?: number;
  onActivity: () => void;
  /** A fresh read of the wallet; one that returns a promise is waited on. */
  onRefresh: () => void | Promise<void>;
  onBusy: (busy: boolean) => void;
  /** Open straight onto the camera, when rendered without the overlay. */
  initialScanning?: boolean;
  /** What the amount is measured against. */
  balance?: WalletSnapshot['balance'];
  /** The history, which holds a request whose payment is still open. */
  activity?: Activity[];
  onScan?: (origin: Origin | null) => void;
  onDetail?: (item: Activity) => void;
  onDone?: () => void;
  /** Amounts are hidden, as the balance is. */
  masked?: boolean;
  /** The unit the balance is shown in. */
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). Entry stays in sats. */
  symbol?: boolean;
  /** A test network, where slate stands in for bloom throughout. */
  test?: boolean;
  /**
   * Send is no longer the stage's scene and only fades out where it was.
   * An answer arriving now is recorded, as for a Send that has gone, and
   * nothing is felt, flashed or said for it over the screen that came next.
   */
  leaving?: boolean;
  ref?: Ref<SendHandle>;
  /**
   * How tall the screen can be in its slot, in points. Compose fits it: what
   * is entered scrolls, and the way on stays pinned at the bottom, as
   * Receive's does and on the same pixels.
   */
  room?: number;
}) {
  const live = usePaneActive();
  const launchLanding = useLaunchLanding(room);
  const [request, setRequest] = useState(initialRequest);
  // A request that arrived whole shows as a chip; one being typed as text,
  // and one the parser refuses stays in the well with its cross, so it never
  // takes the accepted look first.
  const [collapsed, setCollapsed] = useState(
    () => initialRequest !== '' && !requestRefusal(initialRequest),
  );
  // Without the overlay, the camera is a view inside this screen, so a typed
  // request or amount survives a scan that is cancelled or replaces it.
  const [scanning, setScanning] = useState(initialScanning);
  const [amount, setAmount] = useState('');
  const [maximum, setMaximum] = useState<
    (MaxQuote & { request: string; client: WalletAdapter }) | null
  >(null);
  const currentMaximum =
    maximum?.request === request && maximum.client === client ? maximum : null;
  const [maxFor, setMaxFor] = useState<string | null>(null);
  const maxSelected = maxFor === request;
  const [review, setReview] = useState<SendReview | null>(null);
  const [reviewedAt, setReviewedAt] = useState(0);
  const [expired, setExpired] = useState(false);
  // The hold has committed on the review's quote, which is spent from then
  // on: nothing about it can expire, be refreshed or be reviewed again for
  // this payment, however long the payment takes.
  const [spent, setSpent] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [rail, setRail] = useState<GlyphName>('bolt');
  // What the history has since shown of a result broadcasting on chain.
  const [followed, setFollowed] = useState<Followed | null>(null);
  // When the result showing came, for how long it is followed.
  const shownAt = useRef(0);
  const [busy, setBusy] = useState(false);
  // A review asked for while the wallet was still opening, prepared as its
  // first live read lands (`opening`).
  const [queued, setQueued] = useState(false);
  // A replacement request can arrive in the same render as the live read.
  // Invalidate the queued review immediately, before its effect runs.
  const queuedFor = useRef<string | null>(null);
  const composeBusy = busy || queued;
  const [failure, setFailure] = useState<Failure | null>(() =>
    requestRefusal(initialRequest),
  );
  // Each refusal of the amount shakes it, the same one again included.
  const [amountShakes, setAmountShakes] = useState(0);
  // The rate the payer chose for a payment to a Bitcoin address, in whole
  // sats per virtual byte; null is the engine's own normal. Kept through an
  // edit of the same payment, and let go with the payment, so every new one
  // starts on the default.
  const [feeRate, setFeeRate] = useState<number | null>(null);
  // The rate under the slider's thumb, which the sum shows as a preview
  // until the engine has priced it or refused it.
  const [preview, setPreview] = useState<number | null>(null);
  // The slider's quotes to the engine, numbered, and the one still out, or
  // 0. A quote holds the hold, not the stage or the pencil: pricing a rate
  // pays nothing.
  const requotes = useRef(0);
  const quoting = useRef(0);
  // A slider quote that has outlasted a beat shows on the hold as its orbit.
  const [quoteSlow, setQuoteSlow] = useState(false);
  // Each rate the engine refused, for the thumb to spring back on.
  const [refusals, setRefusals] = useState(0);
  // A result that returns home (a completed payment, or one broadcast on
  // chain), or a held ring seen to resolve into one, goes home on its own
  // unless the screen is touched or focused, and never while a screen
  // reader is running: its user reaches the result a swipe at a time, and
  // no timer should take it away.
  const [stayed, setStayed] = useState(false);
  const reader = useScreenReader();
  // Settings > Auto-pay (REDESIGN.md rule 5): the request a camera scan
  // brought while it was on, which is reviewed on its own and pays as its
  // review lands, when the review is within the share of the balance it
  // allows (`autoPays`). It is used once, and anything that changes the
  // request, takes the step elsewhere or refuses it lets it go.
  const autoFor = useRef<string | null>(null);
  // Whether that review asked to be reviewed already.
  const autoAsked = useRef(false);
  // The payment going out was committed by Auto-pay, so the hold plays its
  // complete for the payer.
  const [autoPaid, setAutoPaid] = useState(false);
  // A request that names its amount sets it and locks it, so the amount
  // cannot be changed by accident. What was typed stays for a request that
  // names none.
  const fixedSats = useMemo(() => fixedAmount(request), [request]);
  // A request is checked once it is taken, as a chip, rather than letter by
  // letter as it is typed; prepare checks again, so one reviewed straight
  // from the well is held all the same. Read afresh on every render, and
  // drawn again whenever this app holds or lets go of a request, wherever
  // that happens: a payment an earlier Send left going out answers into the
  // same set.
  useSyncExternalStore(subscribeHeld, heldVersion);
  const known =
    review || result || !collapsed ? null : heldRequest(request, activity);
  // A payment seen to complete while its held ring was on screen, which the
  // ring resolves into in place, whichever Send sent it. The held set says
  // so of a request paid once; `completedHere` says it of one that may be
  // paid again, which the set lets go, for as long as its ring is still
  // what shows here and until the request is paid again.
  const [ringFor, setRingFor] = useState('');
  const paidHere =
    !review && !result && collapsed && ringFor === request.trim()
      ? completedHere(request)
      : null;
  const seen = paidHere
    ? {
        status: 'completed' as const,
        item: paymentOf(paidHere, activity) ?? undefined,
      }
    : null;
  const held = known?.status === 'completed' ? known : seen ?? known;
  const canQuoteMax =
    collapsed &&
    fixedSats === null &&
    !disabled &&
    primaryConnected &&
    !review &&
    !result &&
    !held &&
    !composeBusy &&
    live &&
    !leaving &&
    failure?.target !== 'request';
  useEffect(() => {
    // Keep the last usable amount visible while refreshing this same wallet
    // and request. Preparing a payment still obtains a fresh review.
    setMaximum(previous =>
      canQuoteMax && previous?.request === request && previous.client === client
        ? previous
        : null,
    );
    if (!canQuoteMax) return;
    let current = true;
    client
      .quoteMax({
        request: request.trim(),
        ...(feeRate === null ? {} : { feeRate }),
      })
      .then(quote => {
        if (!current) return;
        setMaximum(
          Number.isSafeInteger(quote.amountSats) && quote.amountSats > 0
            ? { ...quote, request, client }
            : null,
        );
      })
      .catch(() => {
        // A refused refresh invalidates the old amount. Late answers cannot
        // clear a newer request's quote.
        if (current) setMaximum(null);
      });
    return () => {
      current = false;
    };
  }, [
    client,
    request,
    canQuoteMax,
    feeRate,
    quoteRevision,
    balance?.availableSats,
    balance?.totalSats,
  ]);
  useEffect(() => {
    if (maxFor === request && currentMaximum)
      setAmount(String(currentMaximum.amountSats));
  }, [currentMaximum, maxFor, request]);
  // The request whose held ring is on screen, if one is, for a payment's
  // late answer to follow.
  const watching = useRef('');
  useLayoutEffect(() => {
    watching.current = held && !result ? request.trim() : '';
  });

  // Where a screen reader lands as a step settles: the review's amount, the
  // control in the ring, the amount in compose, and a result's mark.
  const { land, say } = useLanding();
  const summary = useRef<HostInstance>(null);
  const control = useRef<HostInstance>(null);
  const readout = useRef<HostInstance>(null);
  const mark = useRef<HostInstance>(null);

  // What a result's mark grows out of (REDESIGN.md 7, T7): the hold's
  // centre, read while the payment is out, and the comet's clock, which Send
  // keeps so the mark's comet carries on from where the hold's was. Under
  // Reduce Motion nothing travels, so no arrival is kept.
  const { reduced } = useMotionPrefs();
  const [arrival, setArrival] = useState<Arrival | null>(null);
  const comet = useLoop(durations.orbit, spent || arrival !== null);
  // Whether a mark takes the hold's place as it leaves, read by the hold's
  // exit in the frame it goes (`vanishIf`): set as a result or the overdue
  // ring is shown grown out of it, and clear while a payment is out, so the
  // hold of a payment the engine refuses leaves with its review.
  const taken = useSharedValue(false);
  const holdAt = useRef<Centre | null>(null);
  useLayoutEffect(() => {
    if (!spent) {
      holdAt.current = null;
      return;
    }
    return watchCentre(
      () => control.current,
      at => {
        holdAt.current = at;
      },
    );
  }, [spent]);
  /** What a result landing now grows out of, where the hold was measured. */
  const arrivalFrom = (warned: boolean): Arrival | null =>
    holdAt.current && !reduced
      ? { from: holdAt.current, clock: comet, warned }
      : null;
  const arrived = () => setArrival(null);
  // Whether the hold is up, for the balance's gate to read as it turns.
  const reviewing = useRef(false);
  useLayoutEffect(() => {
    reviewing.current = review !== null && !expired && !spent;
  });

  // A request brought by a scan or a link is taken as a pasted one is, and
  // refused as it arrives when it cannot be paid.
  const entered = useRef(accept);
  useLayoutEffect(() => {
    entered.current = accept;
  });
  useEffect(() => {
    if (initialRequest) entered.current(initialRequest, scanned);
  }, [initialRequest, scanned]);
  // The stage is told busy by the handlers that send, as a request goes out
  // (`goingOut` below), and let go as its answer comes back or its grace
  // runs out, whichever is first, and as Send goes, whatever is still in
  // flight.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A Send that has left the stage is gone to its answers, though it is
  // still drawn while it fades, and back for them if the stage returns to it.
  useLayoutEffect(() => {
    mounted.current = !leaving;
    if (leaving) queuedFor.current = null;
  }, [leaving]);
  useEffect(() => () => onBusy(false), [onBusy]);
  // Calls to the engine are numbered, so an answer only lets go of what its
  // own call took. `stageFor` is the call the stage is held busy for, never
  // longer than its grace; `waitingFor` is the call this screen waits on,
  // with its controls off, until it answers or, for a payment, until the
  // screen moves on to the held ring.
  const calls = useRef(0);
  const stageFor = useRef(0);
  const waitingFor = useRef(0);
  const graces = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = graces.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  // What is still to be said of a quote that ran out, taken back as a fresh
  // quote replaces it or Send goes (REDESIGN.md 9: a state that ends before
  // it is heard is not said).
  const expiredSaid = useRef<(() => void) | null>(null);
  const sayExpired = useRef(() => {
    expiredSaid.current?.();
    expiredSaid.current = quoteExpired();
  });
  useEffect(() => {
    if (expired) return;
    expiredSaid.current?.();
    expiredSaid.current = null;
  }, [expired]);
  useEffect(() => () => expiredSaid.current?.(), []);

  // A quote runs out on its own clock, and is said aloud once as it gets
  // close, until the hold commits on it.
  useEffect(() => {
    if (!review || expired || spent) return;
    const left = review.expiresAt - Date.now();
    const timers = [
      setTimeout(() => {
        setExpired(true);
        land(control);
        sayExpired.current();
      }, Math.max(0, left)),
    ];
    if (left > LATE_MS) {
      timers.push(
        setTimeout(
          () => say(copy.send.quoteExpires(LATE_MS / 1000)),
          left - LATE_MS,
        ),
      );
    }
    return () => timers.forEach(clearTimeout);
  }, [review, expired, spent, land, say]);

  // The stale gate closing on the payment is a safety state (REDESIGN.md
  // rule 4): felt and logged as it closes, and said once a screen reader
  // has landed, unless it opens again first. On a review it takes the hold's
  // place, and a screen reader lands on it; as it opens again, back on the
  // review's amount above the hold.
  const gateWas = useRef(disabled);
  useEffect(() => {
    const opened = gateWas.current && !disabled;
    gateWas.current = disabled;
    if (opened && reviewing.current) land(summary);
    if (!disabled) return;
    haptics.warning();
    if (reviewing.current) land(control);
    recordDiagnostic({ phase: 'ui', code: 'STALE', message: copy.send.stale });
    return announceSafety(copy.send.stale, 'stale');
  }, [disabled, land]);

  // The wallet has opened: a review asked for meanwhile is prepared now,
  // or, if the balance it opened on is still too old, a refresh is asked
  // for, as the gated control asks.
  useEffect(() => {
    if (!queued || opening) return;
    setQueued(false);
    if (queuedFor.current !== request) return;
    queuedFor.current = null;
    if (disabled) onRefresh();
    else prepare();
    // Runs as the wallet opens, with that render's prepare and gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, opening]);

  // Auto-pay (REDESIGN.md rule 5) reviews the scanned request on its own,
  // once, as soon as nothing else is under way. While the wallet is opening
  // the review queues for its first live read, as a tapped one does, and a
  // request held or paid lands on its ring or its mark. A balance too old to
  // spend against lets it go, so nothing pays itself later on figures that
  // were not shown when it was read.
  useEffect(() => {
    if (autoFor.current === null) return;
    if (autoFor.current !== request || disabled || leaving || held) {
      letAutoGo();
      return;
    }
    if (autoAsked.current || !collapsed || review || result) return;
    if (composeBusy || failure || waitingFor.current) return;
    autoAsked.current = true;
    prepare();
  });

  // The review Auto-pay asked for pays as it lands, before it is drawn
  // waiting for a hold, once Send is in front (the scan overlay gone), if it
  // is within the share of what can be sent (`autoPays`). Otherwise it waits
  // for the hold, as every other review does. `pay` keeps every guard it
  // has: the quote's clock, the stale gate and the held set.
  const payNow = useRef(pay);
  useLayoutEffect(() => {
    payNow.current = pay;
  });
  const availableSats = balance?.availableSats ?? 0;
  useLayoutEffect(() => {
    const armed = autoFor.current;
    if (armed === null || !review || spent) return;
    if (armed !== request || expired || disabled || opening || leaving) {
      letAutoGo();
      return;
    }
    if (!live || waitingFor.current || preview !== null || quoting.current) {
      return;
    }
    letAutoGo();
    const { on, share } = autoPayNow();
    if (!on || !autoPays({ review, request, availableSats, share })) {
      return;
    }
    setAutoPaid(true);
    say(copy.send.autoPaying(review.amountSats));
    payNow.current();
  }, [
    review,
    request,
    spent,
    expired,
    disabled,
    opening,
    leaving,
    live,
    preview,
    availableSats,
    say,
  ]);
  useEffect(() => {
    if (!spent) setAutoPaid(false);
  }, [spent]);

  // Landing on the held ring is felt, said and logged, once for each time.
  // It is said once a screen reader has landed on the ring's mark and
  // settled there (REDESIGN.md 9), unless the ring or Send goes first.
  const heldFor = held && held.status !== 'completed' ? request.trim() : '';
  // The request whose held ring this screen has shown, for as long as it
  // shows it or the paid mark it turns into. A payment that completes while
  // its ring is on screen is one seen to go, whether this screen sent it or
  // came back to it: the ring resolves into the paid mark in place, worded
  // as sent, rather than cutting to the mark a request paid before rests on
  // (P12, 06k) or to a result laid out afresh, with two amounts drawn at
  // once (P14, 05h). A touch on a result before the ring came keeps
  // nothing here from going home.
  const shownFor = heldFor || (held ? ringFor : '');
  if (shownFor !== ringFor) {
    setRingFor(shownFor);
    if (shownFor) setStayed(false);
  }
  const resolved =
    held?.status === 'completed' && !!ringFor && ringFor === request.trim();
  useEffect(() => {
    if (!heldFor) return;
    haptics.held();
    land(mark);
    recordDiagnostic({ phase: 'ui', code: 'HELD', message: copy.send.held });
    return announceSafety(copy.send.heldAnnouncement, 'held');
  }, [heldFor, land]);

  // A request paid before lands on its paid mark at rest: nothing is played
  // or felt for a payment that was seen before, and a screen reader lands on
  // the mark and hears it. One seen to complete here is the news its held
  // ring was waiting for: felt once, as a success, heard as sent, and home
  // on its own a moment later, as a completed result goes.
  const paidFor = held?.status === 'completed' ? request.trim() : '';
  useEffect(() => {
    if (!paidFor) return;
    land(mark);
    if (resolved) haptics.resolved();
    say(resolved ? copy.send.sent : copy.send.paidAlready);
  }, [paidFor, resolved, land, say]);

  // How the result looks. A pending payment over a Bitcoin rail, the rail
  // the review settled on, follows its stage (`chainStage`): broadcast, it
  // rests on the done disc rather than the orbit, since nothing more happens
  // here before it confirms; broadcasting, its orbit runs round the rail's
  // glyph until the history names its transaction, and the orbit resolves
  // into the disc where it stands. The history may instead show it failed or
  // unknown first, and the result is then that.
  const item = result ? paymentOf(result, activity) : null;
  const answered = result ? chainStage(result, rail) : null;
  useEffect(() => {
    if (answered !== 'broadcasting' || followed || !item) return;
    if (item.txid || item.status === 'completed') {
      setFollowed({ broadcast: true, txid: item.txid });
    } else if (item.status === 'failed' || item.status === 'uncertain') {
      setFollowed({ status: item.status });
    }
  }, [answered, followed, item]);
  const stage =
    answered === 'broadcasting' && followed?.broadcast ? 'broadcast' : answered;
  const status = result
    ? (!followed?.broadcast && followed?.status) || result.status
    : null;
  const visual =
    result && status
      ? {
          ...resultVisual(status, stage, rail),
          // Seen broadcasting here, it grows out of its orbit.
          ...(followed?.broadcast ? { resolves: true } : {}),
        }
      : null;
  const broadcasting = stage === 'broadcasting' && !followed;

  // The ground behind the canvas holds honey while an outcome is unknown,
  // here before the wallet's own read of it says so, and flashes radish as a
  // payment fails (REDESIGN.md 3.2, G3).
  useHoldTint(
    status === 'uncertain' || (held && held.status !== 'completed')
      ? 'honey'
      : null,
  );
  const flash = useFlashTint();

  // A result is felt as it lands, and said once its mark has taken a screen
  // reader's focus, so the move never cuts an assertive message short. An
  // unknown one is a safety state, said through `announceSafety` once the
  // landing has settled, unless the result or Send goes first.
  useEffect(() => {
    if (!result) return;
    land(mark);
    let withdraw: (() => void) | undefined;
    switch (result.status) {
      case 'completed':
        haptics.success();
        say(copy.send.sent);
        break;
      case 'pending':
        // Soft whether in flight, broadcasting or broadcast: none has
        // landed, so none is felt as a success as it comes.
        haptics.soft();
        say(resultVisual('pending', answered, rail).title);
        break;
      case 'uncertain':
        haptics.held();
        withdraw = announceSafety(copy.send.heldAnnouncement, 'held');
        break;
      case 'failed':
        haptics.error();
        flash('radish');
        say(`${copy.send.failed} ${result.message}`, true);
        break;
    }
    return withdraw;
  }, [result, answered, rail, flash, land, say]);

  // The history moving a broadcasting payment on, once for each answer, with
  // the mark where it was, so a screen reader is not moved: broadcast, the
  // news its orbit waited for, felt as a held ring's resolve is and heard as
  // confirming; or failed or unknown first, felt and heard as that outcome
  // is when the engine answers it. Nothing is felt or said for it over a
  // screen that came after Send.
  useEffect(() => {
    if (!followed || !mounted.current) return;
    if (followed.broadcast) {
      haptics.resolved();
      say(copy.send.confirming);
      return;
    }
    recordDiagnostic({
      phase: 'ui',
      code: followed.status.toUpperCase(),
      message:
        followed.status === 'failed' ? copy.send.notSent : copy.send.unknown,
    });
    if (followed.status === 'uncertain') {
      haptics.held();
      return announceSafety(copy.send.heldAnnouncement, 'held');
    }
    haptics.error();
    flash('radish');
    say(`${copy.send.failed} ${copy.send.notSent}`, true);
  }, [followed, flash, say]);

  // While a payment is broadcasting, the wallet is read again a moment after
  // each read settles, so the transaction shows here as the chain has it
  // rather than at the wallet's next poll: while this screen is in front and
  // the app is active, and for BROADCAST_WATCH_MS after the answer at most.
  // The wallet's own poll carries it after that.
  const refreshNow = useRef(onRefresh);
  useLayoutEffect(() => {
    refreshNow.current = onRefresh;
  });
  useEffect(() => {
    if (!broadcasting || !live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = () => {
      timer = setTimeout(async () => {
        if (stopped || Date.now() - shownAt.current >= BROADCAST_WATCH_MS)
          return;
        if (AppState.currentState === 'active') {
          try {
            await refreshNow.current();
          } catch {
            // The wallet's own poll says when reads fail.
          }
        }
        if (!stopped) next();
      }, BROADCAST_POLL_MS);
    };
    next();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [broadcasting, live]);

  const done = visual?.returnsHome || resolved;
  useEffect(() => {
    if (!done || !onDone || stayed || reader) return;
    const timer = setTimeout(onDone, HOME_AFTER_MS);
    return () => clearTimeout(timer);
  }, [done, onDone, stayed, reader]);

  const stay = () => setStayed(true);
  // Only a result that returns home is kept by a touch: one touched while
  // its orbit still ran, before it could, goes home all the same once it is
  // broadcast, as a held ring touched before it resolves does.
  const touched = () => {
    if (done) stay();
  };

  /**
   * Marks a request to the engine as going out, and returns its number. The
   * stage hears it now, in the handler that sends it, rather than from an
   * effect a render later: until then a close or a back could still take
   * Send away under a payment in flight, and its result would never be
   * shown.
   */
  function goingOut(): number {
    calls.current += 1;
    const call = calls.current;
    stageFor.current = call;
    waitingFor.current = call;
    onBusy(true);
    setBusy(true);
    return call;
  }

  /**
   * Lets the stage go, if `call` still holds it. A Send that has already
   * gone leaves the stage alone, which it released as it went and may since
   * be holding for another.
   */
  function letStageGo(call: number) {
    if (stageFor.current !== call) return;
    stageFor.current = 0;
    if (mounted.current) onBusy(false);
  }

  /** The answer to `call` is back. */
  function cameBack(call: number) {
    letStageGo(call);
    if (waitingFor.current !== call) return;
    waitingFor.current = 0;
    if (mounted.current) setBusy(false);
  }

  /**
   * The stage waits SEND_GRACE_MS for `call` at most, then is let go, and
   * `then` runs. Returns the cancel, for an answer that comes first.
   */
  function grace(call: number, then?: () => void): () => void {
    const timer = setTimeout(() => {
      graces.current.delete(timer);
      letStageGo(call);
      then?.();
    }, SEND_GRACE_MS);
    graces.current.add(timer);
    return () => {
      clearTimeout(timer);
      graces.current.delete(timer);
    };
  }

  /**
   * Takes a request as it is entered, pasted, scanned or brought by a link,
   * as a chip. One the parser refuses is refused here, before an amount is
   * keyed for it: it stays in the well with a cross (REDESIGN.md 6, Engine
   * errors). Returns whether it was taken.
   */
  function accept(code: string, byCamera = false): boolean {
    queuedFor.current = null;
    setQueued(false);
    // Only a Lightning code the camera read, naming its amount, is reviewed
    // on its own; a paste, a link or typing never is.
    letAutoGo();
    if (byCamera && autoPayNow().on && autoPayCandidate(code)) {
      autoFor.current = code;
    }
    if (code !== request) {
      setMaxFor(null);
      setFeeRate(null);
    }
    dropQuote();
    setRequest(code);
    setScanning(false);
    const refused = requestRefusal(code);
    if (refused) {
      refuse(refused);
      return false;
    }
    setCollapsed(true);
    setFailure(null);
    return true;
  }

  /** Auto-pay lets go of the request it was armed for, if it was. */
  function letAutoGo() {
    autoFor.current = null;
    autoAsked.current = false;
  }

  /** Typing is done: a request is taken as a chip, or refused in the well. */
  function collapse() {
    if (!request.trim()) {
      setCollapsed(false);
      return;
    }
    if (failure?.target === 'request') return;
    const refused = requestRefusal(request);
    if (refused) refuse(refused);
    else setCollapsed(true);
  }

  /**
   * A refusal: felt and logged as it comes, and said once a screen reader has
   * landed where `landing` says, when the refusal moves it on.
   */
  function refuse(
    next: Failure,
    landing?: (next: Failure) => Landing | null,
  ): Failure {
    letAutoGo();
    haptics[next.haptic]();
    const target = landing?.(next);
    if (target) land(target);
    say(next.message, true);
    recordDiagnostic({
      phase: 'ui',
      code: next.code || undefined,
      message: next.message,
    });
    if (next.target === 'request') setCollapsed(false);
    if (next.target === 'amount' && next.shake) setAmountShakes(n => n + 1);
    setFailure(next);
    return next;
  }

  /** An engine refusal, drawn where its code says. */
  function fail(
    error: unknown,
    landing?: (next: Failure) => Landing | null,
  ): Failure {
    return refuse(
      sendFailure(error, {
        message: errorMessage(error),
        amountSats: fixedSats ?? (amount ? Number(amount) : null),
        balance,
      }),
      landing,
    );
  }

  /**
   * Where a screen reader lands as a refusal takes a review back to compose:
   * the amount, unless the request was refused, whose well takes focus as it
   * opens.
   */
  const backToCompose = (next: Failure) =>
    next.target === 'request' ? null : readout;

  /**
   * Lands a held request on its ring, or a paid one on its mark, whatever
   * step it was on.
   */
  function toHeld() {
    letAutoGo();
    dropQuote();
    setFeeRate(null);
    setReview(null);
    setExpired(false);
    setSpent(false);
    setFailure(null);
    setCollapsed(true);
  }

  /** Shows how a payment came out, grown out of the hold that sent it. */
  function show(outcome: SendResult) {
    letAutoGo();
    const from = arrivalFrom((review?.warnings.length ?? 0) > 0);
    taken.set(from !== null);
    setArrival(from);
    setResult(outcome);
    setFollowed(null);
    shownAt.current = Date.now();
    setStayed(false);
    dropQuote();
    setFeeRate(null);
    setReview(null);
    setExpired(false);
    setSpent(false);
  }

  /**
   * A payment still out once its grace has run: the stage has let go, so
   * Close works, and the screen moves to the held ring for `paying`, which is
   * felt, said and logged as any held request's is. The call goes on.
   */
  function overdue(call: number, paying: string) {
    if (!mounted.current || waitingFor.current !== call) return;
    waitingFor.current = 0;
    watching.current = paying.trim();
    // The ring is this screen's from now, not from the render that draws
    // it: an answer landing in between resolves it all the same, rather
    // than finding no ring and dropping back to compose with the payment
    // gone out.
    setRingFor(paying.trim());
    setStayed(false);
    setBusy(false);
    const from = arrivalFrom((review?.warnings.length ?? 0) > 0);
    taken.set(from !== null);
    setArrival(from);
    toHeld();
  }

  /**
   * What the engine is asked to price: the request, an amount or max, and
   * the rate chosen for it, if one is. Left out when none is, the engine
   * prices at its own normal.
   */
  function sendInput(rate: number | null = feeRate): SendInput {
    return {
      request: request.trim(),
      ...(maxSelected
        ? { max: true }
        : {
            amountSats:
              fixedSats === null && amount.trim()
                ? parseSats(amount)
                : undefined,
          }),
      ...(rate === null ? {} : { feeRate: rate }),
    };
  }

  /**
   * A fresh review takes the step: its clock starts now, and a screen reader
   * lands on its amount, or on the control when the quote has already run
   * out. A review the slider asked for (`quiet`) moves a screen reader
   * nowhere: it is on the slider, stepping.
   */
  function adopt(next: SendReview, quiet = false) {
    setReview(next);
    setReviewedAt(Date.now());
    setCollapsed(true);
    const late = next.expiresAt <= Date.now();
    setExpired(late);
    if (late) {
      land(control);
      sayExpired.current();
    } else if (!quiet) {
      land(summary);
    }
  }

  /**
   * Forgets a slider quote still out: its answer is dropped as it comes,
   * and the sum shows the review that stands.
   */
  function dropQuote() {
    requotes.current += 1;
    quoting.current = 0;
    setQuoteSlow(false);
    setPreview(null);
  }

  /** The thumb moved: the sum previews the rate under it. */
  function previewRate(rate: number) {
    setPreview(rate);
    setFailure(null);
  }

  /**
   * The thumb was let go at `rate`: the engine prices the payment at it, and
   * its review takes the step, with a fresh quote and clock, once it lands.
   * The hold waits for it (`pay`), busy once it has outlasted a beat. A
   * rate the engine refuses leaves the review that stood, and the slider
   * springs back to it; the refusal is felt, said, logged and drawn beside
   * the hold as any engine refusal is.
   */
  async function requote(rate: number) {
    if (!review || spent || !isRatedReview(review)) {
      dropQuote();
      return;
    }
    if (rate === review.feeRate || waitingFor.current || opening) {
      // Back where it was, or a call already out: nothing to price.
      dropQuote();
      return;
    }
    if (heldRequest(request, activity)) {
      toHeld();
      return;
    }
    const asking = request;
    const call = (requotes.current += 1);
    quoting.current = call;
    setPreview(rate);
    setFailure(null);
    const beat = setTimeout(() => {
      if (quoting.current === call && mounted.current) setQuoteSlow(true);
    }, REQUOTE_BEAT_MS);
    try {
      const next = await client.prepareSend(sendInput(rate));
      // Gone, or a later rate was chosen since.
      if (!mounted.current || quoting.current !== call) return;
      setFeeRate(rate);
      adopt(next, true);
      if (isRatedReview(next)) say(copy.send.feeRateAt(next.feeRate, next.feeSats));
    } catch (e) {
      if (!mounted.current || quoting.current !== call) return;
      if (alreadySubmitted(e)) {
        holdRequest(asking, { status: 'uncertain' });
        recordDiagnostic({
          phase: 'ui',
          code: errorCode(e),
          message: errorMessage(e),
        });
        toHeld();
        return;
      }
      setRefusals(n => n + 1);
      refuse(
        rateRefusal(
          sendFailure(e, {
            message: errorMessage(e),
            amountSats: fixedSats ?? (amount ? Number(amount) : null),
            balance,
          }),
        ),
      );
    } finally {
      clearTimeout(beat);
      if (quoting.current === call) {
        quoting.current = 0;
        if (mounted.current) {
          setQuoteSlow(false);
          setPreview(null);
        }
      }
    }
  }

  async function prepare() {
    if (waitingFor.current) return;
    if (opening) {
      queuedFor.current = request;
      setQueued(true);
      return;
    }
    // Rule 6 holds however the request came, typed, pasted or refreshed, and
    // for a request that is paid as well as one that may still be.
    if (heldRequest(request, activity)) {
      toHeld();
      return;
    }
    // A review asked for outranks a slider quote still out.
    dropQuote();
    // A refresh is asked for from a review whose quote ran out.
    const fromReview = review !== null;
    const asking = request;
    const call = goingOut();
    // Preparing pays nothing, so a Send left while it waits loses nothing.
    const cancelGrace = grace(call);
    setFailure(null);
    try {
      const next = await client.prepareSend(sendInput());
      if (!mounted.current) return;
      adopt(next);
    } catch (e) {
      if (alreadySubmitted(e)) {
        // The engine has a payment for this request out already.
        holdRequest(asking, { status: 'uncertain' });
        if (!mounted.current) return;
        recordDiagnostic({
          phase: 'ui',
          code: errorCode(e),
          message: errorMessage(e),
        });
        toHeld();
      } else if (!mounted.current) {
        return;
      } else if (
        // A refresh refused beside its control keeps the spent quote on
        // screen, to try again; anything else is fixed back in compose.
        fail(e, next =>
          fromReview && next.target !== 'control' ? backToCompose(next) : null,
        ).target !== 'control'
      ) {
        setReview(null);
        setExpired(false);
      }
    } finally {
      cancelGrace();
      cameBack(call);
    }
  }

  async function pay() {
    if (!review || waitingFor.current || expired || disabled || opening) return;
    // What the sum shows is not yet what the engine priced: the hold waits
    // for the slider's quote, busy, and is held again once the figures are
    // the engine's own.
    if (preview !== null || quoting.current) {
      setQuoteSlow(true);
      say(copy.send.preparing);
      return;
    }
    // The quote's own clock has the last word, not the render the hold began
    // in, and a request held or paid since the review never pays twice.
    if (review.expiresAt <= Date.now()) {
      setExpired(true);
      land(control);
      sayExpired.current();
      return;
    }
    if (heldRequest(request, activity)) {
      toHeld();
      return;
    }
    const paying = request;
    const quote = review;
    // The request is held before the payment goes out, and nothing the
    // history shows lets it go until this call answers, so however Send is
    // left from here, and however the request comes back, it is never paid
    // twice (REDESIGN.md rule 6).
    holdRequest(paying, { status: 'pending', calling: true, id: quote.id });
    const call = goingOut();
    taken.set(false);
    setSpent(true);
    setFailure(null);
    setRail(reviewRail(quote).glyph);
    let late = false;
    const cancelGrace = grace(call, () => {
      late = waitingFor.current === call;
      overdue(call, paying);
    });
    let outcome: SendResult | null = null;
    let code = '';
    let refusal: unknown = null;
    try {
      outcome = await client.send(quote);
    } catch (e) {
      code = errorCode(e);
      if (isUncertain(e)) {
        // The payment may have gone out. It is never an error to retry.
        outcome = {
          id: quote.id,
          status: 'uncertain',
          amountSats: quote.amountSats,
          feeSats: quote.feeSats,
          feeEstimated: true,
          message: errorMessage(e),
        };
      } else {
        refusal = e;
      }
    } finally {
      cancelGrace();
    }
    // Recorded whether or not anyone still watches: the held set is what
    // keeps the request from being paid twice. A refusal moved no money, so
    // it lets the request go.
    holdRequest(paying, outcome ?? { status: 'failed' });
    if (outcome) onRefresh();
    const unseen = !mounted.current || late;
    if (outcome?.status === 'uncertain' || outcome?.status === 'failed') {
      recordDiagnostic({
        phase: 'ui',
        code: code || outcome.status.toUpperCase(),
        message: outcome.message,
      });
    } else if (refusal && unseen) {
      recordDiagnostic({
        phase: 'ui',
        code: code || 'FAILED',
        message: errorMessage(refusal),
      });
    }
    cameBack(call);
    if (!mounted.current) return;
    if (late) {
      // Past its grace the screen moved on to the held ring, and follows the
      // payment only while that is still what it shows. Completed, the ring
      // resolves into the done disc where it stands, as it does for a Send
      // that came back to it. A refusal this late is shown as the payment
      // failing, since the review it came from has gone, and an unknown
      // outcome as its own result.
      if (watching.current !== paying.trim()) return;
      // The held set has it now, and the ring reads it from there.
      if (outcome?.status === 'completed') return;
      show(
        outcome ?? {
          id: quote.id,
          status: 'failed',
          amountSats: quote.amountSats,
          feeSats: 0,
          message: errorMessage(refusal),
        },
      );
    } else if (outcome) {
      show(outcome);
    } else if (code === 'QUOTE_EXPIRED') {
      // The engine refused the quote, so nothing went out on it.
      setSpent(false);
      setExpired(true);
      fail(refusal, () => control);
    } else {
      setSpent(false);
      setReview(null);
      fail(refusal, backToCompose);
    }
  }

  /**
   * Back to compose from the review, keeping the request, the amount and
   * the rate chosen, so the payment reviewed again is priced as it was.
   */
  function edit() {
    letAutoGo();
    dropQuote();
    setReview(null);
    setExpired(false);
    setFailure(null);
    land(readout);
  }

  /** A new quote for the same payment, which takes the spent one's place. */
  function refreshQuote() {
    setFailure(null);
    prepare();
  }

  /** A failed payment tapped: back to compose with the request kept. */
  function retry() {
    letAutoGo();
    setArrival(null);
    setResult(null);
    setFollowed(null);
    setFailure(null);
    land(readout);
  }

  async function paste(): Promise<boolean> {
    try {
      // Reading the clipboard can raise the system's paste prompt, which
      // makes the app inactive: marked as a prompt the app asked for, Send
      // stays in view behind it rather than the privacy cover. What the
      // paste brings lands once the app is in front again, so a refusal's
      // cross draws, and its haptic plays, where they are seen and felt.
      const text = await duringSystemPrompt(() => Clipboard.getString());
      await untilInFront();
      if (!mounted.current) return false;
      const pasted = text?.trim();
      if (!pasted) {
        haptics.error();
        say(copy.send.clipboardEmpty);
        return false;
      }
      // A refused paste is said with its refusal instead.
      if (accept(pasted)) say(copy.send.pasted);
      return true;
    } catch (e) {
      await untilInFront();
      if (!mounted.current) return false;
      fail(e);
      return false;
    }
  }

  function scan(origin: Origin | null) {
    if (onScan) onScan(origin);
    else setScanning(true);
  }

  useImperativeHandle(ref, () => ({
    back: () => {
      // Sent but not yet rendered as busy counts too: the stage refuses it.
      if (busy || waitingFor.current) return false;
      if (review) {
        edit();
        return true;
      }
      if (status === 'failed') {
        retry();
        return true;
      }
      return false;
    },
    receive: (code: string, byCamera?: boolean) => {
      accept(code, byCamera);
    },
  }));

  if (scanning) {
    return (
      <Scanner
        onDetected={(code, source) => accept(code, source === 'camera')}
        onCancel={() => setScanning(false)}
        test={test}
      />
    );
  }

  function typed(text: string) {
    letAutoGo();
    queuedFor.current = null;
    setQueued(false);
    setMaxFor(null);
    setFeeRate(null);
    dropQuote();
    setRequest(text);
    setCollapsed(false);
    setFailure(null);
  }

  const step = result
    ? 'result'
    : held
    ? 'held'
    : review
    ? 'review'
    : 'compose';
  let content: ReactNode;
  // What sits under a mark growing out of the hold rises in once the mark
  // has landed, a sibling's stagger apart; otherwise the step moves it.
  const landing = (index: number) =>
    arrival
      ? riseIn(
          overlap.rise,
          ARRIVE_MS + overlap.enterDelay + index * overlap.staggerMax,
        )
      : undefined;

  if (result && visual && status) {
    const reference =
      result.txid ||
      (followed?.broadcast ? followed.txid : undefined) ||
      result.paymentHash;
    const failed = status === 'failed';
    const uncertain = status === 'uncertain';
    // The engine's answer said a payment the history then showed failed or
    // unknown was submitted, which it no longer speaks for.
    const message =
      followed && !followed.broadcast
        ? failed
          ? copy.send.notSent
          : null
        : result.message;
    content = (
      <>
        <View style={styles.body}>
          <ResultMark
            ref={mark}
            visual={visual}
            accessibilityLabel={visual.title}
            accessibilityValue={statusLabel(status)}
            accessibilityHint={[
              message,
              uncertain ? copy.send.checkActivity : null,
              failed ? copy.send.retry : null,
              uncertain && item && onDetail ? copy.send.showPayment : null,
            ]
              .filter(Boolean)
              .join(' ')}
            onPress={
              !live
                ? undefined
                : failed
                ? retry
                : uncertain && item && onDetail
                ? () => onDetail(item)
                : undefined
            }
            arrival={arrival}
            onArrived={arrived}
          />
          <Reanimated.View entering={landing(0)}>
            <Amount
              sats={result.amountSats}
              unit={unit}
              symbol={symbol}
              masked={masked}
              color={uncertain ? palette.honey : palette.cream}
            />
          </Reanimated.View>
          <Reanimated.View
            entering={landing(1)}
            accessible
            accessibilityLabel={
              result.feeEstimated ? copy.send.reviewedFee : copy.send.feePaid
            }
            accessibilityValue={{
              text:
                result.feeKnown === false
                  ? copy.send.feeUnavailable
                  : copy.amount.spoken(result.feeSats),
            }}
            style={styles.fee}
          >
            <Glyph name={rail} size={16} color={palette.steam} />
            <Text style={styles.feeText} maxFontSizeMultiplier={LINE_SCALE}>
              {result.feeEstimated ? '+ ≈' : '+'}
            </Text>
            {result.feeKnown === false ? (
              <Glyph name="question" size={16} color={palette.steam} />
            ) : (
              <Text style={styles.feeText} maxFontSizeMultiplier={LINE_SCALE}>
                {masked
                  ? MASK
                  : inlineAmount(
                      result.feeSats,
                      unit,
                      symbol,
                      typography.line.fontSize,
                    )}
              </Text>
            )}
          </Reanimated.View>
          {reference ? (
            <Reanimated.View
              key="reference"
              // Named by the history after the mark has landed, it fades
              // into the place kept for it.
              entering={
                landing(2) ?? (followed?.broadcast ? fadeIn() : undefined)
              }
            >
              <CopyChip label={copy.send.reference} value={reference} />
            </Reanimated.View>
          ) : broadcasting ? (
            // The transaction's place, kept while it is broadcast so nothing
            // under the mark moves as the history names it.
            <View
              key="reference-to-come"
              style={styles.unseen}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <CopyChip label={copy.send.reference} value={NOTHING_YET} />
            </View>
          ) : null}
        </View>
        <View style={[styles.controls, styles.centred]}>
          <Reanimated.View entering={landing(3)}>
            <GlyphButton
              glyph={ACTIVITY_GLYPH}
              accessibilityLabel={copy.send.viewActivity}
              onPress={live ? onActivity : undefined}
            />
          </Reanimated.View>
        </View>
      </>
    );
  } else if (held) {
    const heldItem = held.item;
    // A payment this screen sent shows what it sent, amount typed or not.
    const shown = heldItem?.amountSats ?? fixedSats ?? (Number(amount) || null);
    const ring = heldVisual(held.status, resolved);
    const paid = held.status === 'completed';
    // Paid for good, or seen to complete here for a request that may be
    // paid again, which is not said to be held for good.
    const once = held === known;
    // Once the history shows the payment, the way to it is the payment
    // itself; until then, the history it will show in.
    const openItem =
      live && heldItem && onDetail ? () => onDetail(heldItem) : undefined;
    content = (
      <>
        <View style={styles.body}>
          <ResultMark
            ref={mark}
            visual={ring}
            accessibilityLabel={ring.title}
            accessibilityValue={statusLabel(held.status)}
            accessibilityHint={[
              !paid ? copy.send.held : once ? copy.send.paid : null,
              openItem ? copy.send.showPayment : null,
            ]
              .filter(Boolean)
              .join(' ')}
            onPress={openItem}
            arrival={arrival}
            onArrived={arrived}
          />
          {shown ? (
            <Reanimated.View entering={landing(0)}>
              <Amount
                sats={shown}
                unit={unit}
                symbol={symbol}
                masked={masked}
                color={paid ? palette.cream : palette.honey}
              />
            </Reanimated.View>
          ) : null}
        </View>
        <View style={[styles.controls, styles.centred]}>
          <Reanimated.View entering={landing(1)}>
            <GlyphButton
              glyph={ACTIVITY_GLYPH}
              accessibilityLabel={copy.send.viewActivity}
              accessibilityHint={openItem ? copy.send.showPayment : undefined}
              onPress={live ? openItem ?? onActivity : undefined}
            />
          </Reanimated.View>
        </View>
      </>
    );
  } else if (review) {
    // A Bitcoin review carries its fee rate slider, and while the thumb
    // moves the sum shows the review as it would read at the rate under it.
    const rated = isRatedReview(review) ? review : null;
    const shown =
      rated && preview !== null ? previewReview(rated, preview) : review;
    const still = spent || expired || busy || disabled;
    content = (
      <>
        <View style={styles.body}>
          <Whisper
            label={copy.send.maxKept(review.keptSats ?? 0)}
            enabled={review.max === true}
          >
            <Amount
              ref={summary}
              sats={
                isPayAllReview(shown)
                  ? shown.minRecipientSats
                  : shown.amountSats
              }
              minimum={isPayAllReview(shown)}
              hint={
                review.max ? copy.send.maxKept(review.keptSats ?? 0) : undefined
              }
              unit={unit}
              symbol={symbol}
            />
          </Whisper>
          {review.description ? (
            <Text
              style={styles.note}
              numberOfLines={2}
              maxFontSizeMultiplier={LINE_SCALE}
            >
              {review.description}
            </Text>
          ) : null}
          <ReviewLines
            review={shown}
            unit={unit}
            symbol={symbol}
            spent={spent}
            quick={preview !== null}
          >
            {rated ? (
              <FeeSlider
                rate={preview ?? rated.feeRate}
                rates={rated.feeRates}
                {...feeRange(rated.feeRates, preview ?? rated.feeRate)}
                feeSats={shown.feeSats}
                disabled={still}
                hint={
                  expired
                    ? copy.send.quoteExpired
                    : disabled
                    ? copy.send.stale
                    : undefined
                }
                refused={refusals}
                onPreview={previewRate}
                onChoose={requote}
              />
            ) : null}
          </ReviewLines>
        </View>
        <View style={styles.controls}>
          <View style={[styles.side, styles.start]}>
            <GlyphButton
              glyph="pencil"
              accessibilityLabel={copy.send.edit}
              onPress={live && !busy ? edit : undefined}
              disabled={busy}
            />
          </View>
          {/* A hold that has sent is taken over by the result's mark in the
              same frame, which grows out of it (REDESIGN.md 7, T7): drawn
              whole in that frame, under the mark, and gone from the next.
              Refused, with no mark to take it over, it leaves with the
              review. */}
          <Reanimated.View exiting={spent ? vanishIf(taken) : undefined}>
            <Commit
              ref={control}
              accessibilityLabel={
                shown.max
                  ? copy.send.sendMax
                  : copy.send.sendSats(shown.amountSats)
              }
              summary={reviewWords(shown)}
              expiresAt={review.expiresAt}
              createdAt={reviewedAt}
              warning={review.warnings.length > 0}
              expired={expired}
              stale={disabled}
              busy={busy || quoteSlow}
              spent={spent}
              auto={autoPaid}
              comet={comet}
              onCommit={pay}
              onRefreshQuote={live && !busy ? refreshQuote : undefined}
              onRefresh={live ? onRefresh : undefined}
            />
          </Reanimated.View>
          <View style={[styles.side, styles.end]}>
            {failure ? <FailureMark failure={failure} /> : null}
          </View>
        </View>
      </>
    );
  } else {
    const amountFailure = failure?.target === 'amount' ? failure : null;
    const shownAmount =
      fixedSats !== null
        ? String(fixedSats)
        : maxSelected && currentMaximum
        ? String(currentMaximum.amountSats)
        : amount;
    const tone: AmountTone = maxSelected
      ? 'plain'
      : amountFailure
      ? amountFailure.tone === 'honey'
        ? 'over-spendable'
        : 'over-total'
      : amountTone(Number(shownAmount) || 0, balance);
    // What the review waits for, if anything: a request, one that can be
    // paid, and an amount. Until then it is drawn and told as disabled.
    const waiting = reviewWaiting(
      request,
      failure?.target === 'request',
      Number(shownAmount) || 0,
    );
    const hint = [
      fixedSats === null ? null : copy.amount.fixed,
      amountWords(tone, Number(shownAmount) || 0, balance),
      amountFailure?.message,
    ]
      .filter(Boolean)
      .join(' ');
    content = (
      <>
        <ScrollView
          testID="send-entry"
          style={styles.entry}
          contentContainerStyle={styles.entryContent}
          alwaysBounceVertical={false}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
        <AmountReadout
          ref={readout}
          accessibilityLabel={copy.amount.field}
          value={grouped(shownAmount)}
          onChangeText={
            live
              ? text => {
                  setAmount(digitsOnly(text));
                  setMaxFor(null);
                  if (amountFailure) setFailure(null);
                }
              : undefined
          }
          hint={hint || undefined}
          editable={fixedSats === null}
          busy={composeBusy}
          tone={tone}
          shake={amountShakes}
          symbol={symbol}
        >
          {canQuoteMax && currentMaximum ? (
            <Reanimated.View entering={riseIn()} style={styles.maximum}>
              <Chip
                label={copy.amount.spoken(currentMaximum.amountSats)}
                selected={maxSelected}
                disabled={composeBusy}
                maxFontSizeMultiplier={LINE_SCALE}
                onPress={
                  live && !composeBusy
                    ? () => {
                        setAmount(String(currentMaximum.amountSats));
                        setMaxFor(request);
                        setFailure(null);
                      }
                    : undefined
                }
              />
            </Reanimated.View>
          ) : null}
        </AmountReadout>
        </ScrollView>
        <View style={styles.controls} onLayout={launchLanding.onLayout}>
          <View style={styles.side} />
          {/* Home's Send circle lands exactly on it (REDESIGN.md 7, T1),
              and it is unseen until the circle hands over, so the two are
              never drawn apart. */}
          <View
            ref={launchLanding.ref}
            onLayout={launchLanding.onLayout}
            collapsable={false}
          >
            <Reanimated.View style={launchLanding.style}>
              <CircleControl
                accessibilityLabel={copy.send.review}
                accessibilityHint={
                  disabled
                    ? copy.send.stale
                    : busy || queued
                    ? copy.send.preparing
                    : waiting ?? undefined
                }
                onPress={
                  !live || busy || queued
                    ? undefined
                    : disabled
                    ? onRefresh
                    : waiting
                    ? undefined
                    : prepare
                }
                busy={busy || queued}
                stale={disabled}
              />
            </Reanimated.View>
          </View>
          <View style={[styles.side, styles.end]}>
            {failure && failure.target !== 'request' ? (
              <FailureMark failure={failure} />
            ) : null}
          </View>
        </View>
      </>
    );
  }

  const composing = step === 'compose';
  const fitted = composing && room !== undefined;
  return (
    <TestNetwork.Provider value={test}>
      <View
        style={[
          styles.screen,
          fitted ? { height: Math.max(room, PINNED_MIN) } : styles.unfitted,
        ]}
      >
        {/* The request stays in place from step to step, a well while it is
          composed and a chip after, so only what changes crossfades. A
          chip past compose opens back to compose: from a review to edit
          the payment, from the held ring to take another request. */}
        {result ? null : (
          <RequestEntry
            accessibilityLabel={copy.send.request}
            value={request}
            onChangeText={composing && live ? typed : undefined}
            collapsed={!composing || collapsed}
            onExpand={
              composeBusy
                ? undefined
                : review
                ? edit
                : () => setCollapsed(false)
            }
            onCollapse={collapse}
            fixed={fixedSats !== null}
            refused={
              composing && failure?.target === 'request' ? failure : null
            }
            busy={composeBusy}
            onPaste={composing ? paste : undefined}
            onScan={composing ? scan : undefined}
          />
        )}
        {/* The step slides, rather than jumps, as the request above it opens
          into the well or closes into a chip. A step whose mark grows out of
          the hold takes no entrance, since a rise would carry the mark with
          it; one that takes the mark's place before the hold's look has
          given way, as compose does when the chip is tapped, moves as the
          steps do. */}
        <Reanimated.View
          key={step}
          entering={
            arrival && (step === 'result' || step === 'held')
              ? undefined
              : sceneIn()
          }
          exiting={sceneOut()}
          layout={smooth()}
          onTouchStart={result || resolved ? touched : undefined}
          onFocus={result || resolved ? touched : undefined}
          style={[styles.step, fitted && styles.fitted]}
        >
          {content}
        </Reanimated.View>
      </View>
    </TestNetwork.Provider>
  );
}

/**
 * The least room compose is given, as Receive's amount step has: enough for
 * what is entered to scroll above the way on. Past that the slot scrolls.
 */
const PINNED_MIN = PRIMARY_CONTROL * 3;

const styles = StyleSheet.create({
  screen: { gap: space.lg },
  unfitted: { flex: 1 },
  step: { flexGrow: 1, gap: space.lg },
  fitted: { flexShrink: 1, flexBasis: 0 },
  entry: { flex: 1 },
  entryContent: { flexGrow: 1, gap: space.lg },
  body: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingVertical: space.lg,
  },
  note: { ...typography.row, color: palette.steam, textAlign: 'center' },
  maximum: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: space.xs,
  },
  // As tall as Receive's row, so the two controls share their pixels.
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: CONTROL_ROW,
  },
  centred: { justifyContent: 'center' },
  // A side slot holds its control against the page edge, as the pencil and
  // a refusal's mark sit at the edges the rest of the scene keeps.
  side: { width: 56 },
  start: { alignItems: 'flex-start' },
  end: { alignItems: 'flex-end' },
  fee: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  unseen: { opacity: 0 },
  feeText: { ...typography.line, color: palette.steam },
});
