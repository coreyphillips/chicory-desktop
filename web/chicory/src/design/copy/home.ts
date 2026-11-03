import { amountIn } from '../../theme';
import type { Unit } from '../../theme';
import { sats } from './shared';

/** Home: the balance, the actions under it and the status row. */
export const home = {
  totalBalance: (value: number, unit: Unit) => {
    const amount = amountIn(value, unit);
    return `Total balance ${amount.value} ${amount.suffix}`;
  },
  balanceHidden: 'Balance hidden',
  unitHint: 'Switches between satoshis, the bitcoin sign and BTC.',
  hideHint: 'Masks every amount on screen.',
  showBalance: 'Show balance',
  hideBalance: 'Hide balance',
  switchUnit: 'Switch unit',
  /**
   * What the vessel says: nothing about arriving when nothing is, and money
   * out of reach only when a reserve cannot explain it.
   */
  split: (available: number, arriving: number, unreachable = 0) =>
    [
      `${sats(available)} ready to send`,
      arriving > 0 ? `${sats(arriving)} arriving` : '',
      unreachable > 0 ? `${sats(unreachable)} out of reach` : '',
    ]
      .filter(Boolean)
      .join(', '),
  /**
   * Why part of the balance cannot be sent, which the vessel's value says
   * and its unplug whispers. Figures are left to the label.
   */
  outOfReach:
    'Part of the balance is in a channel that is not connected right now. It can be sent once the channel reconnects.',
  /**
   * Part of the balance cannot be sent with the primary connected: a
   * channel's reserve, or a channel with another peer. The totals do not
   * say which, so neither is claimed.
   */
  heldBack:
    'Part of the balance cannot be sent right now. A channel keeps some in reserve, and a channel with another node needs that node online.',
  send: 'Send',
  sendHint: 'Paste or scan a payment request.',
  receive: 'Receive',
  receiveHint: 'Creates a request others can pay.',
  scan: 'Scan a payment request',
  scanHint: 'Opens the camera to read a QR code.',
  settings: 'Settings',
  close: 'Close',
  activity: 'Activity',
  refresh: 'Refresh wallet',
  /** The shield tile, which leads to the recovery phrase in Settings. */
  backupHint: 'Opens Settings to reveal and save it.',
  /**
   * Why the vessel's money waits, in words, after the engine's own notes on
   * the wallet's funding. Figures are left to the vessel's label.
   */
  vesselWait: {
    arriving: 'On its way.',
    belowFloor:
      'Below the channel floor. It moves into the channel once more arrives.',
    moving: 'Moving into the channel now.',
    feeWait: 'Waiting for a lower network fee to move it into the channel.',
    failed: 'Moving it into the channel failed. Retrying.',
    confirming: 'It moves into the channel once the current transfer confirms.',
    conflicted:
      "A payer's funding was spent elsewhere. Your balance is being restored. Nothing of yours is lost.",
    reverted:
      "Your balance was restored after a payer's funding was spent elsewhere. Nothing of yours was lost.",
    unpaired: "Moving. A payer's transfer locks after three confirmations.",
  },
};

/** How the wallet is doing, which the status row and the mark carry. */
export const health = {
  fresh: 'Connected.',
  reconnecting: 'Reconnecting to your wallet.',
  refreshFailed: 'The last refresh did not complete.',
  /**
   * What the refresh notice above Home used to say, word for word. The mark
   * speaks it now, and a long press on the mark shows it.
   */
  refreshFailedDetail: (error: string) =>
    `Could not refresh. Showing the last known state. ${error}`,
  stale: 'Balance not confirmed recently.',
  staleAction: 'Balance not confirmed recently. Refreshing now.',
  cached: 'Showing the last saved balance until the wallet answers.',
  setupPending: 'Lightning setup is in progress.',
  setupReady: 'Lightning is ready.',
  setupFailed: 'Lightning setup did not finish. Retry it in Settings.',
  testNetwork: (network: string) =>
    `${network} is a test network. Its coins have no value.`,
  backupPending: 'Save your recovery phrase.',
};
