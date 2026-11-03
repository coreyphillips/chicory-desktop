import { MAX_FEE_RATE, parsePayment } from '@beignet/wallet-core';
import type {
  Activity,
  FeeRates,
  SendResult,
  SendReview,
  WalletSnapshot,
} from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { chipText } from '../../glyphs/chipText';
import type { GlyphName } from '../../design/glyphs';
import type { Held } from '../../stage/heldRequests';
import type { AmountTone } from '../keypad/keys';

/**
 * Send's states as data (REDESIGN.md 6, Send and Engine errors): what a
 * request, an amount, an engine error and a result each look like. Pure, so
 * the state-to-visual map is a table test and the screen only draws it.
 */

type Balance = WalletSnapshot['balance'];

function parsed(request: string) {
  try {
    return parsePayment(request.trim());
  } catch {
    return null;
  }
}

/**
 * The amount a payment request fixes, or null when it leaves it to the payer.
 * The same precedence prepareSend applies: the request's own amount, else the
 * amount of the Lightning invoice a Bitcoin link carries.
 */
export function fixedAmount(request: string): number | null {
  const payment = parsed(request);
  if (!payment) return null;
  const sats =
    payment.kind === 'bolt11' || payment.kind === 'bolt12'
      ? payment.amountSats
      : payment.kind === 'onchain'
      ? payment.amountSats ??
        (payment.lightning && 'amountSats' in payment.lightning
          ? payment.lightning.amountSats
          : null)
      : null;
  return typeof sats === 'number' && sats > 0 ? sats : null;
}

/**
 * The rail a request will most likely go over, as its glyph: Lightning
 * first, as prepareSend tries it, direct funding for a request that carries
 * an envelope and nothing else, and on chain otherwise. A request that does
 * not read as one has no rail yet; the engine has the last word either way.
 */
export function requestRail(request: string): GlyphName | null {
  const payment = parsed(request);
  if (payment?.kind === 'bolt11' || payment?.kind === 'bolt12') return 'bolt';
  if (payment?.kind !== 'onchain') return null;
  if (payment.lightning) return 'bolt';
  return payment.funding ? 'fund' : 'chain';
}

/** The rail a review settled on, as its glyph and its name. */
export function reviewRail(review: SendReview): {
  glyph: GlyphName;
  label: string;
} {
  if (review.method === 'direct-funding') {
    return { glyph: 'fund', label: copy.send.directFunding };
  }
  return review.route === 'lightning'
    ? { glyph: 'bolt', label: copy.send.lightning }
    : { glyph: 'chain', label: copy.send.bitcoin };
}

/** One line of a review's sum: its signs, its amount, and its words. */
export interface ReviewFigure {
  key: 'fee' | 'expected' | 'total';
  signs: string;
  sats: number;
  /**
   * The rate the fee was priced at, whole sats per virtual byte, on a rated
   * review's fee line; drawn beside the fee as `rateText` says it.
   */
  rate?: number;
  /** What a screen reader calls the line, as the engine and old screen did. */
  label: string;
  /** How its amount is read out. */
  value: string;
}

export function isPayAllReview(review: SendReview): review is SendReview & {
  minRecipientSats: number;
  maxFeeSats: number;
  debitSats: number;
  debitMsat: string;
} {
  return (
    review.max === true &&
    review.route === 'lightning' &&
    typeof review.minRecipientSats === 'number' &&
    typeof review.maxFeeSats === 'number' &&
    typeof review.debitSats === 'number' &&
    typeof review.debitMsat === 'string'
  );
}

/**
 * A review whose rate can move: a payment to a Bitcoin address by splice,
 * which the engine prices at a rate it reports (`feeRate`, whole sats per
 * virtual byte) with the estimates it had (`feeRates`). Lightning, direct
 * funding and a drain price themselves and carry neither.
 */
export type RatedReview = SendReview & { feeRate: number; feeRates: FeeRates };

