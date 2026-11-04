/**
 * The gallery's wallet: the shared fixtures in test-support/fixtures.ts,
 * moved to the present, behind a client and a session that answer at once
 * and never open a vault, start an engine or reach the network.
 */
import type {
  Activity,
  DrainProgress,
  FeeRates,
  HostConfig,
  ReceiveInput,
  ReceiveQuote,
  ReceiveRequest,
  SendResult,
  SendReview,
  WalletDiagnostics,
  WalletSnapshot,
} from '@beignet/wallet-core';
import { defaultProfile } from '../chicory/src/services/networks';
import { STALE_AFTER_MS } from '../chicory/src/services/useWalletSession';
import type { useWalletSession } from '../chicory/src/services/useWalletSession';
import type { WalletAdapter } from '../chicory/src/services/wallet';
import {
  NOW,
  hex,
  receiptOf,
  requestOf,
  snapshotOf,
  walletOf,
} from './fixtures';
import type { Lfbw } from './fixtures';

export type Session = ReturnType<typeof useWalletSession>;

const MINUTE = 60_000;

/** The fields that hold a moment rather than an amount. */
const MOMENTS = new Set([
  'timestamp',
  'expiresAt',
  'createdAt',
  'updatedAt',
  'at',
  'retryAt',
  'checkedAt',
]);

/**
 * `value` with every moment in it moved from the fixtures' NOW to now. The
 * fixtures are set on a fixed day, when a request made then has long run
 * out and a balance read then is stale; moved, they are as fresh on screen
 * as they are in a suite.
 */
export function present<T>(value: T): T {
  const shift = Date.now() - NOW;
  const move = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(move);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, field]) => [
        key,
        MOMENTS.has(key) && typeof field === 'number'
          ? field + shift
          : move(field),
      ]),
    );
  };
  return move(value) as T;
}

/** The wallet as read just now; the fixture wallet is on regtest. */
export const fresh = (...args: Parameters<typeof snapshotOf>) =>
  present(snapshotOf(...args));

export const MAINNET = { network: 'mainnet' } as const;

/** The wallet as read just now, on mainnet. */
export const onMainnet = (over: Parameters<typeof snapshotOf>[0] = {}) =>
  fresh({ ...over, wallet: { ...MAINNET, ...over.wallet } });

/** The wallet's last channelize decision, for the vessel to explain. */
export const decided = (
  action: NonNullable<Lfbw['lastChannelize']>['action'],
  reason?: string,
): Partial<Lfbw> => ({ lastChannelize: { action, at: NOW, reason } });

/** The home channel's last splice, conflicted or put back. */
export const spliced = (state: 'conflicted' | 'reverted'): Partial<Lfbw> => ({
  lastSplice: { state, spliceTxid: null, conflictTxid: null, at: NOW },
});

/** The wallet as last read too long ago to spend against. */
export const stale = (snapshot: WalletSnapshot): WalletSnapshot => ({
  ...snapshot,
  updatedAt: Date.now() - STALE_AFTER_MS - 5_000,
});

export const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';

/** An on-chain address, which names no amount. */
export const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

/** An invoice for 24,425 sats, which fixes the amount. */
export const INVOICE =
  'lnbc244250n1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw53adf';

export const NOTE = 'Coffee with Sam';

/** An engine refusal, with the code the app reads. */
export const refusal = (message: string, code: string) =>
  Object.assign(new Error(message), { code });

/** A call that is still waiting when the state ends. */
export const never = <T>() => new Promise<T>(() => {});

export function reviewOf(over: Partial<SendReview> = {}): SendReview {
  return {
    id: 'gallery-review',
    destination: ADDRESS,
    description: NOTE,
    amountSats: 4_200,
    feeSats: 20,
    feeLabel: 'Maximum fee',
    totalSats: 4_220,
    route: 'lightning',
    expiresAt: Date.now() + MINUTE,
    warnings: [],
    ...over,
  };
}

/** The engine's estimates when the gallery prices an address, whole sats per virtual byte. */
export const FEE_RATES: FeeRates = { fast: 8, normal: 2, slow: 1, minimum: 1 };

/**
 * A review priced as a splice to ADDRESS at `rate`, the engine's normal
 * unless the slider chose another, with a fee that scales with the rate so
 * the sum's lines roll on the device.
 */
export function ratedReviewOf(
  over: Partial<SendReview> = {},
  rate = FEE_RATES.normal,
): SendReview {
  const feeSats = 250 * rate;
  const amountSats = over.amountSats ?? 4_200;
  return reviewOf({
    id: `gallery-review-${rate}`,
    route: 'bitcoin',
    feeLabel: 'Estimated network fee',
    feeSats,
    totalSats: amountSats + feeSats,
    feeRate: rate,
    feeRates: FEE_RATES,
    ...over,
  });
}

