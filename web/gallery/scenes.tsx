/**
 * The wallet's surfaces on the app's own stage: Home in every health state,
 * Activity with every kind of payment in every status, each payment's
 * detail, Settings, and the shell phases around the wallet, each built
 * from the shared fixtures and drawn over the gallery's session.
 */
import type { WalletSnapshot } from '@beignet/wallet-core';
import type { WalletAdapter } from '../chicory/src/services/wallet';
import type { AutoPay } from '../chicory/src/services/autoPayPreference';
import { copy } from '../chicory/src/design/copy';
import type { Phase } from '../chicory/src/stage/phase';
import type { StageAction } from '../chicory/src/stage/scene';
import {
  activityOf,
  everyActivity,
  hex,
  primaryOf,
  requestOf,
  walletOf,
} from './fixtures';
import {
  ADDRESS,
  clientOf,
  configOf,
  decided,
  drainActivityOf,
  fresh,
  never,
  onMainnet,
  sessionOf,
  stale,
} from './fakes';
import type { Session } from './fakes';
import { setBiometry } from './sealed';
import { press, wait } from './shots';
import type { Shot, Step } from './shots';
import {
  hideBalance,
  inBtc,
  inSats,
  open,
  remembered,
  staged,
  wallet,
} from './staged';

const backupToSave = {
  rememberedSession: remembered('mainnet', { backupPending: true }),
};

// Home.

const homes: Shot[] = [
  wallet('home'),
  wallet('home on a test network', () => ({ snapshot: fresh() })),
  wallet('home, reconnecting', () => ({
    snapshot: onMainnet({ primary: { connected: false } }),
  })),
  wallet('home, stale', () => ({ snapshot: stale(onMainnet()) })),
  wallet('home, a cached launch', () => ({
    snapshot: stale(onMainnet()),
    session: { connecting: true },
  })),
  wallet('home, refreshing', () => ({ session: { refreshing: true } })),
  wallet('home, setup under way', () => ({
    snapshot: onMainnet({ primary: { setup: 'pending' } }),
  })),
  wallet('home, setup failed', () => ({
    snapshot: onMainnet({
      primary: {
        setup: 'failed',
        setupError: 'Liquidity provider is unavailable.',
      },
    }),
  })),
  wallet('home, a refresh failed', () => ({
    session: { error: 'Electrum is offline.' },
  })),
  wallet('home, a backup to save', () => ({ session: backupToSave })),
  wallet('home, hidden', () => ({ steps: [hideBalance] })),
  wallet('home in sats', () => ({ steps: inSats })),
  wallet('home in sats, hidden', () => ({ steps: [...inSats, hideBalance] })),
  wallet('home in sats, stale', () => ({
    snapshot: stale(onMainnet()),
    steps: inSats,
  })),
  wallet('home in BTC', () => ({ steps: inBtc })),
  wallet('home, a payment held', () => ({
    snapshot: onMainnet({ activity: [activityOf('sent', 'uncertain')] }),
  })),
  wallet('home, an offline request open', () => ({
    snapshot: onMainnet({
      activity: [
        activityOf('request', 'pending', {
          receiveRequest: requestOf({ offlineReceive: true }),
        }),
      ],
    }),
  })),
  wallet('home, empty', () => ({
    snapshot: onMainnet({
      balance: { totalSats: 0, availableSats: 0, pendingSats: 0 },
    }),
  })),
  wallet('home, everything spendable', () => ({
    snapshot: onMainnet({ balance: { totalSats: 250_000, pendingSats: 0 } }),
  })),
  // A channel whose peer is away holds most of the balance, as after a
  // switch of primary node before the old one reconnects. The primary is
  // connected, so the vessel holds the share back without naming why.
  wallet('home, part of the balance out of reach', () => ({
    snapshot: onMainnet({
      balance: { totalSats: 123_963, availableSats: 28_929, pendingSats: 0 },
    }),
  })),
  wallet('home, a channel reserve, which is not out of reach', () => ({
    snapshot: onMainnet({
      balance: { totalSats: 88_488, availableSats: 87_504, pendingSats: 0 },
    }),
  })),
  wallet('home, below the channel floor', () => ({
    snapshot: onMainnet({ lfbw: decided('wait', 'below-floor') }),
  })),
  wallet('home, a failed move', () => ({
    snapshot: onMainnet({ lfbw: decided('failed') }),
  })),
  wallet('home, money arriving', () => ({
    later: [
      onMainnet({
        balance: { totalSats: 265_700, availableSats: 254_200 },
        activity: [activityOf('received', 'completed')],
      }),
    ],
  })),
  wallet('home, money moving into the channel', () => ({
    snapshot: onMainnet({ lfbw: decided('splice-in') }),
    later: [
      onMainnet({
        balance: { availableSats: 257_500, pendingSats: 4_000 },
        lfbw: decided('splice-in'),
      }),
    ],
  })),
];