export function isRatedReview(review: SendReview): review is RatedReview {
  return (
    review.route === 'bitcoin' &&
    review.method === undefined &&
    typeof review.feeRate === 'number' &&
    review.feeRate > 0 &&
    review.feeRates != null
  );
}

/**
 * The fee at `rate` from a review priced at `review.feeRate`. The engine's
 * fee is ceil(weight * rate * 250 / 1000) for a weight the rate does not
 * change, so scaling the reviewed fee by the ratio of the rates is exact to
 * within the engine's rounding; the quote on release settles the sat. At 1
 * sat per virtual byte the engine floors the rate at 253 sat/kw, so the
 * preview there runs about one percent low.
 */
export function previewFee(review: RatedReview, rate: number): number {
  return Math.max(1, Math.ceil((review.feeSats * rate) / review.feeRate));
}

/**
 * The review as it would read at `rate`: a max review's amount gives way to
 * the fee and its total holds; otherwise the total follows the fee.
 */
export function previewReview(review: RatedReview, rate: number): RatedReview {
  const feeSats = previewFee(review, rate);
  return review.max
    ? {
        ...review,
        feeRate: rate,
        feeSats,
        amountSats: Math.max(0, review.amountSats + review.feeSats - feeSats),
      }
    : { ...review, feeRate: rate, feeSats, totalSats: review.amountSats + feeSats };
}

/**
 * A fee rate as the fee line draws it, `3 sat/vB`: one string, the one
 * shape of a rate the copy guard admits as data (REDESIGN.md rule 1). A
 * screen reader hears it as `copy.send` says it, in sats per virtual byte.
 */
export const rateText = (rate: number) => `${rate} sat/vB`;

/** The least a rate can be: nothing below one sat per virtual byte relays. */
export const MIN_FEE_RATE = 1;

/**
 * The slider's reach: from the engine's minimum estimate to twice its fast
 * one, or ten above it in a quiet mempool so the track is never a few sats
 * wide, within the engine's ceiling; and always wide enough to hold `rate`,
 * the rate the review stands at, since the estimates move between quotes.
 */
export function feeRange(
  rates: FeeRates,
  rate: number,
): { min: number; max: number } {
  const min = Math.min(rate, Math.max(MIN_FEE_RATE, rates.minimum));
  const max = Math.max(
    rate,
    min + 1,
    Math.min(MAX_FEE_RATE, Math.max(rates.fast * 2, rates.fast + 10)),
  );
  return { min, max };
}

/**
 * How long the slider's quote may take before the hold shows it: a quote
 * back within a crossfade shows no change, and a slower one runs the hold's
 * orbit until it lands.
 */
export const REQUOTE_BEAT_MS = 160;

/**
 * What a payment will cost, as the review lays it out (REDESIGN.md 6,
 * Send): `+ ≤` the most the fee can be, `≈` what the route priced should
 * cost when there is an estimate, and `=` the most it all comes to.
 */
export function reviewFigures(review: SendReview): ReviewFigure[] {
  if (isPayAllReview(review))
    return [
      {
        key: 'fee',
        signs: '≤',
        sats: review.maxFeeSats,
        label: copy.send.routingFeeAtMost,
        value: copy.amount.spoken(review.maxFeeSats),
      },
      {
        key: 'total',
        signs: '',
        sats: review.debitSats,
        label: copy.send.totalDebit,
        value: copy.amount.spoken(review.debitSats),
      },
    ];
  const estimate = review.estimatedFeeSats;
  const figures: ReviewFigure[] = [
    {
      key: 'fee',
      signs: '+ ≤',
      sats: review.feeSats,
      ...(isRatedReview(review) ? { rate: review.feeRate } : {}),
      label: review.feeLabel || copy.send.fee,
      value: copy.amount.spoken(review.feeSats),
    },
  ];
  if (estimate != null) {
    figures.push({
      key: 'expected',
      signs: '≈',
      sats: estimate,
      label: copy.send.expectedFee,
      value: copy.send.about(estimate),
    });
  }
  figures.push({
    key: 'total',
    signs: '=',
    sats: review.totalSats,
    label: estimate != null ? copy.send.totalAtMost : copy.send.totalWithFee,
    value: copy.amount.spoken(review.totalSats),
  });
  return figures;
}

