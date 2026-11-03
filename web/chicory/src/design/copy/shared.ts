import { number } from '../../theme';

/**
 * The words more than one area speaks: how an amount is read out, what a
 * scene is called, and the one notice still written on screen, in Settings.
 *
 * Amounts are always spoken in sats, whatever unit is on screen, except where
 * the unit is part of what is being read out.
 */
export const sats = (value: number) => `${number(value)} sats`;

/** What a screen reader calls a scene, where a title bar used to say it. */
export const scene = {
  send: 'Send',
  receive: 'Receive',
  detail: 'Payment details',
  create: 'New wallet',
  backup: 'Recovery phrase',
};

export const amount = {
  /** How any amount is read out, whatever unit is on screen. */
  spoken: (value: number) => sats(value),
  hidden: 'Amount hidden',
  field: 'Amount in sats',
  preset: (value: number) => number(value),
  any: 'Any amount',
  required: 'Amount required',
  fixed: 'Set by the payment request.',
  overSpendable: 'More than can be sent right now. The rest is still arriving.',
  overTotal: 'More than this wallet holds.',
  overOfflineCap: (cap: number) =>
    `Offline requests are limited to ${sats(cap)}.`,
};

/**
 * Words still shown on screen: a failed refresh, which Settings writes at
 * its head. Elsewhere the status row's mark carries it as its value.
 */
export const notice = {
  refreshFailed: (error: string) =>
    `Could not refresh. Showing the last known state. ${error}`,
};