// Activity.

const rows = () => Object.values(everyActivity());

const activities: Shot[] = [
  wallet('activity, every payment', () => ({
    snapshot: fresh({ activity: rows() }),
    open: [open.activity()],
  })),
  wallet('activity, every payment on mainnet', () => ({
    snapshot: onMainnet({ activity: rows() }),
    open: [open.activity()],
  })),
  wallet('activity, hidden', () => ({
    snapshot: onMainnet({ activity: rows() }),
    open: [open.activity()],
    steps: [hideBalance],
  })),
  wallet('activity in sats', () => ({
    snapshot: onMainnet({ activity: rows() }),
    open: [open.activity()],
    steps: inSats,
  })),
  wallet('activity in BTC', () => ({
    snapshot: onMainnet({ activity: rows() }),
    open: [open.activity()],
    steps: inBtc,
  })),
  wallet('activity, filtered to requests', () => ({
    snapshot: onMainnet({ activity: rows() }),
    open: [open.activity()],
    steps: [drive => drive.call('onFilter', 'Requests')],
  })),
  wallet('activity, searched', () => ({
    snapshot: onMainnet({ activity: rows() }),
    open: [open.activity()],
    steps: [drive => drive.call('onQuery', 'Sam')],
  })),
  wallet('activity, a backup to save pinned first', () => ({
    snapshot: onMainnet({ activity: rows() }),
    session: backupToSave,
    open: [open.activity()],
  })),
  wallet('activity, empty', () => ({ open: [open.activity()] })),
];

// Each payment's detail.

/**
 * The detail of the payment the fixtures call `name`, over a history of that
 * payment alone, as the detail guard draws it: the card is the state, and a
 * full list under every one of them would only slow the suite that runs it.
 */
function detail(
  label: string,
  name: string,
  { test = false, steps = [] }: { test?: boolean; steps?: Step[] } = {},
): Shot {
  return wallet(label, () => {
    const activity = [everyActivity()[name]];
    const snapshot = test ? fresh({ activity }) : onMainnet({ activity });
    return { snapshot, open: [open.detail(snapshot.activity[0])], steps };
  });
}

const details: Shot[] = [
  ...Object.keys(everyActivity()).map(name => detail(`detail, ${name}`, name)),
  detail('detail on a test network', 'received with a note', { test: true }),
  detail('detail, hidden', 'sent completed', { steps: [hideBalance] }),
  detail('detail in sats', 'sent with an estimated fee', { steps: inSats }),
  detail('detail in sats, received', 'received completed', { steps: inSats }),
  detail('detail in sats, a request paid', 'request paid', { steps: inSats }),
  detail('detail in BTC', 'sent with an estimated fee', { steps: inBtc }),
];

// Settings.

const settings = (
  name: string,
  make: () => {
    snapshot?: WalletSnapshot;
    /** Later reads of the wallet, one a step, as polls bring them. */
    later?: WalletSnapshot[];
    session?: Partial<Session>;
    /** Calls the wallet answers its own way in this state. */
    client?: Partial<WalletAdapter>;
    steps?: Step[];
    /** Settings > Auto-pay; off if unset. */
    autoPay?: AutoPay;
  } = () => ({}),
) =>
  wallet(`settings${name ? `, ${name}` : ''}`, () => ({
    snapshot: fresh(),
    ...make(),
    open: [open.settings()],
  }));

const words = copy.settings;

