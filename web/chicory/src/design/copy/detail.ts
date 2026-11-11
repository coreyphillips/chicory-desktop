import { sats } from './shared';

/**
 * A payment's detail: what its ring says, the words its lines used to show
 * beside their values, and the values it can copy.
 */
export const detail = {
  copy: (label: string) => `Copy ${label.toLowerCase()}`,
  copied: (label: string) => `${label} copied`,
  // What the ring says, one sentence per outcome.
  completed: 'Completed',
  awaiting: 'Awaiting payment.',
  inProgress: 'In progress.',
  detected: 'Payment detected. Waiting for confirmation.',
  uncertain: 'Status unknown. Do not pay again until this is resolved.',
  expired: 'Request expired.',
  legacyExpired:
    'Invoice expired. Bitcoin payments appear separately until the original request is linked.',
  failed: 'Payment did not complete.',
  unavailable: 'Payment status unavailable. Last known result shown.',
  status: (word: string) => `Status, ${word}`,
  // The lines, each named for the label its value used to sit beside.
  amount: (value: number) => `Amount, ${sats(value)}`,
  amountHidden: 'Amount, amount hidden',
  date: (label: string) => `Date, ${label}`,
  fee: (value: number) => `Fee, ${sats(value)}`,
  estimatedFee: (value: number) => `Estimated fee, ${sats(value)}`,
  feeHidden: (estimated: boolean) =>
    `${estimated ? 'Estimated fee' : 'Fee'}, amount hidden`,
  feeUnavailable: 'Fee, Unavailable',
  note: (text: string) => `Note, ${text}`,
  addNote: 'Add a private note',
  editNote: 'Edit private note',
  privateNote: 'Private note',
  privateValue: (note: string) => `Private note, ${note}`,
  saveNote: 'Save private note',
  cancelNote: 'Cancel editing private note',
  noteSaved: 'Private note saved.',
  noteRemoved: 'Private note removed.',
  noteFailed: 'Could not save the private note. Your edit is still here.',
  // The values a chip copies.
  reference: 'Reference',
  transaction: 'Transaction',
  paymentHash: 'Payment hash',
  address: 'Address',
  // The request a legacy invoice can be linked back to.
  linked: 'Original request linked. Its payment status is being refreshed.',
  linkOriginal: 'Link original request',
  shareOriginal: 'Share original request',
  originalQr: 'Original payment request QR code',
  legacyQr: 'Lightning invoice QR code',
};