export function resultOf(
  status: SendResult['status'],
  over: Partial<SendResult> = {},
): SendResult {
  return {
    id: 'gallery-payment',
    status,
    amountSats: 4_200,
    feeSats: 20,
    paymentHash: hex(40),
    message: 'The engine had its say.',
    ...over,
  };
}

export function quoteOf(
  input: ReceiveInput = {},
  over: Partial<ReceiveQuote> = {},
): ReceiveQuote {
  const amount = input.amountSats == null ? null : Number(input.amountSats);
  return {
    id: 'gallery-quote',
    amountSats: amount,
    description: input.description ?? '',
    feeSats: 0,
    netSats: amount,
    expiresAt: Date.now() + MINUTE,
    warnings: [],
    ...over,
  };
}

/** The request a quote becomes, made just now. */
export function requestFor(
  quote: ReceiveQuote,
  over: Partial<ReceiveRequest> = {},
): ReceiveRequest {
  return {
    ...present(
      requestOf({
        amountSats: quote.amountSats,
        description: quote.description,
      }),
    ),
    ...over,
  } as ReceiveRequest;
}

const CONFIG: HostConfig = {
  defaultNetwork: 'regtest',
  defaultElectrum: null,
  hasDefaultElectrum: false,
  supportedNetworks: ['mainnet', 'testnet', 'regtest'],
  electrumPresets: [],
  torAvailable: true,
  lfbwAvailable: true,
  drainAvailable: true,
  offlineReceiveAvailable: false,
  jitQuoteAvailable: true,
  engineVersion: 'gallery',
};

export function drainReviewOf(address = ADDRESS): SendReview {
  const progress: DrainProgress = {
    requestId: 'gallery-drain-001',
    revision: 1,
    address,
    phase: 'review',
    amountSats: 261000,
    feeSats: 500,
    debitSats: 261500,
    reviewedDebitSats: 261500,
    closeAmountSats: 249600,
    closeFeeSats: 400,
    sweepAmountSats: 11400,
    sweepFeeSats: 100,
    feeEstimated: true,
    txids: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + 120000,
  };
  return {
    id: progress.requestId,
    destination: address,
    description: 'Empty wallet to an address',
    amountSats: progress.amountSats,
    feeSats: progress.feeSats,
    totalSats: progress.debitSats,
    feeLabel: 'Estimated network fees',
    route: 'bitcoin',
    method: 'drain',
    drain: progress,
    expiresAt: progress.expiresAt,
    warnings: [],
  };
}

/**
 * The one send an emptied wallet shows in Activity, its drain in `phase`
 * and `over` in place, as the wallet reads it back. Its moments are the
 * fixtures', which `fresh` and `onMainnet` move to the present.
 */
export function drainActivityOf(
  phase: DrainProgress['phase'],
  over: Partial<DrainProgress> = {},
): Activity {
  const drain: DrainProgress = {
    ...drainReviewOf().drain!,
    revision: 3,
    phase,
    feeEstimated: phase === 'review',
    txids: ['review', 'preparing'].includes(phase) ? [] : [hex(91), hex(92)],
    createdAt: NOW - 10 * MINUTE,
    expiresAt: NOW - 8 * MINUTE,
    ...over,
  };
  return {
    id: `drain:${drain.requestId}`,
    kind: 'sent',
    title:
      phase === 'completed'
        ? 'Wallet emptied'
        : phase === 'cancelled'
        ? 'Wallet drain cancelled'
        : 'Emptying wallet',
    description: 'Empty wallet to an address',
    amountSats: drain.amountSats,
    feeSats: drain.feeSats,
    feeEstimated: drain.feeEstimated,
    status:
      phase === 'completed'
        ? 'completed'
        : phase === 'cancelled'
        ? 'failed'
        : phase === 'review'
        ? 'uncertain'
        : 'pending',
    timestamp: NOW - 9 * MINUTE,
    reference: drain.requestId,
    ...(drain.txids[0] ? { txid: drain.txids[0] } : {}),
    drain,
  };
}

/** What the engine says it offers, with `over` in place. */
export const configOf = (over: Partial<HostConfig> = {}): HostConfig => ({
  ...CONFIG,
  ...over,
});