const settingsShots: Shot[] = [
  settings(''),
  settings('on mainnet', () => ({ snapshot: onMainnet() })),
  settings('a backup to save', () => ({
    session: {
      rememberedSession: remembered('regtest', { backupPending: true }),
    },
  })),
  // While the engine starts: the card's bloom ratchets and the primary
  // node is sought.
  settings('while the engine starts', () => ({
    session: { connecting: true },
  })),
  // A row's content is drawn only while it is open, so each state below
  // opens its row first, as a person does.
  settings('showing the phrase', () => ({
    steps: [press(words.recovery.heading), press(words.recovery.reveal)],
  })),
  settings('proposing another network', () => ({
    steps: [press(words.wallet.serversLabel), press('mainnet')],
  })),
  settings('with the network editor open', () => ({
    steps: [press(words.wallet.serversLabel), press(words.wallet.editServers)],
  })),
  settings('emptying to an address', () => ({
    snapshot: onMainnet(),
    steps: [press(words.empty.link)],
  })),
  settings('reviewing a wallet drain', () => ({
    snapshot: onMainnet(),
    steps: [
      press(words.empty.link),
      drive => drive.type(words.empty.address, ADDRESS),
      press(words.empty.review),
    ],
  })),
  settings('wallet drain pending', () => ({
    snapshot: onMainnet(),
    steps: [
      press(words.empty.link),
      drive => drive.type(words.empty.address, ADDRESS),
      press(words.empty.review),
      drive => drive.activate(words.empty.send),
    ],
  })),
  // The hold has committed and the send has not answered: the hold turns
  // to its orbit and the review's figures have faded back.
  settings('wallet drain sending', () => ({
    snapshot: onMainnet(),
    client: { send: () => never() },
    steps: [
      press(words.empty.link),
      drive => drive.type(words.empty.address, ADDRESS),
      press(words.empty.review),
      drive => drive.activate(words.empty.send),
    ],
  })),
  settings('reviewing a wallet drain in sats', () => ({
    snapshot: onMainnet(),
    steps: [
      ...inSats,
      press(words.empty.link),
      drive => drive.type(words.empty.address, ADDRESS),
      press(words.empty.review),
    ],
  })),
  settings('wallet drain, status unknown', () => ({
    snapshot: onMainnet({ activity: [drainActivityOf('review')] }),
  })),
  settings('wallet drain cancelling', () => ({
    snapshot: onMainnet({ activity: [drainActivityOf('cancelling')] }),
  })),
  // Seen to complete while it is shown, with a little that came in since.
  settings('wallet drain completed', () => ({
    snapshot: onMainnet({ activity: [drainActivityOf('pending')] }),
    later: [
      onMainnet({
        activity: [
          drainActivityOf('completed', { revision: 4, residualSats: 1_200 }),
        ],
      }),
    ],
  })),
  settings('the primary node open', () => ({
    steps: [press(words.primary.heading)],
  })),
  // Several ranked primaries (coreyphillips/beignet#1924): the row lists
  // them when the engine ranks primaries.
  settings('the primary nodes open', () => ({
    snapshot: onMainnet({
      primaries: [
        primaryOf(1),
        primaryOf(2, { connected: false, isReceiveTarget: false }),
        primaryOf(3, { isReceiveTarget: false, channelCount: 0, balanceSat: 0 }),
      ],
      primariesThresholdSat: 250_000,
    }),
    client: clientOf({
      getConfig: async () => configOf({ primariesAvailable: true, drainAvailable: true }),
    }),
    steps: [press(words.primaries.heading)],
  })),
  settings('adding a primary node', () => ({
    snapshot: onMainnet({ primaries: [primaryOf(1), primaryOf(2, { isReceiveTarget: false })] }),
    client: clientOf({
      getConfig: async () => configOf({ primariesAvailable: true, drainAvailable: true }),
    }),
    steps: [press(words.primaries.heading), press(words.primaries.add)],
  })),
  settings('changing the primary node', () => ({
    steps: [press(words.primary.heading), press(words.primary.change)],
  })),
  settings('having saved the primary node', () => ({
    steps: [
      press(words.primary.heading),
      press(words.primary.change),
      press(words.primary.save),
    ],
  })),
  settings('with a primary node still setting up', () => ({
    snapshot: fresh({ primary: { connected: false, setup: 'pending' } }),
    steps: [press(words.primary.heading)],
  })),
  settings('with a primary node that failed setup', () => ({
    snapshot: fresh({
      primary: {
        connected: false,
        setup: 'failed',
        setupError: 'Liquidity provider is unavailable.',
      },
    }),
    steps: [press(words.primary.heading)],
  })),
  // A host as long as a v3 onion's is wider than the card at any text size:
  // the copy control drops below the address, which shrinks to keep the host
  // whole (`copyFit`), as a shorter one does at the largest text size.
  settings('with a primary node on an onion host', () => ({
    snapshot: fresh({
      primary: { uri: `02${hex(7, 64)}@${hex(8, 56)}.onion:9735` },
    }),
    steps: [press(words.primary.heading)],
  })),
  settings('offering an app lock', () => {
    setBiometry('FaceID');
    return {};
  }),
  settings('with diagnostics open', () => ({
    steps: [press(words.diagnostics.heading)],
  })),
  // Auto-pay: off, as it starts; switched on, the limit opening with the
  // thumb growing out to 50%; and switched on again where it was left, at
  // 80%, once the thumb has landed.
  settings('auto-pay off'),
  settings('auto-pay switched on', () => ({
    steps: [
      drive => drive.fire(words.phone.autoPayLabel, 'onValueChange', true),
    ],
  })),
  settings('auto-pay limit at 80%', () => ({
    autoPay: { on: false, share: 80 },
    steps: [
      drive => drive.fire(words.phone.autoPayLabel, 'onValueChange', true),
      wait(1_200),
    ],
  })),
  settings('confirming an erase', () => ({
    steps: [press(words.erase.link)],
  })),
];

