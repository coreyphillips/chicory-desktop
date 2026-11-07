import type {
  Activity,
  ReceiveRequest,
  ReceiveRequestDetails,
  ReceiveStatus,
} from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import type { GlyphName } from '../../design/glyphs';
import { PETALS, PETAL_LENGTHS, petalAngle } from '../../glyphs/Bloom';
import { QR_CARD_GONE } from '../../glyphs/QrBloom';
import type { QrState } from '../../glyphs/QrBloom';
import { springStep } from '../../motion/springMath';
import { durations, overlap, springs } from '../../motion/tokens';

/**
 * What Receive shows for each state, as pure answers (REDESIGN.md 6,
 * Receive), so the safety rules are table tests and the screen only draws
 * what it is told.
 */

/** The amounts offered as chips under the amount. */
export const PRESETS = [1_000, 10_000, 50_000];

/** The fewest sats an offline receive can take. */
export const OFFLINE_MIN_SATS = 354;

/** A request frame turns honey this close to its end, or later. */
const LATE_SHARE = 0.1;
const LATE_MS = 60_000;

/** The digits typed, as sats; nothing typed is 0. */
export function typedSats(amount: string): number {
  const digits = amount.trim();
  return /^\d+$/.test(digits) ? Number(digits) : 0;
}

/**
 * What the strip over the amount says. `any` is an infinity: the sender
 * chooses. `required` is a sprout: the primary makes a channel just in time,
 * so there has to be an amount to size it. `offline` is the moon and the cap
 * an offline receive can take, with the amount `over` it refused and one
 * `under` the floor not yet enough.
 */
export interface AmountCue {
  kind: 'any' | 'required' | 'offline';
  empty: boolean;
  over: boolean;
  under: boolean;
}

export function amountCue({
  amount,
  required,
  offline,
  cap,
}: {
  amount: string;
  required: boolean;
  offline: boolean;
  cap?: number;
}): AmountCue {
  const sats = typedSats(amount);
  return {
    kind: offline ? 'offline' : required ? 'required' : 'any',
    empty: sats === 0,
    over: offline && cap !== undefined && sats > cap,
    under: offline && sats > 0 && sats < OFFLINE_MIN_SATS,
  };
}

/**
 * The glyph beside a quote's fee: the moon for an offline receive, a sprout
 * when the primary has to make a channel for it just in time, and the bolt
 * for an ordinary Lightning receive over the channel there is.
 */
export function feeGlyph({
  offline,
  feeSats,
  amountSats,
  receivableSats,
}: {
  offline: boolean;
  feeSats: number;
  amountSats: number | null;
  receivableSats: number;
}): 'moon' | 'sprout' | 'bolt' {
  if (offline) return 'moon';
  if (feeSats > 0 || (amountSats ?? 0) > receivableSats) return 'sprout';
  return 'bolt';
}

/** How a request can be paid: over Lightning, and on chain unless not. */
export function requestRails(
  request: Pick<ReceiveRequestDetails, 'address' | 'bitcoinTracking'> & {
    legacy?: boolean;
  },
): GlyphName[] {
  const chain =
    !request.legacy &&
    !!request.address &&
    request.bitcoinTracking !== 'lightning-only';
  return chain ? ['bolt', 'chain'] : ['bolt'];
}

/** When a request made at `createdAt` starts to count as running out. */
export function lateAt(createdAt: number, expiresAt: number): number {
  return expiresAt - Math.max(LATE_SHARE * (expiresAt - createdAt), LATE_MS);
}

/**
 * The face a request on screen shows, in order of what matters most: once
 * something is paid the code implodes, a reused address scatters it, and an
 * expired request dissolves it. Only a request still to be paid, on an
 * address of its own, can be shared or copied. `reused` holds after money
 * arrives too, since Lightning receipts are still matched by invoice while
 * Bitcoin ones on that address cannot be.
 */
export interface RequestFace {
  qr: QrState;
  shareable: boolean;
  expired: boolean;
  late: boolean;
  reused: boolean;
}

export function requestFace({
  request,
  now,
  paid,
  ambiguous,
  createdAt = request.createdAt ?? request.expiresAt,
}: {
  request: Pick<ReceiveRequest, 'expiresAt' | 'createdAt'>;
  now: number;
  paid: boolean;
  ambiguous: boolean;
  /** When the request was made, where it does not say itself. */
  createdAt?: number;
}): RequestFace {
  const expired = now >= request.expiresAt;
  const qr: QrState = paid
    ? 'paid'
    : ambiguous
    ? 'scattered'
    : expired
    ? 'expired'
    : 'shown';
  return {
    qr,
    shareable: qr === 'shown',
    expired,
    late: qr === 'shown' && now >= lateAt(createdAt, request.expiresAt),
    reused: ambiguous,
  };
}