function diagnostics(): WalletDiagnostics {
  return {
    checkedAt: Date.now(),
    wallet: walletOf().lfbw,
    blockHeight: 850_000,
    electrumConnected: true,
    primaryConnected: true,
    balance: { onchain: 11_500, lightning: 250_000, splicingSats: 0 },
    sendableSats: 250_000,
    graph: { nodes: 12_000, channels: 48_000, lastSyncAt: Date.now() },
    utxos: [{ valueSats: 11_500, height: 849_990 }],
    channels: [
      {
        channelId: hex(60),
        withPrimary: true,
        state: 'CHANNELD_NORMAL',
        htlcUsable: true,
        fundingConfirmed: true,
        fundingTxid: hex(61),
        capacitySats: 500_000,
        localBalanceSats: 250_000,
        remoteBalanceSats: 250_000,
      },
    ],
  };
}

/**
 * A wallet that answers every call at once, from the fixtures, and with
 * `over` in place of any call a state needs answered its own way.
 */
export function clientOf(over: Partial<WalletAdapter> = {}): WalletAdapter {
  const wallet = walletOf();
  let drain = drainReviewOf().drain!;
  return {
    connection: { url: 'embedded:', token: '' },
    demo: false,
    selectWallet: () => {},
    getConfig: async () => CONFIG,
    getRecoveryPhrase: async () => PHRASE,
    getRecoveryStatus: async () => ({
      mode: 'off',
      state: 'disabled',
      importPending: false,
      importComplete: false,
      autoApply: { enabled: false, phase: 'idle', lastReason: null },
      capsuleCount: 0,
      backupChannelCount: null,
      channels: [],
    }),
    listWallets: async () => [wallet],
    createWallet: async () => ({ ...wallet, mnemonic: PHRASE }),
    snapshot: async () => fresh(),
    quoteMax: async () => ({
      amountSats: 198_000,
      keptSats: 1_402,
      keptReason: 'commitment-cost',
    }),
    prepareDrain: async ({ address }) => {
      const review = drainReviewOf(address);
      drain = review.drain!;
      return review;
    },
    getDrain: async () => drain,
    cancelDrain: async () =>
      (drain = { ...drain, revision: drain.revision + 1, phase: 'cancelled' }),
    prepareSend: async input =>
      input.feeRate
        ? ratedReviewOf(
            input.amountSats ? { amountSats: Number(input.amountSats) } : {},
            input.feeRate,
          )
        : reviewOf(
            input.amountSats ? { amountSats: Number(input.amountSats) } : {},
          ),
    send: async review => {
      if (review.method === 'drain') {
        drain = {
          ...drain,
          revision: drain.revision + 1,
          phase: 'pending',
          feeEstimated: false,
          startedAt: Date.now(),
          txids: [hex(91), hex(92)],
        };
        return {
          id: review.id,
          status: 'pending',
          amountSats: drain.amountSats,
          feeSats: drain.feeSats,
          feeKnown: true,
          feeEstimated: false,
          drain,
          txid: drain.txids[0],
          message: 'Wallet drain pending.',
        };
      }
      return resultOf('completed', {
        amountSats: review.amountSats,
        feeSats: review.feeSats,
      });
    },
    quoteReceive: async input => quoteOf(input),
    receive: async quote => requestFor(quote),
    getReceiveStatus: async () => receiptOf('waiting'),
    importReceiveRequest: async () => requestFor(quoteOf()),
    updatePrimary: async () => wallet,
    startWallet: async () => {},
    refreshWallet: async () => {},
    retrySetup: async () => {},
    diagnostics: async () => diagnostics(),
    ...over,
  };
}

const idle = () => {};
const done = async () => {};

/**
 * A session with the fixture wallet open on `snapshot`, or none, and every
 * action a no-op that has already finished. `over` sets what a state needs.
 */
export function sessionOf(
  snapshot: WalletSnapshot | null,
  over: Partial<Session> = {},
): Session {
  const wallet = snapshot?.wallet ?? walletOf();
  return {
    // Desktop wallets live in the local manager, so a session is always a
    // host session, and there is no device to erase.
    rememberedSession: {
      mode: 'host',
      network: wallet.network,
      walletId: wallet.id,
      locked: false,
    },
    deviceHint: true,
    closing: false,
    erasing: false,
    activeProfile: defaultProfile(wallet.network),
    switching: false,
    switchTarget: null,
    switchError: '',
    networkEditor: false,
    client: clientOf(),
    wallets: [wallet],
    walletId: wallet.id,
    snapshot,
    initializing: false,
    connecting: false,
    selecting: false,
    refreshing: false,
    deviceVisible: false,
    error: '',
    setError: idle,
    setSwitchError: idle,
    setNetworkEditor: idle,
    setDeviceVisible: idle,
    refresh: done,
    manualRefresh: done,
    retrySetup: done,
    selectWallet: done,
    openDevice: done,
    openWallet: done,
    createDefaultWallet: done,
    switchNetwork: done,
    disconnect: done,
    eraseDevice: undefined,
    acknowledgeBackup: idle,
    ...over,
  };
}
