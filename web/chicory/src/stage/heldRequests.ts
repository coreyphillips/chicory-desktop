import type { Activity, PaymentStatus } from '@beignet/wallet-core';

/**
 * Requests that cannot be paid again (REDESIGN.md rule 6).
 *
 * A payment that is still pending, or whose outcome is unknown, may yet
 * land. Paying its request a second time could pay twice, so Send takes such
 * a request straight to the held ring instead of a review. The old screens
 * said "Check Activity before paying this request again" and trusted the
 * reader; this holds the request instead.
 *
 * A request that is paid for good is held for good: an invoice, or a
 * Bitcoin request that names its amount, is paid once, so Send lands it on
 * its paid mark. A bare address, or a request that names no amount, may be
 * paid again, so its payment completing lets it go. The completion is kept
 * apart (`completedHere`) until the request is paid again, so a screen whose
 * held ring was watching the payment sees it land. A payment that failed
 * moved no money, and lets any request go.
 *
 * Two things hold a request. What this app saw happen to it, kept for the
 * life of the process, and the history itself: a sent payment there matched
 * by the payment hash of the invoice the request carries, by the
 * transaction this app saw it paid with, or by the row the engine keeps for
 * this app's submission of it (`submissionId`), which names the transaction
 * of a payment to an address only once it is broadcast. Either knowing a
 * request paid is enough, so there is no gap between a payment's call
 * answering and the history showing it. The history lets a request go once the payment it
 * shows has failed, or has completed and the request may be paid again, but
 * never while this app's own call to pay it has not answered: an older
 * attempt the history shows says nothing about the one still going out.
 *
 * A request is held under one key however it was copied: the invoice it
 * carries, bare or inside a Bitcoin link, or else its address and the
 * amount it names. A label, a message or the order of its parameters does
 * not make it another request.
 *
 * The set is not per wallet. An invoice or address paid from one wallet
 * while the outcome is unknown is just as unsafe to pay from another.
 */

type HeldStatus = 'pending' | 'uncertain' | 'completed';

export interface Held {
  /** Pending or uncertain while it may still land; completed once paid. */
  status: HeldStatus;
  /** The payment in the history the request is held for, once it shows. */
  item?: Activity;
}

interface Entry {
  status: HeldStatus;
  paymentHash?: string;
  txid?: string;
  /** The id this app sent the payment under, which its history row carries. */
  id?: string;
  /** This app's call to pay it has not answered yet. */
  calling?: boolean;
  /**
   * When this app's attempt began, for a payment that may still land. The
   * history speaks for that attempt only through rows no older than it.
   */
  since?: number;
}

/** What paying a request came to, as far as this app has seen. */
export interface HeldOutcome {
  status: PaymentStatus;
  paymentHash?: string;
  txid?: string;
  /**
   * The id the payment was sent under: the review's as it goes out, and the
   * answer's once it comes. The history shows this app's submission as
   * `submissionId(id)`.
   */
  id?: string;
  /**
   * The payment is going out now and its call has not answered: nothing the
   * history shows lets the request go until the call does.
   */
  calling?: boolean;
}

const held = new Map<string, Entry>();

/**
 * The id the history gives a payment this app submitted under `id`: the
 * engine and the adapter both keep it as `submission:` and the id, until its
 * transaction or its invoice's payment shows under a row of its own.
 */
export const submissionId = (id: string) => `submission:${id}`;

/**
 * The payment this app last saw complete each request that may be paid
 * again, by key, which the held set lets go as it completes. Forgotten as
 * the request is paid again, or its attempt comes to anything else.
 */
const completions = new Map<string, HeldOutcome>();

/** Only what finds the payment in the history, not the whole answer. */
const completion = ({ paymentHash, txid }: HeldOutcome): HeldOutcome => ({
  status: 'completed',
  paymentHash: paymentHash || undefined,
  txid: txid || undefined,
});

// Screens that show a request read the set as they draw, and are told when
// this app changes it, so one that shows the request moves with it, even
// when the change comes from a call a screen that has since gone made.
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  listeners.forEach(listener => listener());
}