const sentence = (text: string) =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

/**
 * The review as the hold says it to a screen reader: the total first, then
 * the most the fee can be, what it should cost, and every warning the
 * engine gave. The hold commits on one action, so whatever the lines above
 * it show is said with it too, and nothing a sighted payer is shown before
 * holding is left for a screen reader to find on its own.
 */
export function reviewWords(review: SendReview): string {
  if (isPayAllReview(review))
    return [
      copy.send.payAllFacts(
        review.minRecipientSats,
        review.maxFeeSats,
        review.debitSats,
      ),
      ...review.warnings.map(sentence),
    ].join(' ');
  const figures = reviewFigures(review);
  const total = figures.filter(figure => figure.key === 'total');
  const rest = figures.filter(figure => figure.key !== 'total');
  return [...total, ...rest]
    .map(figure => `${figure.label} ${figure.value}`)
    .concat(review.warnings)
    .map(sentence)
    .join(' ');
}

/**
 * Where a request pays, as the chip shows it: the address or the invoice,
 * without its scheme, as every chip draws a value (`chipText`): its prefix
 * whole, the rest in groups of four, shortened in the middle.
 */
export function shortRequest(request: string): string {
  const payment = parsed(request);
  const destination =
    payment?.kind === 'onchain'
      ? payment.address
      : payment?.kind === 'bolt11'
      ? payment.invoice
      : payment?.kind === 'bolt12'
      ? payment.offer
      : request.trim().replace(/^(lightning|bitcoin):/i, '');
  return chipText(destination);
}

/**
 * Whether money on its way would let `sats` go, once it lands. Only then does
 * waiting help: the gap between what can be sent and the total may be money
 * that never becomes spendable, such as the channel's reserve.
 */
export function arrivalCovers(sats: number, balance: Balance): boolean {
  return (
    balance.pendingSats > 0 &&
    sats <= balance.totalSats &&
    sats <= balance.availableSats + balance.pendingSats
  );
}

/**
 * How an amount sits against the balance (REDESIGN.md 5, Keypad): honey,
 * with its clock, only while what is arriving would cover it, and radish past
 * what can be sent when waiting would not help.
 */
export function amountTone(sats: number, balance?: Balance): AmountTone {
  if (!balance || !(sats > 0) || sats <= balance.availableSats) return 'plain';
  return arrivalCovers(sats, balance) ? 'over-spendable' : 'over-total';
}

/**
 * What a screen reader hears about an amount held against the balance, for
 * `tone`: that the rest is on its way only while it is, that the wallet holds
 * less only past its total, and otherwise how much can be sent now, which is
 * the limit the amount went past. Null while the amount is fine.
 */
export function amountWords(
  tone: AmountTone,
  sats: number,
  balance?: Balance,
): string | null {
  if (tone === 'over-spendable') return copy.amount.overSpendable;
  if (tone !== 'over-total') return null;
  if (!balance || sats > balance.totalSats) return copy.amount.overTotal;
  return `${copy.home.split(balance.availableSats, balance.pendingSats)}.`;
}

/**
 * Where an engine error shows, and how (REDESIGN.md 6, Engine errors):
 *
 * - request: the chip dissolves back into the well, and a cross draws;
 * - amount: the amount takes the tone, as it does against the balance;
 * - control: a mark beside the control that asked.
 *
 * Each carries the engine's own message, which a screen reader hears and
 * Whisper shows, and `code` for the diagnostic log.
 */
export interface Failure {
  code: string;
  message: string;
  target: 'request' | 'amount' | 'control';
  tone: 'honey' | 'radish';
  glyphs: GlyphName[];
  shake: boolean;
  haptic: 'warning' | 'error';
}

