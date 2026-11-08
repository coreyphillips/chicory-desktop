import { sats } from './shared';

/**
 * Settings and the setup surfaces, which may keep short text on screen
 * (REDESIGN.md rule 2): Settings itself, the recovery phrase, the new wallet
 * sheet with restore entry, first-run network setup and diagnostics. Their
 * words are here whether they are shown or spoken, trimmed to what a person
 * needs to act, with every safety line kept whole.
 *
 * Phrases the suites look controls up by are kept verbatim, and a few that
 * another area also says (the picker's) are repeated here rather than shared.
 */
export const settings = {
  /** What a screen reader calls the Settings scene, and its title. */
  title: 'Settings',
  /** Said of a test network wherever one can be chosen. */
  testNetwork: (network: string) =>
    `${network} is a test network. Its coins have no value.`,

  /**
   * The card at the top of Settings: the wallet's name, its network and
   * whether its primary node answers. A screen reader hears it as one line.
   */
  card: {
    /** The card's first words to a screen reader. */
    summary: (name: string, network: string) => `${name}, ${network}.`,
    connected: 'Primary connected',
    connecting: 'Primary connecting',
    /** The card's status with several primaries: how many answer. */
    count: (connected: number, total: number) =>
      `${connected} of ${total} primaries connected`,
  },

  wallet: {
    heading: 'Wallet',
    /** A network is chosen but not yet switched to. */
    switchNote: (target: string) =>
      `${target} keeps its own wallet, balance and history.`,
    switchTo: (target: string) => `Switch to ${target}`,
    servers: 'Network & servers',
    serversLabel: 'Change network or Bitcoin server',
    /** The row inside Network & servers that opens the server editor. */
    editServers: 'Edit servers',
  },

  recovery: {
    heading: 'Recovery phrase',
    /** The heading while the phrase is still to be saved. */
    pending: 'Save your recovery phrase.',
    intro:
      'Write these words down in order and keep them somewhere private. Anyone with the phrase can take your funds.',
    reveal: 'Reveal recovery phrase',
    revealing: 'Waiting for confirmation',
    prompt: 'Confirm to reveal your recovery phrase',
    refused: 'The recovery phrase stays hidden until this is confirmed.',
    unavailable:
      'Recovery phrase is unavailable. Check your wallet backup before continuing.',
    unreadable: 'Could not read the phrase.',
    watchers:
      'Make sure nobody is looking over your shoulder or recording your screen.',
    channels:
      'Keep your wallet’s current channel state too. The recovery phrase alone does not restore active Lightning channels.',
    hide: 'Hide phrase',
    saved: 'I saved my recovery phrase',
    savedHint: 'Hold to confirm.',
    savedDone: 'Recovery phrase saved.',
    word: (position: number, word: string) => `${position}. ${word}`,
  },

  primary: {
    heading: 'Primary node',
    connected: 'Connected',
    connecting: 'Connecting',
    setup: 'Setup',
    /** No setup reported yet. */
    waiting: 'Waiting',
    /** Where the setup is, in words rather than the engine's own value. */
    setupPending: 'Setting up',
    setupReady: 'Ready',
    setupFailed: 'Failed',
    /** The Primary node row's value while setup has stopped short. */
    setupFailedValue: 'Setup failed',
    address: 'Node address',
    none: 'No primary configured',
    copy: 'Copy node address',
    copied: 'Node address copied',
    change: 'Change primary node',
    save: 'Save primary node',
    scan: 'Scan primary node QR',
    iroh: "Iroh is experimental. Your primary node and its relay can see your computer's IP address. Use this for a node you control. Onion connections require a configured local Tor service.",
    fallback: 'Optional Tor fallback URI',
    fallbackHint:
      'Use the onion address for the same node key. Lightning falls back to Tor if Iroh is slow or unavailable.',
    cancel: 'Cancel',
    keeps:
      'Existing channels and funds stay. The new node is trusted for instant funding.',
    retry: 'Retry connection',
    saving: 'Saving your primary node…',
    reconnecting: 'Reconnecting…',
    updated: 'Primary node updated. Existing channels remain available.',
    notReconnected:
      'Primary node saved. Your wallet has not reconnected to it yet; existing channels remain available.',
    retried: 'Connection setup requested. Your wallet will update shortly.',
  },

  /**
   * The Primary node row when the wallet ranks several primaries
   * (coreyphillips/beignet#1924): the list of nodes, each with how full it
   * is, the way to drag one up or down, to open one for its address and to
   * remove it, the fill target the list shares once there are two, and the
   * way to add another. The add form keeps the one-primary panel's control
   * names, which the suites look up.
   */
  primaries: {
    heading: 'Primary nodes',
    count: (connected: number, total: number) =>
      `${connected} of ${total} connected`,
    rank: (rank: number) => `Rank ${rank}`,
    /** The bolt beside the node the next receive goes to, and its words. */
    receiveTarget: 'Next receive goes here',
    /** What a full bar stands for, under a node's balance. */
    of: (amount: string) => `of ${amount}`,
    channelsLabel: 'Channels',
    channels: (count: number) =>
      count === 1 ? '1 channel' : `${count} channels`,
    noChannel: 'No channel yet',
    /** A screen reader's way to reorder, where a finger drags the grip. */
    moveUp: 'Move up',
    moveDown: 'Move down',
    showDetails: 'Shows the node address and more',
    hideDetails: 'Hides the node address',
    remove: 'Remove node',
    removeKeeps:
      'Its channels and funds stay in your wallet. New receives stop going to it.',
    confirmRemove: 'Remove this primary node',
    add: 'Add a primary node',
    addHint: 'The new node is ranked last. Drag it up to fill it sooner.',
    threshold: 'Fill target in sats',
    thresholdHint:
      'Receives fill each node to this amount, in rank order, before moving on to the next.',
    saveThreshold: 'Save fill target',
    retryAll: 'Retry connections',
    adding: 'Adding your primary node…',
    added: 'Primary node added.',
    addedNotConnected:
      'Primary node added. Your wallet has not connected to it yet.',
    removing: 'Removing the primary node…',
    removed: 'Primary node removed. Its channels and funds stay.',
    reordering: 'Saving the order…',
    reordered: 'Primary order saved.',
    savingThreshold: 'Saving the fill target…',
    thresholdSaved: 'Fill target saved.',
  },

  /** The group of what moves money out of this wallet, or this wallet away. */
  funds: { heading: 'Funds and exits' },

  /** The group of what helps read the wallet when something is wrong. */
  help: { heading: 'Help' },

  empty: {
    link: 'Empty wallet to an address',
    /** The row's value while a drain is under way. */
    underway: 'Emptying',
    /** The row's value while the wallet has not confirmed a drain started. */
    unknown: 'Status unknown',
    warning:
      'This closes your home channel and sends its balance and loose coins to one Bitcoin address. Your primary node must stay connected. Your next receive can open a new channel.',
    address: 'Bitcoin address',
    addressOnly: 'Enter a Bitcoin address for this wallet network.',
    noAmount: 'Use an address without a requested amount to empty this wallet.',
    scan: 'Scan address QR',
    paste: 'Paste address',
    pasted: 'Address pasted.',
    clipboardEmpty: 'The clipboard is empty.',
    clipboardUnreadable: 'Could not read the clipboard.',
    copy: 'Copy Bitcoin address',
    copied: 'Bitcoin address copied',
    review: 'Review before sending',
    arrives: 'Arrives',
    fees: 'Estimated network fees',
    estimate:
      'The final closing fee may change. Coins received after this review stay in your wallet.',
    send: 'Send everything',
    hold: 'Hold to close your channel and send the reviewed balance.',
    /** What the hold says it commits, its amounts heard in sats. */
    said: (arrives: string, fees: string) =>
      `Arrives ${arrives}. Estimated network fees ${fees}.`,
    keep: 'Keep my channel',
    keeping: 'Keeping your channel',
    pending:
      'Your wallet is emptying to this address. Follow the single send in Activity while it confirms. Your next receive can open a new channel.',
    cancelling:
      'Cancelling. The wallet is confirming that your channel stays open.',
    uncertain:
      'The wallet has not confirmed whether emptying started. Follow Activity before trying another send.',
    /** Said assertively as an unknown start shows (REDESIGN.md rule 4). */
    uncertainAnnouncement:
      'Emptying status unknown. Do not send again until this is resolved.',
    completed: 'Wallet emptied. Your next receive can open a new channel.',
    cancelled: 'Emptying cancelled. Your channel stays open.',
    /** The amount carries its unit: `₿100`, `100 sats` or `0.000001 BTC`. */
    residual: (amount: string) =>
      `${amount} received later remain in your wallet.`,
    failed: 'Could not prepare the review.',
  },

  phone: {
    heading: 'This computer',
    require: (name: string) => `Require ${name}`,
    requireLabel: (name: string) => `Require ${name} to open this wallet`,
    noLock: 'Lock your computer to protect access. App-specific biometric lock is not available.',
    lockFailed: 'Could not change the lock.',
    haptics: 'Haptics',
    hapticsFailed: 'Could not save the haptics setting.',
    /** Settings > Auto-pay (REDESIGN.md rule 5). */
    autoPay: 'Auto-pay',
    autoPayLabel: 'Pay scanned Lightning codes without holding',
    /** The slider under it while it is on. */
    autoPayLimit: 'Auto-pay limit',
    autoPayLimitHint:
      'Scanned codes up to this share of your balance pay without a hold.',
    autoPayShare: (share: number) => `${share}%`,
    /** Before the sats the share stands for today. */
    autoPayUpTo: 'Up to',
    /** In their place at 0%. */
    autoPayNothing: 'Every code waits for your hold',
    autoPayNote:
      'Scanned Lightning codes up to this share of your balance pay as soon as they are read. Anything more waits for your hold.',
    /** What a screen reader hears as the slider's value. */
    autoPaySpoken: (share: number, limitSats: number) =>
      share === 0
        ? '0%. Every code waits for your hold.'
        : `${share}% of your balance, up to ${sats(limitSats)}`,
    autoPayFailed: 'Could not save the auto-pay setting.',
  },

  diagnostics: {
    heading: 'Diagnostics',
    hint: 'Shows what the wallet reports about itself.',
    errors: 'Recent errors',
    report: 'Wallet report',
    loading: 'Reading the wallet report',
    unreadable: 'Could not read diagnostics.',
    refresh: 'Refresh',
    copy: 'Copy',
    copied: 'Diagnostics copied',
  },

  fullBackup: {
    link: 'Full backup to a file',
    warning:
      'Saves every wallet in this profile, with its channel state, to one file encrypted with a passphrase you choose. Anyone with the file and the passphrase can spend these funds, so keep them private and apart. Every payment or channel change after this makes the file older. A recovery phrase alone does not restore channels; this file does.',
    passphrase: 'Backup passphrase',
    passphraseHint: 'At least 12 characters. It cannot be recovered if you forget it.',
    repeat: 'Repeat the passphrase',
    mismatch: 'The passphrases do not match.',
    short: 'Use at least 12 characters.',
    save: 'Save full backup',
    saved: (file: string) => `Saved ${file}. Keep it offline, away from this computer.`,
    prompt: 'Confirm to save a full backup',
    unconfirmed: 'Nothing was saved because this was not confirmed.',
    failed: 'The full backup could not be saved.',
    restoreLink: 'Restore a full backup file instead',
    restoreNote:
      'A full backup brings back each wallet with its channel state. Its channels stay on hold until each peer shows their state is current, because a backup can be older than the channel. Keep the computer it came from offline while you restore.',
    choose: 'Choose backup file',
    restored: (count: number) => `Restored ${count === 1 ? 'one wallet' : `${count} wallets`}.`,
    partial: (names: string) => `These wallets were not restored: ${names}. Try again.`,
    nothing: 'Every wallet in this backup is already on this computer.',
    restoreFailed: 'The full backup could not be restored.',
  },

  erase: {
    link: 'Erase all wallets from this computer',
    warning:
      "Deletes every wallet in this Chicory profile from this computer, on every network: keys, channel state, history and saved app settings. It does not send or rescue funds. Without each wallet's recovery phrase and current channel state, funds are lost. The app lock setting is kept.",
    confirm: 'Erase all wallets',
    prompt: 'Confirm to erase all wallets',
    unconfirmed: 'Nothing was erased because this was not confirmed.',
    failed: 'Could not erase the wallets.',
    keep: 'Keep my wallets',
  },

  about: {
    app: (version: string) => `Chicory ${version}`,
    engine: (version: string) => `Engine ${version}`,
  },

  /** The saved wallets, for the picker. Only their names are shown. */
  picker: {
    choose: 'Choose your wallet.',
    empty: 'Create a wallet.',
    open: (name: string) => `Open ${name}`,
    openHint: 'Starts this wallet and opens it.',
    status: (network: string, status: string) => `${network}, ${status}`,
    create: 'Create a wallet',
    opening: 'Opening wallet…',
  },

  /** The new wallet sheet: create, restore, and the phrase to save. */
  create: {
    title: 'New wallet',
    restoreTitle: 'Restore a wallet',
    restoreNote:
      'A phrase restores keys and on-chain funds, not Lightning channel state.',
    phrase: 'Recovery phrase',
    phraseHint: '12 or 24 words, separated by spaces',
    words: 'Recovery phrase words',
    wordCount: (count: number) =>
      `${count} words so far. A phrase has 12 or 24.`,
    wordsReady: (count: number) => `${count} words.`,
    name: 'Wallet name',
    defaultName: 'Everyday wallet',
    network: 'Network',
    primary: 'Primary node',
    desktopPrimary: 'Use a reachable primary node. Onion nodes need a local Tor service configured before opening Chicory.',
    reuses: (source: string) =>
      `Uses the same recovery phrase as your ${source} wallet. You do not need to write it down again.`,
    separatePhrase: 'Make a separate wallet with a new phrase',
    mainnet:
      'This creates a real mainnet wallet. The primary node is trusted for instant funding.',
    testnet: 'Use a primary node on this test network.',
    server: 'Bitcoin server',
    deviceServer: 'Device setting',
    unreadableConfig: "Could not read this wallet's server settings.",
    create: (network: string) => `Create ${network} wallet`,
    restore: (network: string) => `Restore ${network} wallet`,
    toRestore: 'I already have a recovery phrase',
    toCreate: 'Create a new wallet instead',
    createFailed: 'Could not create the wallet.',
    restoreFailed: 'Could not restore the wallet.',
    openFailed: 'Could not open the wallet.',
    created: 'Wallet created.',
    sharedPhrase: (network: string, source: string) =>
      `Your ${network} wallet uses the same recovery phrase as your ${source} wallet. A phrase does not restore Lightning channel state.`,
    openNetwork: (network: string) => `Open ${network} wallet`,
    open: 'Open wallet',
  },

  /** The network editor, in Settings and at first run. */
  network: {
    title: 'Network settings',
    select: (network: string) => `Select ${network}`,
    reuses: (network: string, source: string) =>
      `A new ${network} wallet reuses the recovery phrase from your ${source} wallet. An existing ${network} wallet keeps its own phrase.`,
    server: 'Default Electrum server',
    serverHint: 'Server for this network',
    port: 'Default Electrum port',
    tls: 'TLS encryption',
    tlsLabel: 'Default Electrum TLS',
    primary: 'Default primary node',
    primaryHint: 'A node on this network',
    relay: 'Use a transport relay',
    relayLabel: 'Use transport relay',
    relayAddress: 'Relay address',
    relayToken: 'Relay token',
    save: 'Save network settings',
    use: (network: string) => `Use ${network}`,
    /** Beside the switch while it waits for a server, in the same words the switch refuses with. */
    needsServer: (network: string) => `Add an Electrum server for ${network}.`,
    loading: 'Loading saved network settings…',
    failed: 'Could not change networks.',
  },
};