/** Calls `listener` whenever this app holds or lets go of a request. */
export function subscribeHeld(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A number that changes whenever this app holds or lets go of a request. */
export const heldVersion = () => version;

const SCHEME = /^(lightning|bitcoin):/;

/**
 * One spelling per request: case, surrounding space and the scheme are how a
 * request was copied, not which request it is.
 */
export function normalizeRequest(request: string): string {
  return request.trim().toLowerCase().replace(SCHEME, '');
}

// Bech32, as far as reading one field of a bolt11 invoice needs it. The
// checksum is not verified: a garbled invoice yields a hash no payment has,
// and so holds nothing.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHECKSUM_WORDS = 6;
const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;
/** The `p` field: the payment hash, 256 bits in 52 five-bit words. */
const HASH_TAG = 1;
const HASH_WORDS = 52;

/** An invoice's five-bit data words, or null when it is not one. */
function invoiceWords(invoice: string): number[] | null {
  const separator = invoice.lastIndexOf('1');
  if (!invoice.startsWith('ln') || separator < 3) return null;
  const words: number[] = [];
  for (const char of invoice.slice(separator + 1)) {
    const word = CHARSET.indexOf(char);
    if (word === -1) return null;
    words.push(word);
  }
  return words.slice(0, -CHECKSUM_WORDS);
}

/** Five-bit words as hex, dropping the padding bits at the end. */
function hexOf(words: number[]): string {
  let bits = 0;
  let buffer = 0;
  let out = '';
  for (const word of words) {
    buffer = buffer * 32 + word;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      const unit = 2 ** bits;
      out += Math.floor(buffer / unit)
        .toString(16)
        .padStart(2, '0');
      buffer %= unit;
    }
  }
  return out;
}

/** The Lightning invoice `text`, a normalized request, is or carries. */
const invoiceIn = (text: string) =>
  text.startsWith('ln') ? text : /[?&]lightning=([^&]+)/.exec(text)?.[1];

/**
 * The payment hash of the Lightning invoice `request` is or carries, or null
 * when it carries none that reads cleanly.
 */
export function paymentHashOf(request: string): string | null {
  const invoice = invoiceIn(normalizeRequest(request));
  const words = invoice ? invoiceWords(invoice) : null;
  if (!words) return null;
  const end = words.length - SIGNATURE_WORDS;
  for (let at = TIMESTAMP_WORDS; at + 3 <= end; ) {
    const start = at + 3;
    const length = words[at + 1] * 32 + words[at + 2];
    if (
      words[at] === HASH_TAG &&
      length === HASH_WORDS &&
      start + length <= end
    ) {
      return hexOf(words.slice(start, start + length));
    }
    at = start + length;
  }
  return null;
}

/**
 * The key a request is held under: the Lightning invoice it is or carries,
 * or else its address and the amount it names, in sats so that 0.001 and
 * 0.00100 are one amount. `request` may be spelled any way it is copied.
 */
export function requestKey(request: string): string {
  const text = normalizeRequest(request);
  const invoice = invoiceIn(text);
  if (invoice) return invoice;
  const [address, query = ''] = text.split('?', 2);
  const amount = /(?:^|&)amount=([^&]*)/.exec(query)?.[1];
  const sats = amount ? Math.round(Number(amount) * 1e8) : 0;
  return sats > 0 ? `${address}?amount=${sats}` : address;
}

/** A BOLT 11 invoice's prefix: lnbc, lntb, lntbs, lnbcrt or lnsb. */
const BOLT11 = /^ln(bc|tb|sb)/;

/**
 * Whether `request` is paid once and never again: a Lightning invoice, bare
 * or carried in a Bitcoin link, or a Bitcoin request that names its amount.
 * A bare address, or a Bitcoin request that leaves the amount to the payer,
 * may rightly be paid again, and so may an offer.
 */
export function paidOnce(request: string): boolean {
  const text = normalizeRequest(request);
  if (BOLT11.test(invoiceIn(text) ?? '')) return true;
  const amount = /^bitcoin:[^?]*\?(?:.*&)?amount=([^&]*)/.exec(
    request.trim().toLowerCase(),
  )?.[1];
  return !!amount && Number(amount) > 0;
}

/**
 * Records what paying `request` came to. A payment still pending, or whose
 * outcome is unknown, holds the request, and one that completed holds a
 * request that is paid once for good; one that failed, or completed a
 * request that may be paid again, lets it go. A completion of one that may
 * be paid again is kept for `completedHere`.
 */