/** Codes for a request the engine will not pay, whatever the amount. */
const REFUSED = new Set([
  'INVALID_REQUEST',
  'OFFER_NOT_QUOTABLE',
  'INVOICE_EXPIRED',
  'INVALID_NETWORK',
  'AMOUNT_CONFLICT',
  'INPUT_TOO_LONG',
  'BIDI_CONTROL',
  'DUPLICATE_AMOUNT',
  'MALFORMED_PERCENT_ENCODING',
  'NOT_PAYABLE',
  'NON_ASCII',
  'LNURL_UNSUPPORTED',
  'BOLT12_REQUEST_UNSUPPORTED',
  'LIGHTNING_ADDRESS_UNSUPPORTED',
]);
/** The parser's families of refusals: bech32, addresses, invoices, BIP21. */
const REFUSED_FAMILY =
  /^(B32|ADDR|BOLT11|BASE58|BIP21)_|^AMOUNT_(EMPTY|NOT_DECIMAL|SUB_SATOSHI|OVER_MAX_MONEY)$/;

/** Codes for an amount the engine will not take. */
const AMOUNT_REFUSED = new Set(['AMOUNT_REQUIRED', 'INVALID_AMOUNT']);

/**
 * Codes that mean the payment may have gone out. They are never an error to
 * retry: the request is held and the result is unknown.
 */
const UNCERTAIN = new Set([
  'RESULT_UNCERTAIN',
  'UNCERTAIN',
  'ALREADY_SUBMITTED',
]);

export const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};

export const isUncertain = (error: unknown) => UNCERTAIN.has(errorCode(error));

/**
 * Preparing pays nothing, so a prepare that fails, even for want of an
 * answer, leaves the request free. The one exception is the engine saying a
 * payment for it is already out: that request is held.
 */
export const alreadySubmitted = (error: unknown) =>
  errorCode(error) === 'ALREADY_SUBMITTED';

/** A failure of `code` with the engine's `message`, drawn as the rest say. */
function failureOf(
  code: string,
  message: string,
  target: Failure['target'],
  tone: Failure['tone'],
  glyphs: GlyphName[],
): Failure {
  return {
    code,
    message,
    target,
    tone,
    glyphs,
    shake: tone === 'radish',
    haptic: tone === 'radish' ? 'error' : 'warning',
  };
}

/**
 * Why a request cannot be paid, read as it is entered (pasted, scanned,
 * brought by a link, or typed and left) by the parser the engine reads it
 * with, or null when it reads as a payment or is empty. A refused request
 * never takes the accepted look: it stays in the well with a cross
 * (REDESIGN.md 6, Engine errors). The engine still has the last word at
 * review, for what only it can know, such as the wallet's network.
 */
export function requestRefusal(request: string): Failure | null {
  const payment = parsed(request);
  if (payment?.kind !== 'invalid') return null;
  return failureOf(payment.code, payment.message, 'request', 'radish', [
    'cross',
  ]);
}

/**
 * What the review waits for, as its hint, or null when it is live: a
 * request, one that can be paid (`refused` is whether it was refused), and
 * an amount above zero. Until then it is drawn and told as disabled.
 */
export function reviewWaiting(
  request: string,
  refused: boolean,
  amountSats: number,
): string | null {
  if (!request.trim()) return copy.send.reviewWaits;
  if (refused) return copy.send.reviewRefused;
  return amountSats > 0 ? null : copy.send.amountWaits;
}

/**
 * Whether the review is live as Send opens on `request`, before anything is
 * typed: the amount starts empty, so only a request that names its own
 * amount has one. Home draws the circle that lands on the review in this
 * look (`launchLook` in stage/layout), so the two agree.
 */
export function reviewOpensLive(request: string): boolean {
  return (
    reviewWaiting(
      request,
      requestRefusal(request) !== null,
      fixedAmount(request) ?? 0,
    ) === null
  );
}

