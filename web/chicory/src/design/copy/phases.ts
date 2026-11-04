/**
 * The shell phases: the lock, opening, closing and the ways back in.
 *
 * Outside their setup panels the phases draw a bloom, glyphs and data, so
 * these are spoken rather than shown: the labels, values and hints of the
 * glyphs that replaced the old sentences, and what the Whisper pill says.
 */
export const phase = {
  locked: 'Locked',
  unlock: 'Unlock',
  /** How the unlock control proves who is holding the phone. */
  unlockWith: (method: string) => `Unlocks with ${method}.`,
  lockRefused: 'Chicory stays locked until this is confirmed.',
  opening: 'Opening…',
  openingWallet: 'Opening your wallet…',
  closing: 'Closing your wallet…',
  switching: (network: string | null) =>
    `Closing this wallet and opening ${network || 'the selected network'}…`,
  erasing: 'Erasing your wallet from this computer…',
  saved: 'This wallet is still on this computer. It could not be opened just now.',
  openDevice: 'Open wallet',
  /** Said for a wallet whose name has not been read yet. */
  yourWallet: 'Your wallet',
  offline: 'Balances are unavailable until the connection is restored.',
  connecting: 'Connecting…',
  retryConnection: 'Retry connection',
  retrySetup: 'Retry wallet setup',
  retrySetupHint: 'Asks the wallet to run its Lightning setup again.',
  lockDevice: 'Stop wallet',
  createWallet: 'Create a wallet',
  restore: 'Restore from recovery phrase',
  networkSettings: 'Network settings',
  changeNetwork: 'Change network or Bitcoin server',
  hideNetwork: 'Hide network settings',
  showDiagnostics: 'Show diagnostics',
  hideDiagnostics: 'Hide diagnostics',
  deviceSettings: 'Device connection settings',
  back: 'Back',
  tryAgain: 'Try again',
  tagline: 'Bitcoin, with less to think about.',
  /** The cog on a phase that has a setup panel, and the close it turns into. */
  settings: 'Settings',
  close: 'Close',
  openWallet: (name: string) => `Open ${name}`,
  openWalletHint: 'Starts this wallet and opens it.',
  /** A wallet made from the network's defaults, on its way. */
  startingWallet: 'Opening wallet…',
  /** What the picker is for, with wallets to choose from and without. */
  chooseTitle: 'Choose your wallet.',
  createTitle: 'Create a wallet.',
  testNetwork: (network: string) =>
    `${network} is a test network. Its coins have no value.`,
  /**
   * The shield tile above a phase while a new wallet's recovery phrase is
   * still to be saved: what a tap on it does.
   */
  backupHint: 'Opens your recovery phrase to reveal and save it.',
};