export function holdRequest(request: string, outcome: HeldOutcome) {
  const key = requestKey(request);
  if (!key) return;
  const { status } = outcome;
  const before = held.get(key);
  if (status === 'completed' && !paidOnce(request)) {
    completions.set(key, completion(outcome));
  } else {
    completions.delete(key);
  }
  if (
    status === 'pending' ||
    status === 'uncertain' ||
    (status === 'completed' && paidOnce(request))
  ) {
    const open = status !== 'completed';
    held.set(key, {
      status,
      paymentHash: outcome.paymentHash || paymentHashOf(request) || undefined,
      txid: outcome.txid || undefined,
      // An answer without an id keeps the one the call went out under.
      id: outcome.id || (open ? before?.id : undefined) || undefined,
      calling: (status === 'pending' && outcome.calling) || undefined,
      // An answer to the call keeps the time the attempt began.
      since: open ? before?.since ?? Date.now() : undefined,
    });
  } else {
    held.delete(key);
  }
  changed();
}

const unsettled = (payment: Activity) =>
  payment.status === 'pending' || payment.status === 'uncertain';

/**
 * Whether `request` is held, and by which payment in `activity` when the
 * history shows it: pending or uncertain while its payment may still land,
 * and completed once it is paid for good. Paid, as the history or this app
 * knows it, wins; a payment the history shows as failed, or completed for a
 * request that may be paid again, lets the request go, unless this app's
 * own call to pay it has not answered yet, or the row is older than this
 * app's attempt: an earlier attempt that failed says nothing about the one
 * that may still land.
 */
export function heldRequest(
  request: string,
  activity: readonly Activity[] = [],
): Held | null {
  const key = requestKey(request);
  if (!key) return null;
  const entry = held.get(key);
  const hash = entry?.paymentHash ?? paymentHashOf(request);
  const txid = entry?.txid;
  const submitted = entry?.id ? submissionId(entry.id) : null;
  // This attempt's own rows: its transaction, or its submission.
  const own = (payment: Activity) =>
    !!(
      (txid && payment.txid === txid) ||
      (submitted && payment.id === submitted)
    );
  const payments = activity.filter(
    payment =>
      payment.kind === 'sent' &&
      ((hash && payment.paymentHash === hash) || own(payment)),
  );
  const paid = payments.find(payment => payment.status === 'completed');
  const once = paidOnce(request);
  if (entry?.status === 'completed' || (paid && once)) {
    // The history's word is kept, so it holds after the history moves on.
    // Only this app's own changes are told to the screens: this one comes
    // from a read they have already been drawn with.
    if (!entry || entry.status !== 'completed') {
      held.set(key, {
        status: 'completed',
        paymentHash: hash ?? undefined,
        txid: txid ?? paid?.txid,
        id: entry?.id,
      });
    }
    return paid ? { status: 'completed', item: paid } : { status: 'completed' };
  }
  const open = payments.find(unsettled);
  if (open) return { status: open.status as HeldStatus, item: open };
  // The transaction this app paid with, and the row of its submission, are
  // this attempt's own; a payment hash is shared by every attempt at the
  // invoice.
  const since = entry?.since;
  const current = since
    ? payments.filter(payment => own(payment) || payment.timestamp >= since)
    : payments;
  if (current.length && !entry?.calling) {
    held.delete(key);
    // Seen by the history to complete, as `holdRequest` keeps an answer
    // that says so. Only this app's own changes are told to the screens.
    const done = current.find(payment => payment.status === 'completed');
    if (done && !once) completions.set(key, completion(done));
    return null;
  }
  return entry ? { status: entry.status } : null;
}

/**
 * The payment this app last saw complete `request`, when it is one that may
 * be paid again, which the held set lets go as it completes: for a screen
 * whose held ring was watching the payment, to resolve where it stands
 * rather than drop back as if nothing had happened. Null once the request
 * is paid again, and for a request paid once, which `heldRequest` keeps.
 */
export function completedHere(request: string): HeldOutcome | null {
  const key = requestKey(request);
  return key ? completions.get(key) ?? null : null;
}

/**
 * Forgets every request this process has held. For tests only, so each one
 * starts with nothing held: the app itself lets a request go only once the
 * payment it holds for fails, or completes for a request that may be paid
 * again.
 */
export function clearHeldRequests() {
  held.clear();
  completions.clear();
  changed();
}
