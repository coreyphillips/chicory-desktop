/**
 * Shared fixtures for the suites the tracks write: one wallet, its payments
 * in every state, the requests and receipts behind them, and the strings the
 * copy guard should accept as data when a state is drawn from them.
 *
 * Every value is fixed, so a state renders the same on every run. Hashes,
 * txids and addresses are shaped like the real thing but are not valid; they
 * are for drawing, not for paying.
 */
import type {
  Activity,
  PaymentStatus,
  ReceiveRequestDetails,
  ReceiveStatus,
  WalletRecord,
  WalletSnapshot,
} from '@beignet/wallet-core';
import { btc, compact, dateLabel, dayLabel, number } from '../chicory/src/theme';

/** The moment the fixtures are set at. */
export const NOW = Date.parse('2026-06-06T12:00:00Z');

const HOUR = 3_600_000;

/** A run of lowercase hex, `length` long, the same for the same `seed`. */
export function hex(seed: number, length = 64): string {
  // Park and Miller's generator, which stays within exact integers.
  const MODULUS = 2_147_483_647;
  let value = ((seed + 1) * 16_807) % MODULUS;
  let out = '';
  while (out.length < length) {
    value = (value * 48_271) % MODULUS;
    out += value.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

export type Lfbw = NonNullable<WalletRecord['lfbw']>;

/** A regtest wallet on this device, set up and running. */
export function walletOf(over: Partial<WalletRecord> = {}): WalletRecord {
  return {
    id: 'fixture-wallet',
    name: 'Everyday',
    network: 'regtest',
    status: 'running',
    lfbw: { enabled: true, mode: 'internal', setup: 'ready' },
    ...over,
  };
}

/**
 * A snapshot of the fixture wallet. `balance`, `primary` and `wallet` merge
 * over the defaults, `lfbw` over the wallet's own, and `activity` replaces
 * the empty history.
 */
export function snapshotOf({
  balance,
  activity = [],
  primary,
  wallet,
  lfbw,
}: {
  balance?: Partial<WalletSnapshot['balance']>;
  activity?: Activity[];
  primary?: Partial<WalletSnapshot['primary']>;
  wallet?: Partial<WalletRecord>;
  lfbw?: Partial<Lfbw>;
} = {}): WalletSnapshot {
  const record = walletOf(wallet);
  return {
    wallet: lfbw
      ? { ...record, lfbw: { enabled: true, ...record.lfbw, ...lfbw } }
      : record,
    balance: {
      totalSats: 261_500,
      availableSats: 250_000,
      pendingSats: 11_500,
      receivableSats: 100_000,
      offlineReceivableSats: 50_000,
      ...balance,
    },
    activity,
    primary: {
      uri: `02${hex(1, 64)}@127.0.0.1:19846`,
      connected: true,
      setup: 'ready',
      ...primary,
    },
    notes: [],
    updatedAt: NOW,
    demo: false,
  };
}

/** A receive request, for 10,000 sats over Lightning and Bitcoin. */
export function requestOf(
  over: Partial<ReceiveRequestDetails> = {},
  seed = 0,
): ReceiveRequestDetails {
  const paymentHash = over.paymentHash ?? hex(100 + seed);
  const address = over.address ?? `bcrt1q${hex(200 + seed, 38)}`;
  const bolt11 = over.bolt11 ?? `lnbcrt100u1p${hex(300 + seed, 120)}`;
  const amountSats = over.amountSats === undefined ? 10_000 : over.amountSats;
  const amount = amountSats === null ? '' : `amount=${btc(amountSats)}&`;
  return {
    id: `request-${seed}`,
    uri: `bitcoin:${address}?${amount}lightning=${bolt11}`,
    address,
    bolt11,
    paymentHash,
    amountSats,
    description: '',
    feeSats: 0,
    expiresAt: NOW + HOUR,
    createdAt: NOW,
    warnings: [],
    demo: false,
    bitcoinTracking: 'unique',
    ...over,
  };
}

/** What a request has received: nothing yet, part, some confirming, all. */
export function receiptOf(
  phase: ReceiveStatus['phase'],
  over: Partial<ReceiveStatus> = {},
): ReceiveStatus {
  const received = { waiting: 0, partial: 4_000, pending: 10_000 };
  const receivedSats = phase === 'completed' ? 10_000 : received[phase];
  const bitcoin = phase === 'partial' || phase === 'pending';
  const txid = bitcoin ? hex(400) : undefined;
  return {
    phase,
    receivedSats,
    confirmedSats: phase === 'completed' ? receivedSats : 0,
    pendingSats: phase === 'pending' ? receivedSats : 0,
    method: bitcoin ? 'bitcoin' : phase === 'waiting' ? undefined : 'lightning',
    txids: txid ? [txid] : [],
    ...(txid
      ? {
          txid,
          transactions: [
            { txid, amountSats: receivedSats, confirmed: phase !== 'pending' },
          ],
        }
      : {}),
    ...over,
  };
}

/**
 * How a payment moved (REDESIGN.md 6, Activity row): over Lightning, on
 * chain, or as direct funding. Each gives the id and references the engine
 * gives it.
 */
export type Rail = 'lightning' | 'chain' | 'fund';

const TITLES: Record<Activity['kind'], string> = {
  sent: 'Payment sent',
  received: 'Payment received',
  request: 'Payment request',
  transfer: 'Wallet transfer',
};

/** The id and references the engine gives a payment on `rail`. */
function railOf(
  rail: Rail,
  seed: number,
): Pick<Activity, 'id' | 'reference'> & Partial<Activity> {
  switch (rail) {
    case 'lightning': {
      const paymentHash = hex(500 + seed);
      return {
        id: `payment:${paymentHash}`,
        reference: paymentHash,
        paymentHash,
      };
    }
    case 'chain': {
      const txid = hex(600 + seed);
      const address = `bcrt1q${hex(700 + seed, 38)}`;
      return { id: `transaction:${txid}`, reference: txid, txid, address };
    }
    case 'fund': {
      const txid = hex(800 + seed);
      return { id: `submission:${hex(900 + seed, 16)}`, reference: txid, txid };
    }
  }
}

/**
 * One payment of 4,200 sats. `seed` keeps its id and references apart from
 * every other fixture's, and sets it `seed` hours before NOW.
 */
export function activityOf(
  kind: Activity['kind'],
  status: PaymentStatus,
  {
    rail = kind === 'transfer' ? 'chain' : 'lightning',
    seed = 0,
    ...over
  }: Partial<Activity> & { rail?: Rail; seed?: number } = {},
): Activity {
  return {
    ...railOf(rail, seed),
    kind,
    status,
    title: rail === 'fund' ? 'Direct funding sent' : TITLES[kind],
    description: '',
    amountSats: 4_200,
    feeSats: kind === 'sent' ? 12 : 0,
    timestamp: NOW - seed * HOUR,
    ...over,
  };
}

const KINDS: Activity['kind'][] = ['sent', 'received', 'request', 'transfer'];
const STATUSES: PaymentStatus[] = [
  'completed',
  'pending',
  'uncertain',
  'failed',
  'expired',
];

/**
 * The payments a history can hold, by name, newest first: every kind in
 * every status, the other rails, and the states a request moves through.
 * Each has its own id and references.
 */
export function everyActivity(): Record<string, Activity> {
  const out: Record<string, Activity> = {};
  let seed = 0;
  const add = (
    name: string,
    kind: Activity['kind'],
    status: PaymentStatus,
    over: Partial<Activity> & { rail?: Rail } = {},
  ) => {
    out[name] = activityOf(kind, status, { seed, ...over });
    seed += 1;
  };
  const request = (over: Partial<ReceiveRequestDetails> = {}) =>
    requestOf(over, seed);
  for (const kind of KINDS) {
    for (const status of STATUSES) {
      add(
        `${kind} ${status}`,
        kind,
        status,
        kind === 'request' ? { receiveRequest: request() } : {},
      );
    }
  }
  add('sent on chain', 'sent', 'completed', { rail: 'chain' });
  add('sent as direct funding', 'sent', 'completed', { rail: 'fund' });
  add('sent with an estimated fee', 'sent', 'completed', {
    feeEstimated: true,
  });
  add('sent with an unknown fee', 'sent', 'completed', { feeKnown: false });
  add('received on chain, confirming', 'received', 'pending', {
    rail: 'chain',
  });
  add('received with a note', 'received', 'completed', {
    description: 'Lunch with Sam',
  });
  add('request for any amount', 'request', 'pending', {
    receiveRequest: request({ amountSats: null }),
  });
  add('request offline', 'request', 'pending', {
    receiveRequest: request({ offlineReceive: true }),
  });
  add('request partly paid', 'request', 'pending', {
    receiveRequest: request(),
    receiveStatus: receiptOf('partial'),
  });
  add('request paid, confirming', 'request', 'pending', {
    receiveRequest: request(),
    receiveStatus: receiptOf('pending'),
  });
  add('request paid', 'received', 'completed', {
    receiveRequest: request(),
    receiveStatus: receiptOf('completed'),
  });
  add('request with a reused address', 'request', 'pending', {
    receiveRequest: request({ bitcoinTracking: 'ambiguous' }),
  });
  add('request whose status is unavailable', 'request', 'pending', {
    receiveRequest: request(),
    receiveStatusUnavailable: true,
  });
  add('legacy invoice, expired', 'request', 'expired', {
    receiveRequest: request({
      legacy: true,
      address: undefined,
      bitcoinTracking: undefined,
    }),
  });
  return out;
}

const groups = (text: string) => text.match(/.{1,4}/g)?.join(' ') ?? '';

/**
 * A reference as a copy chip shows it (REDESIGN.md 5, CopyChip): a URI's
 * scheme and the human-readable part of an address or invoice kept whole,
 * the rest grouped in fours, and shortened in the middle unless `full`, to
 * one group after a prefix, or eight characters without one, and eight at
 * the end. Kept here rather than imported, so the fixtures depend on no
 * track's files; a state that draws a reference some other way passes what
 * it draws in `extra`.
 */
function chipShown(value: string, full = false): string {
  const KEEP = 8;
  const scheme = value.match(/^[a-z][a-z0-9+.-]*:/i)?.[0] ?? '';
  const hrp =
    value
      .slice(scheme.length)
      .match(
        /^(?:bc|tb|bcrt|ln[a-z0-9]*)1(?=[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}(?:$|[?&#]))/i,
      )?.[0] ?? '';
  const lead = [scheme, hrp].filter(Boolean);
  const rest = value.slice(scheme.length + hrp.length);
  const words = lead.map(word => `${word} `).join('');
  if (full || rest.length <= KEEP * 2 + 4) return words + groups(rest);
  const head = rest.slice(0, lead.length ? 4 : KEEP);
  return `${words}${groups(head)} … ${groups(rest.slice(-KEEP))}`;
}

/** The references a payment can show, as written and as the app shortens them. */
function referencesOf(item: Activity): string[] {
  const request = item.receiveRequest;
  return [
    item.reference,
    item.txid,
    item.paymentHash,
    item.address,
    request?.uri,
    request?.bolt11,
    request?.address,
    request?.paymentHash,
    ...(item.receiveStatus?.txids ?? []),
  ].flatMap(value =>
    value
      ? [value, compact(value), chipShown(value), chipShown(value, true)]
      : [],
  );
}

/**
 * What a state drawn from `snapshot` may show as data, for `copyViolations`
 * (REDESIGN.md rule 1): the wallet's name, each payment's note, its amounts,
 * date and day as the app's own formatters write them, and its references as
 * written and shortened. `extra` adds what a state brings of its own, such as
 * recovery words or a typed request.
 */
export function guardData(
  snapshot: WalletSnapshot,
  extra: string[] = [],
): string[] {
  const amounts = (value: number) => [number(value), btc(value)];
  const { balance } = snapshot;
  const data = [
    snapshot.wallet.name,
    ...[
      balance.totalSats,
      balance.availableSats,
      balance.pendingSats,
      balance.receivableSats,
      balance.offlineReceivableSats ?? 0,
    ].flatMap(amounts),
    ...snapshot.activity.flatMap(item => [
      item.description,
      dateLabel(item.timestamp),
      dayLabel(item.timestamp),
      ...amounts(item.amountSats),
      ...amounts(item.feeSats),
      ...referencesOf(item),
    ]),
    ...extra,
  ];
  return [...new Set(data.filter(Boolean))];
}