/**
 * The face a request kept in a payment's detail shows. A receipt means it
 * was paid; a pending request that is still in time and whose status and
 * address can be trusted is the only one that can still be shared.
 */
export function detailFace(
  item: Pick<
    Activity,
    'kind' | 'status' | 'receiveStatus' | 'receiveStatusUnavailable'
  >,
  request: Pick<ReceiveRequestDetails, 'expiresAt' | 'bitcoinTracking'>,
  now: number,
): { qr: QrState | null; shareable: boolean } {
  const receipt =
    !!item.receiveStatus && item.receiveStatus.phase !== 'waiting';
  if (receipt || item.status === 'completed') {
    return { qr: null, shareable: false };
  }
  if (request.bitcoinTracking === 'ambiguous') {
    return { qr: 'scattered', shareable: false };
  }
  const waiting =
    item.kind === 'request' &&
    item.status === 'pending' &&
    request.expiresAt > now &&
    !item.receiveStatusUnavailable;
  if (waiting) return { qr: 'shown', shareable: true };
  return {
    qr:
      item.status === 'expired' || request.expiresAt <= now ? 'expired' : null,
    shareable: false,
  };
}

/**
 * Something Receive asked for that was refused: what is said of it, its code
 * where the engine gave one, and whether it was the amount that was refused.
 */
export interface Refused {
  message: string;
  code?: string;
  /** The amount was refused: it turns radish, and the way on waits for another. */
  amount?: boolean;
}

/** The provider's cap on one receive, in the engine's words. */
const PROVIDER_CAP = /funds at most (\d+) sats for one receive/i;

/** Codes for an amount the engine will not take for a receive. */
const AMOUNT_REFUSED = new Set(['INVALID_AMOUNT', 'RECEIVE_FEE_TOO_HIGH']);

/**
 * A refusal as Receive says it (REDESIGN.md 6, Engine errors): the ones it
 * knows in its own words, with the amounts in them formatted as amounts,
 * and anything else in the engine's words. The provider's cap arrived as
 * "the provider funds at most 1000000 sats for one receive" (P10, 19).
 * `amount` marks a refusal of the amount itself. The engine's own words go
 * to the diagnostic log whatever is said.
 */
export function receiveRefusal(
  message: string,
  code?: string,
): { said: string; amount: boolean } {
  const cap = message.match(PROVIDER_CAP);
  if (cap) {
    return { said: copy.receive.providerCap(Number(cap[1])), amount: true };
  }
  // None of the ranked primaries took it: Receive's words first, then the
  // engine's reason for each.
  if (code === 'NO_PRIMARY_AVAILABLE')
    return { said: `${copy.receive.noPrimary} ${message}`.trim(), amount: false };
  return { said: message, amount: !!code && AMOUNT_REFUSED.has(code) };
}

/**
 * How Receive shows a refusal (REDESIGN.md 6, Engine errors). The primary
 * node away is a honey unplug, felt as a warning and never shaken: nothing
 * asked for was wrong, and it passes once the node is back. Anything
 * unmapped is a radish bang, felt as an error, and shakes the control that
 * asked.
 */
export interface RefusalLook {
  tone: 'honey' | 'radish';
  glyph: 'unplug' | 'bang';
  haptic: 'warning' | 'error';
  shake: boolean;
}

export function refusalLook(code: string | undefined): RefusalLook {
  // Every primary away, or none able to take the receive, is the same
  // passing state as the one primary away.
  return code === 'PRIMARY_DOWN' || code === 'NO_PRIMARY_AVAILABLE'
    ? { tone: 'honey', glyph: 'unplug', haptic: 'warning', shake: false }
    : { tone: 'radish', glyph: 'bang', haptic: 'error', shake: true };
}

/** What is still owed on a partly paid request, or null when unknown. */
export function remainderSats(
  amountSats: number | null,
  receipt: ReceiveStatus | null,
): number | null {
  if (amountSats == null || receipt?.phase !== 'partial') return null;
  return Math.max(0, amountSats - receipt.receivedSats);
}

/**
 * The receipt's ring (REDESIGN.md 5, Received celebration): full when the
 * payment is complete, a sage arc of what arrived over what was asked when
 * it is partial, and an orbit while it confirms on chain.
 */