export function sendFailure(
  error: unknown,
  context: { message: string; amountSats: number | null; balance?: Balance },
): Failure {
  const code = errorCode(error);
  const failure = (
    target: Failure['target'],
    tone: Failure['tone'],
    glyphs: GlyphName[],
  ): Failure => failureOf(code, context.message, target, tone, glyphs);
  if (REFUSED.has(code) || REFUSED_FAMILY.test(code)) {
    return failure('request', 'radish', ['cross']);
  }
  if (code === 'INSUFFICIENT_FUNDS') {
    // Honey and a clock say waiting will help, so only while money on its
    // way would cover the amount; otherwise it is past what can be sent.
    const { amountSats, balance } = context;
    const waits =
      !balance ||
      (amountSats === null
        ? balance.pendingSats > 0
        : arrivalCovers(amountSats, balance));
    return waits
      ? failure('amount', 'honey', ['clock'])
      : failure('amount', 'radish', ['bang']);
  }
  if (AMOUNT_REFUSED.has(code)) return failure('amount', 'radish', ['bang']);
  switch (code) {
    case 'PRIMARY_DOWN':
      return failure('control', 'honey', ['unplug']);
    case 'NO_ROUTE':
      return failure('control', 'radish', ['bolt', 'cross']);
    case 'FUNDING_UNCONFIRMED':
      return failure('control', 'honey', ['chain', 'clock']);
    case 'QUOTE_EXPIRED':
      return failure('control', 'honey', ['refresh']);
    default:
      return failure('control', 'radish', ['bang']);
  }
}

/**
 * A refusal of a rate the slider chose: drawn beside the hold whatever its
 * code, since the review it came from stays, so the chip never reopens and
 * no amount on the review is shaken. Its tone and glyphs are the engine
 * error table's.
 */
export const rateRefusal = (failure: Failure): Failure => ({
  ...failure,
  target: 'control',
  shake: false,
});

/**
 * Where a payment over a Bitcoin `rail` (on chain or direct funding) stands
 * once the engine has answered it pending, or null for any other result.
 *
 * - broadcast: the transaction that carries it is out, so nothing more is
 *   asked of the payer and the history follows it to its confirmation, which
 *   takes blocks. The engine's answer may name the transaction, or the
 *   payment's row in the history (`item`) names it later, or has completed.
 * - broadcasting: the engine took the payment but has not named its
 *   transaction yet. A splice-out is answered this way as the splice starts,
 *   and is negotiated, signed and broadcast a few seconds later; the history
 *   names the transaction once the chain has it.
 *
 * A Lightning payment pending with only its hash can still settle within
 * seconds, so it has neither.
 */
export type ChainStage = 'broadcasting' | 'broadcast';

export function chainStage(
  result: SendResult,
  rail: GlyphName,
  item?: Pick<Activity, 'txid' | 'status'> | null,
): ChainStage | null {
  if (result.status !== 'pending' || rail === 'bolt') return null;
  return result.txid || item?.txid || item?.status === 'completed'
    ? 'broadcast'
    : 'broadcasting';
}

/**
 * How often Send asks for a fresh read of the history while a payment is
 * broadcasting, counted from the end of the read before, and for how long
 * after the payment's answer it keeps asking. After that the wallet's own
 * poll carries it.
 */
export const BROADCAST_POLL_MS = 3_000;
export const BROADCAST_WATCH_MS = 60_000;

/**
 * A result's mark (REDESIGN.md 6, Send). Each outcome has its own shape as
 * well as its own colour, so none can be mistaken for another without
 * colour: a filled disc is done, an orbit is moving, a steady ring with a
 * halo is held, and an open outline with a bang has failed. A payment
 * broadcast on chain is done as far as the payer goes, so it is the disc
 * too, with a clock in the check's place.
 */
