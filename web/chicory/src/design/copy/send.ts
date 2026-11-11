import { sats } from './shared';

/** A fee rate as it is spoken: whole sats per virtual byte. */
const perVbyte = (rate: number) =>
  `${rate === 1 ? '1 sat' : `${rate} sats`} per virtual byte`;

/**
 * Send: the request, the review, the hold and the results. None of it is
 * drawn: it is what the glyphs, rings and lines say to a screen reader and
 * through Whisper.
 */
export const send = {
  request: 'Payment request or address',
  // The empty well's words, which it used to show as its placeholder.
  requestEmpty: 'Paste a request here',
  requestHint: 'Opens the request to change it.',
  paste: 'Paste from clipboard',
  pasted: 'Request pasted',
  clipboardEmpty: 'The clipboard is empty.',
  scan: 'Scan a payment request',
  review: 'Review payment',
  // Why the review waits: there is no request to review, the request
  // cannot be paid, or there is no amount yet.
  reviewWaits: 'Paste or scan a payment request first.',
  reviewRefused: 'This request cannot be paid. Paste or scan another.',
  amountWaits: 'Enter an amount first.',
  preparing: 'Preparing the payment.',
  /** Settings > Auto-pay sent a scanned code without a hold. */
  autoPaying: (value: number) => `Paying ${sats(value)} automatically.`,
  sendSats: (value: number) => `Send ${sats(value)}`,
  sendMax: 'Send everything you can',
  recipientAtLeast: (value: number) => `Recipient at least ${sats(value)}`,
  routingFeeAtMost: 'Routing fee at most',
  totalDebit: 'Total debit',
  payAllFacts: (recipient: number, fee: number, debit: number) =>
    `Recipient at least ${sats(recipient)}. Routing fee at most ${sats(
      fee,
    )}. Total debit ${sats(debit)}.`,
  maxKept: (value: number) =>
    `Everything you can send.${
      value > 0 ? ` ${sats(value)} stay in your channel.` : ''
    }`,
  holdHint: 'Hold to send.',
  quoteExpires: (seconds: number) => `Fee quote expires in ${seconds}s`,
  refreshQuote: 'Refresh quote',
  quoteExpired: 'Quote expired. Review again.',
  invoiceExpired: 'Invoice expired. Ask for a new one.',
  wrongNetwork:
    'Different Bitcoin network. Ask for a request on this wallet’s network.',
  edit: 'Edit payment',
  stale: 'Balance not confirmed recently. Refresh before sending.',
  // The review's lines: the rail, the fee on top, what it should cost, and
  // the most it can.
  lightning: 'Lightning',
  bitcoin: 'Bitcoin',
  directFunding: 'Direct funding',
  fee: 'Fee',
  expectedFee: 'Expected routing fee',
  about: (value: number) => `about ${sats(value)}`,
  totalAtMost: 'Total, at most',
  totalWithFee: 'Total including fee',
  // The fee rate slider under a Bitcoin review's sum: nothing on it is
  // drawn, the fee line is its readout, and these are its words.
  feeRate: 'Network fee rate',
  feeRateHint: 'A higher rate confirms sooner and costs more.',
  feeRateFixed: 'The fee rate cannot change now.',
  /** Its value: where the rate stands against the engine's estimates, the rate, and the fee it gives. */
  feeRateValue: (rate: number, fee: number, zone: string) =>
    `${zone}, ${perVbyte(rate)}, fee ${sats(fee)}`,
  feeZones: {
    belowSlow: 'Below the slow estimate',
    slow: 'Slow',
    betweenSlowAndNormal: 'Between slow and normal',
    normal: 'Normal',
    betweenNormalAndFast: 'Between normal and fast',
    fast: 'Fast',
    aboveFast: 'Above the fast estimate',
  },
  /** Said once the engine has priced a chosen rate. */
  feeRateAt: (rate: number, fee: number) =>
    `Fee ${sats(fee)} at ${perVbyte(rate)}.`,
  // Results.
  sent: 'Sent.',
  onItsWay: 'Payment on its way.',
  // A payment to a Bitcoin address the engine has taken, whose transaction
  // is still being put together and broadcast.
  broadcasting: 'Sending to Bitcoin.',
  // A payment broadcast on chain: the payer's part is done, and the
  // history follows it to its confirmation.
  confirming: 'Sent. Confirming on Bitcoin.',
  // A payment the engine took that the history then shows did not go out:
  // the engine's own answer said it was submitted, so it is not repeated.
  notSent: 'The payment did not go out. Check Activity.',
  unknown: 'Result unknown.',
  failed: 'Payment failed.',
  retry: 'Returns to the payment, with the request kept.',
  checkActivity: 'Check Activity before paying this request again.',
  held: 'This request has a payment whose outcome is not known yet. It cannot be paid again until that resolves.',
  heldAnnouncement:
    'Payment status unknown. Do not pay again until this is resolved.',
  // A request whose payment completed, entered again.
  paidAlready: 'Already paid.',
  paid: 'This request has been paid. It cannot be paid again.',
  showPayment: 'Shows the payment in Activity.',
  feePaid: 'Fee paid',
  reviewedFee: 'Reviewed fee',
  feeUnavailable: 'Unavailable',
  reference: 'Reference',
  viewActivity: 'View activity',
};

/**
 * The amount keypad's contract (REDESIGN.md 10.3), which the suites drive
 * through test-support/keypad.ts. The container is labelled `label`, each
 * digit key with its digit alone, and backspace with `backspace`. The amount
 * it enters stays labelled `amount.field` and reads its digits from
 * `accessibilityValue.text`.
 *
 * The keypad's words live here, with the send track that owns the keypad;
 * the copy index also serves them as `amount.backspace` and
 * `amount.backspaceHint`.
 */
export const keypad = {
  label: 'Amount keypad',
  digits: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  backspace: 'Delete last digit',
  backspaceHint: 'Hold to clear the amount.',
  /** Backspace's hold, as the action a screen reader lists. */
  clear: 'Clear the amount',
  /** Said as a key past the most digits an amount holds is refused. */
  refused: 'An amount has at most 16 digits.',
};