// The shell phases.

const everyday = walletOf();
const savings = walletOf({
  id: 'savings',
  name: 'Savings',
  network: 'mainnet',
});

interface Shell {
  phase: Phase;
  session?: Partial<Session>;
  /** The wallet as read, for a phase that has one; none if unset. */
  snapshot?: WalletSnapshot | null;
  open?: StageAction[];
  steps?: Step[];
}

/** A shell phase over the gallery's session, with no wallet open unless set. */
function shell(name: string, make: () => Shell): Shot {
  return {
    name,
    make: () => {
      const state = make();
      const session = sessionOf(state.snapshot ?? null, state.session);
      return staged([{ phase: state.phase, session }], state.open, state.steps);
    },
  };
}

/** One phase then the next, as the app moves from one to the other. */
function passage(name: string, from: Phase, over: Partial<Session> = {}): Shot {
  return {
    name,
    make: () => {
      const snapshot = onMainnet();
      const before = sessionOf(snapshot, { ...over, snapshot: null });
      const after = sessionOf(snapshot);
      return staged([
        { phase: from, session: before },
        { phase: { kind: 'wallet', error: '' }, session: after },
      ]);
    },
  };
}

const LOCKED: Phase = { kind: 'locked', prompting: false, error: '' };
const DOWN = 'Electrum is offline.';
const OFFLINE: Phase = { kind: 'offline', error: DOWN };
const LOADING: Phase = { kind: 'loading' };
const PICKER: Phase = { kind: 'picker', error: '' };
const SAVED: Phase = { kind: 'saved', error: '' };
const WELCOME: Phase = {
  kind: 'welcome',
  opening: false,
  device: false,
  error: '',
};
const noClient = { client: null };
const picking = { walletId: '', wallets: [everyday, savings] };

const locks: Shot[] = [
  shell('lock, waiting', () => ({ phase: LOCKED })),
  shell('lock, prompting', () => ({ phase: { ...LOCKED, prompting: true } })),
  shell('lock, refused', () => ({
    phase: { ...LOCKED, error: copy.phase.lockRefused },
  })),
  ...(
    [
      ['Face ID', 'FaceID'],
      ['a fingerprint', 'TouchID'],
      ['iris recognition', 'Iris'],
    ] as const
  ).map(([name, kind]) =>
    shell(`lock with ${name}`, () => {
      setBiometry(kind);
      return { phase: LOCKED };
    }),
  ),
];

