import { parsePayment } from '@beignet/wallet-core';
import type { SendReview } from '@beignet/wallet-core';

/**
 * Settings > Auto-pay, decided (REDESIGN.md rule 5). A code read by the
 * camera pays as soon as it is priced, with no hold, only when every one of
 * these holds; anything else waits for the hold, as every payment did
 * before. What it never decides is whether a request may be paid at all:
 * `pay` keeps every guard it has, the held set among them, so a code is
 * never paid twice however it arrives.
 */

/**
 * The one warning a scanned code may carry and still pay itself: it arrived
 * in capitals, as invoice QR codes usually do, and was read back in lower
 * case. It says how the code was printed, not anything about the payment.
 */
const SCANNED_SHAPE = new Set(['CASE_FOLDED_FROM_QR']);

function parsed(request: string) {
  try {
    return parsePayment(request.trim());
  } catch {
    return null;
  }
}

/**
 * A request auto-pay may prepare on its own: a Lightning invoice that names
 * its amount, bare or inside a Bitcoin link. An offer is never quoted, an
 * open amount needs the payer's keypad, and an address goes on chain, which
 * keeps the hold.
 */
export function autoPayCandidate(request: string): boolean {
  const payment = parsed(request);
  if (!payment) return false;
  const invoice =
    payment.kind === 'bolt11'
      ? payment
      : payment.kind === 'onchain' && payment.lightning?.kind === 'bolt11'
      ? payment.lightning
      : null;
  if (!invoice) return false;
  // A Bitcoin link naming another amount than its invoice is refused by the
  // engine, so it is left to the review to say so.
  if (
    payment.kind === 'onchain' &&
    typeof payment.amountSats === 'number' &&
    payment.amountSats !== invoice.amountSats
  ) {
    return false;
  }
  return typeof invoice.amountSats === 'number' && invoice.amountSats > 0;
}

/** The most a scanned code may cost and still pay itself, in sats. */
export function autoPayLimit(availableSats: number, share: number): number {
  if (!Number.isFinite(availableSats) || availableSats <= 0) return 0;
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.floor((availableSats * Math.min(share, 100)) / 100);
}

/** The words of the warnings the code's own shape explains, as a review says them. */
function shapeWords(request: string): Set<string> {
  const payment = parsed(request);
  const warnings =
    payment && 'warnings' in payment && Array.isArray(payment.warnings)
      ? payment.warnings
      : [];
  return new Set(
    warnings
      .filter(warning => SCANNED_SHAPE.has(warning.code))
      .map(warning => warning.message),
  );
}

/**
 * Whether a priced review pays itself: on Lightning, by the plain route,
 * not a pay-all, its whole debit (the amount and the fee cap) within the
 * share of what can be sent, and with nothing the engine warns about but
 * the code's capitals.
 */
export function autoPays({
  review,
  request,
  availableSats,
  share,
}: {
  review: SendReview;
  request: string;
  availableSats: number;
  share: number;
}): boolean {
  if (review.route !== 'lightning' || review.method || review.max) {
    return false;
  }
  const limit = autoPayLimit(availableSats, share);
  if (limit <= 0) return false;
  if (!Number.isFinite(review.totalSats) || review.totalSats <= 0) return false;
  if (review.totalSats > limit) return false;
  if (review.warnings.length === 0) return true;
  const explained = shapeWords(request);
  return review.warnings.every(warning => explained.has(warning));
}