export interface ResultVisual {
  shape: 'disc' | 'orbit' | 'held' | 'broken';
  tone: 'cream' | 'bloom' | 'honey' | 'radish';
  glyph: GlyphName;
  title: string;
  /** Home follows on its own a moment later, unless the screen is touched. */
  returnsHome: boolean;
  /** An orbit runs round the held ring: the payment is still under way. */
  orbit?: boolean;
  /** Drawn as it stands, for a payment seen before: no pop, no draw-in. */
  resting?: boolean;
  /**
   * Grown out of the held ring or the orbit it replaces, for a payment seen
   * to complete, or to be broadcast, while that was on screen: the ring
   * gives way to the disc and its glyph draws.
   */
  resolves?: boolean;
}

/**
 * The mark for a result of `status`. A pending one is the orbit of a
 * payment still in flight, round the send arrow for Lightning. Over a
 * Bitcoin `rail` it follows its `stage` (`chainStage` above): while it is
 * broadcasting the orbit runs round the rail's own glyph, so it never reads
 * as a Lightning payment in flight; once broadcast it rests on the done disc
 * with a clock, since nothing more happens on this screen, and goes home on
 * its own as a completed payment does. The clock, not the check, says it is
 * not settled yet without relying on colour (REDESIGN.md 9, Shape as well as
 * color).
 */
export function resultVisual(
  status: SendResult['status'],
  stage: ChainStage | null = null,
  rail: GlyphName = 'chain',
): ResultVisual {
  switch (status) {
    case 'completed':
      return {
        shape: 'disc',
        tone: 'cream',
        glyph: 'check',
        title: copy.send.sent,
        returnsHome: true,
      };
    case 'pending':
      if (stage === 'broadcast')
        return {
          shape: 'disc',
          tone: 'cream',
          glyph: 'clock',
          title: copy.send.confirming,
          returnsHome: true,
        };
      return stage === 'broadcasting'
        ? {
            shape: 'orbit',
            tone: 'bloom',
            glyph: rail,
            title: copy.send.broadcasting,
            returnsHome: false,
          }
        : {
            shape: 'orbit',
            tone: 'bloom',
            glyph: 'send',
            title: copy.send.onItsWay,
            returnsHome: false,
          };
    case 'uncertain':
      return {
        shape: 'held',
        tone: 'honey',
        glyph: 'pause',
        title: copy.send.unknown,
        returnsHome: false,
      };
    case 'failed':
      return {
        shape: 'broken',
        tone: 'radish',
        glyph: 'bang',
        title: copy.send.failed,
        returnsHome: false,
      };
  }
}

/**
 * The mark of a request that cannot be paid now (REDESIGN.md rule 6): the
 * held ring, with an orbit inside it while its payment is still under way,
 * and the done disc once the request is paid. A request paid before rests
 * on its disc, with nothing played for a payment that was seen before and
 * no way home on its own. One whose held ring was `watched` on screen as
 * its payment completed resolves into the disc instead, and is the payment
 * it saw go, as a completed result is: worded as sent, not already paid,
 * and home on its own a moment later.
 */
export function heldVisual(
  status: Held['status'],
  watched = false,
): ResultVisual {
  if (status === 'completed') {
    const done = resultVisual('completed');
    return watched
      ? { ...done, resolves: true }
      : {
          ...done,
          title: copy.send.paidAlready,
          resting: true,
          returnsHome: false,
        };
  }
  const held = resultVisual('uncertain');
  return status === 'pending'
    ? { ...held, title: copy.send.onItsWay, orbit: true }
    : held;
}

/** How long a result that returns home stays on screen before it does. */
export const HOME_AFTER_MS = 2200;

/**
 * How long a payment's call keeps the stage busy. Most payments answer well
 * inside it and show their result where they were sent. One that has not
 * answered by then lets the stage go and moves to the held ring, so Send is
 * never a dead end while a payment hangs; the call goes on, and its answer
 * is recorded whenever it comes.
 */
export const SEND_GRACE_MS = 8_000;