export interface ReceiptRing {
  kind: 'full' | 'split' | 'orbit';
  /** How much of the ring the sage arc covers, 0 to 1. */
  share: number;
}

/** The arc an orbit keeps while it turns. */
export const ORBIT_SHARE = 0.25;

export function receiptRing(
  status: Pick<ReceiveStatus, 'phase' | 'receivedSats'>,
  amountSats: number | null,
): ReceiptRing {
  if (status.phase === 'completed') return { kind: 'full', share: 1 };
  if (status.phase === 'partial' && amountSats) {
    const share = Math.min(1, Math.max(0, status.receivedSats / amountSats));
    return { kind: 'split', share };
  }
  return { kind: 'orbit', share: ORBIT_SHARE };
}

/**
 * The transactions a Bitcoin receipt names, each confirmed or not. An
 * engine that lists only the ids leaves each confirmed once the whole
 * receipt is.
 */
export function receiptTransactions(
  status: Pick<ReceiveStatus, 'phase' | 'txids' | 'transactions'>,
): { txid: string; confirmed: boolean }[] {
  if (status.transactions?.length) {
    return status.transactions.map(({ txid, confirmed }) => ({
      txid,
      confirmed,
    }));
  }
  return status.txids.map(txid => ({
    txid,
    confirmed: status.phase === 'completed',
  }));
}

/**
 * The received celebration (REDESIGN.md 5), in ms from the moment money is
 * seen: the code implodes at once as its card contracts onto the receipt's
 * mark, the amount counts up, the sage ring draws round the mark once the
 * card has landed on it, and a completed payment draws its check and opens
 * the bloom's petals round the mark, a petal at a time (`bloom`), which
 * fold back into the ring once the amount has counted up (`fold`). The ring
 * and its husk track wait for the code's card to go, so no dark ring cuts
 * across the code while it implodes.
 */
export const CELEBRATION = {
  ring: { delay: QR_CARD_GONE, duration: 480 },
  track: { delay: QR_CARD_GONE, duration: 220 },
  count: { delay: 200, duration: 700 },
  check: { delay: 600, duration: 420 },
  bloom: { delay: 700, stagger: overlap.staggerMin, enter: durations.enter },
  fold: { delay: 1200, stagger: overlap.staggerMin, duration: durations.move },
  tint: { delay: 700 },
};

/** The petals round the mark: the bloom's twelve. */
export { PETALS };

/**
 * How long the bloom's clock runs, in ms from its first petal setting out to
 * its last folded away: the clock every petal reads its own pose from.
 */
export const BLOOM_SPAN =
  CELEBRATION.fold.delay -
  CELEBRATION.bloom.delay +
  CELEBRATION.fold.stagger * (PETALS - 1) +
  CELEBRATION.fold.duration;

/** How far a petal reaches past the rim's outer edge, in points. */
export const PETAL_REACH = 30;

/** How far inside the rim's outer edge a petal is rooted, so no gap shows. */
export const PETAL_ROOT = 2;

/**
 * Petal `i` of the bloom at `t` ms on the bloom's clock: how far it has
 * opened out from the rim (0 to 1, past 1 as the reveal spring overshoots),
 * its resting angle and length as the bloom has them, and how much of it
 * shows. Each petal sets out a stagger after the one before, opens on the
 * reveal spring and fades in over an entrance, holds, and then folds back
 * in the same order over a move, on the exit curve's shape.
 */
export function bloomPetalPose(
  i: number,
  t: number,
): { open: number; rotate: number; length: number; opacity: number } {
  'worklet';
  const since = t - CELEBRATION.bloom.stagger * i;
  const unfold = springStep(since / 1000, springs.reveal);
  const shown = Math.min(1, Math.max(0, since / CELEBRATION.bloom.enter));
  const faded = 1 - (1 - shown) * (1 - shown);
  const folding = Math.min(
    1,
    Math.max(
      0,
      (t -
        (CELEBRATION.fold.delay - CELEBRATION.bloom.delay) -
        CELEBRATION.fold.stagger * i) /
        CELEBRATION.fold.duration,
    ),
  );
  // The exit curve's shape, which the UI thread can take as arithmetic.
  const gone = folding * folding * folding;
  return {
    open: unfold * (1 - gone),
    rotate: petalAngle(i),
    length: PETAL_LENGTHS[i],
    opacity: faded * (1 - gone),
  };
}
