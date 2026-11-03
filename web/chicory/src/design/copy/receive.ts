import { number } from '../../theme';
import { sats } from './shared';

/** The fewest sats an offline receive can take. */
const OFFLINE_MIN = 354;

const offlineRange = (cap?: number) =>
  cap === undefined
    ? `Enter at least ${number(OFFLINE_MIN)} sats.`
    : `Enter ${number(OFFLINE_MIN)} to ${sats(cap)}.`;

/**
 * Receive: the amount, the quote, the request and what arrives for it, and
 * the request as a payment's detail keeps it. Phrases the suites grep are
 * kept verbatim from the screens that used to show them.
 */
export const receive = {
  // The form.
  continue: 'Continue',
  dismissRetry: 'Stop retrying this request',
  dismissRetryHint:
    'Return to ordinary Receive. Any reserved capacity stays held until the request is safely resolved.',
  enterAmount: 'Enter an amount for your payment request.',
  addNote: 'Add a note',
  note: 'Note · optional',
  noteHint: 'Dinner, a coffee, just because…',
  offline: 'Receive offline',
  offlineOnHint: (cap?: number) =>
    `Accept this payment even while this wallet is closed. Your primary node prepares it, so it has to offer offline settlement. ${offlineRange(
      cap,
    )}`,
  offlineOffHint:
    'Off, the request is paid over your channel or provisioned by your primary node just in time.',
  offlineRange,
  offlineOver: (cap: number) =>
    `An offline receive can take up to ${sats(cap)} right now.`,
  stale: 'Balance not confirmed recently. Refresh before creating a request.',
  providerCap: (cap: number) =>
    `Your primary node funds at most ${sats(
      cap,
    )} for one receive. Request less.`,

  // The quote.
  requested: (value: number) => `Requested, ${sats(value)}`,
  senderChooses: 'Requested, Sender chooses',
  fee: (value: number) => `Receive fee, ${sats(value)}`,
  net: (value: number) => `You receive, ${sats(value)}`,
  justInTime: 'Provisioned by your primary node just in time.',
  offlineOn:
    'Payable while this wallet is closed. Your primary node prepares it and settles the payment for you.',
  editAmount: 'Edit amount',
  create: 'Create request',
  refreshQuote: 'Refresh quote',
  quoteExpired: 'Quote expired. Review again.',

  // The request.
  qr: 'Payment request QR code',
  qrHint: 'Shows the code larger, so it is easier to scan.',
  closeQr: 'Close enlarged QR code',
  anyAmount: 'Any amount',
  yours: (amount: string) => `Your request, ${amount}`,
  unified: 'This request accepts Lightning and Bitcoin.',
  lightningOnly: 'This request accepts Lightning only.',
  offlineRequest:
    'You can close your wallet. Payments will appear when you reopen it.',
  expiresIn: (minutes: number) => `Request expires in ${minutes} minutes`,
  nearExpiry: 'This request expires soon.',
  share: 'Share request',
  copy: 'Copy request',
  copied: 'Request copied',
  createAnother: 'Create another request',
  requestRemaining: 'Request the remaining amount',
  viewActivity: 'View activity',
  expired:
    'This request has expired. Create a fresh request before asking someone to pay.',
  reused: 'Check Activity. The original request is saved in Activity.',
  reusedShare:
    'This address belongs to more than one request. Create a new request before sharing again.',

  // What arrives for it.
  detected: 'Payment detected.',
  confirming:
    'Waiting for confirmation. The sender does not need to pay again.',
  partial: 'Part of it is here.',
  partialSplit: (received: string, requested: string) =>
    `${received} received so far of ${requested} requested.`,
  partialSoFar: (received: string) => `${received} received so far.`,
  partialCheck: 'Less than requested. Check with the sender.',
  received: 'Payment received.',
  receivedSats: (received: string) => `${received} received.`,
  breakdown: (received: string, confirmed: string, confirming: string) =>
    `Received ${received}, confirmed ${confirmed}, confirming ${confirming}`,
  txConfirmed: 'Confirmed',
  txConfirming: 'Confirming',
  transaction: 'Transaction',

  // A request as a payment's detail keeps it.
  originalQr: 'Original payment request QR code',
  legacyInvoice: 'Lightning invoice',
  legacyQr: 'Lightning invoice QR code',
  legacy:
    'This older request saved only its Lightning invoice. Bitcoin receipts appear separately until the original request is linked.',
  reusedAddress:
    'This address was reused. Bitcoin payments cannot be matched to this request.',
  shareOriginal: 'Share original request',
  shareFailed: 'Could not share this request.',
  linkOriginal: 'Link original request',
  original: 'Original payment request',
  originalHint:
    'Paste the full original bitcoin: request, including its Lightning invoice. Chicory checks the invoice and wallet address. Without that original request, this link cannot be recovered.',
  paste: 'Paste from clipboard',
  link: 'Link request',
  cancelLink: 'Cancel linking',
  linkFailed: 'Could not link the original request.',
  linked: 'Original request linked. Its payment status is being refreshed.',

  // A value as a copy chip holds it (REDESIGN.md 5, CopyChip).
  copyValue: (label: string) => `Copy ${label.toLowerCase()}`,
  valueCopied: (label: string) =>
    `${label.charAt(0).toUpperCase()}${label.slice(1)} copied`,
};