const phases: Shot[] = [
  ...locks,
  shell('transit, closing', () => ({
    phase: { kind: 'transit', why: 'closing', target: null },
    session: { closing: true },
  })),
  shell('transit, switching to mainnet', () => ({
    phase: { kind: 'transit', why: 'switching', target: 'mainnet' },
    session: { switching: true, switchTarget: 'mainnet' },
  })),
  shell('transit, erasing', () => ({
    phase: { kind: 'transit', why: 'erasing', target: null },
    session: { closing: true, erasing: true },
  })),
  shell('opening', () => ({
    phase: { kind: 'opening' },
    session: { ...noClient, initializing: true },
  })),
  shell('saved', () => ({ phase: SAVED, session: noClient })),
  shell('saved, open failed', () => ({
    phase: { ...SAVED, error: DOWN },
    session: { ...noClient, error: DOWN },
  })),
  shell('saved, opening', () => ({
    phase: SAVED,
    session: { ...noClient, connecting: true },
  })),
  shell('saved, network editor', () => ({
    phase: SAVED,
    session: { ...noClient, networkEditor: true },
  })),
  shell('welcome, first run', () => ({
    phase: WELCOME,
    session: { ...noClient, deviceHint: false, rememberedSession: null },
  })),
  shell('welcome, after a lock', () => ({
    phase: WELCOME,
    session: {
      ...noClient,
      rememberedSession: remembered('regtest', { locked: true }),
    },
  })),
  shell('welcome, opening', () => ({
    phase: { ...WELCOME, opening: true },
    session: { ...noClient, connecting: true, rememberedSession: null },
  })),
  shell('welcome, open failed', () => ({
    phase: { ...WELCOME, error: DOWN },
    session: { ...noClient, error: DOWN, rememberedSession: null },
  })),
  shell('welcome, device setup', () => ({
    phase: { ...WELCOME, device: true },
    session: { ...noClient, deviceVisible: true, rememberedSession: null },
  })),
  shell('picker', () => ({ phase: PICKER, session: picking })),
  shell('picker, empty', () => ({
    phase: PICKER,
    session: { ...picking, wallets: [] },
  })),
  shell('picker, creating', () => ({
    phase: PICKER,
    session: { ...picking, wallets: [], selecting: true },
  })),
  shell('picker, failed', () => ({
    phase: { ...PICKER, error: 'Add a primary node for regtest.' },
    session: {
      ...picking,
      wallets: [],
      error: 'Add a primary node for regtest.',
      switchError: 'The Electrum server did not answer.',
    },
  })),
  shell('picker, network editor', () => ({
    phase: PICKER,
    session: { ...picking, networkEditor: true },
  })),
  shell('picker, a new wallet sheet', () => ({
    phase: PICKER,
    session: picking,
    open: [{ type: 'overlay', overlay: { name: 'create', restoring: false } }],
  })),
  shell('picker, restoring a wallet', () => ({
    phase: PICKER,
    session: picking,
    open: [{ type: 'overlay', overlay: { name: 'create', restoring: true } }],
  })),
  shell('loading', () => ({ phase: LOADING })),
  shell('loading, busy', () => ({
    phase: LOADING,
    session: { connecting: true },
  })),
  shell('loading, a backup to save', () => ({
    phase: LOADING,
    session: {
      rememberedSession: remembered('regtest', { backupPending: true }),
    },
  })),
  shell('loading, the backup opened', () => ({
    phase: LOADING,
    session: {
      rememberedSession: remembered('regtest', { backupPending: true }),
    },
    steps: [press(copy.health.backupPending)],
  })),
  shell('offline', () => ({ phase: OFFLINE, session: { error: DOWN } })),
  shell('offline, connecting', () => ({ phase: { ...OFFLINE, error: '' } })),
  shell('offline, setup failed', () => ({
    phase: OFFLINE,
    session: {
      error: DOWN,
      wallets: [
        walletOf({
          lfbw: {
            enabled: true,
            mode: 'internal',
            setup: 'failed',
            setupError: 'Liquidity provider is unavailable.',
          },
        }),
      ],
    },
  })),
  shell('offline, retrying', () => ({
    phase: OFFLINE,
    session: { error: DOWN, refreshing: true },
  })),
  shell('offline, settings', () => ({
    phase: OFFLINE,
    session: { error: DOWN },
    steps: [press(copy.phase.settings)],
  })),
  shell('offline, network editor', () => ({
    phase: OFFLINE,
    session: { error: DOWN, networkEditor: true },
  })),
  passage('unlocking into the wallet', LOCKED),
  passage('loading into the wallet', LOADING),
  passage('back online into the wallet', OFFLINE, { error: DOWN }),
];

export const SCENES: Shot[] = [
  ...homes,
  ...activities,
  ...details,
  ...settingsShots,
  ...phases,
];
