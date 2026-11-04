/**
 * Send and Receive, on the canvas, in every step and outcome. Each is
 * reached the way a person reaches it: the request is keyed in, reviewed and
 * held to send, or the amount keyed in, quoted and made a request, with the
 * gallery's wallet answering each call at once in the way the state needs.
 */
import type {
  SendResult,
  SendReview,
  WalletSnapshot,
} from '@beignet/wallet-core';
import { copy } from '../chicory/src/design/copy';
import type { WalletAdapter } from '../chicory/src/services/wallet';
import type { AutoPay } from '../chicory/src/services/autoPayPreference';
import { holdRequest } from '../chicory/src/stage/heldRequests';
import { activityOf, hex, receiptOf } from './fixtures';
import {
  ADDRESS,
  FEE_RATES,
  INVOICE,
  NOTE,
  configOf,
  fresh,
  never,
  onMainnet,
  quoteOf,
  ratedReviewOf,
  refusal,
  requestFor,
  resultOf,
  reviewOf,
  stale,
} from './fakes';
import { press, wait } from './shots';
import type { Shot, Step } from './shots';
import { hideBalance, inBtc, inSats, open, wallet } from './staged';

/** Keys `digits` in on the keypad, one key a step. */
export const keyed = (digits: string): Step[] =>
  [...digits].map(digit => press(copy.keypad.digits[Number(digit)]));

/**
 * How long a state that plays out holds: a result growing out of the hold
 * and going home, or a receipt's bloom folding back into its ring.
 */
const SEEN_THROUGH = 2400;

// Send.

export const REVIEW = press(copy.send.review);
export const SEND = copy.send.sendSats(4_200);
/** The amount every payment here is for, keyed in: the address names none. */
export const AMOUNT_4200 = keyed('4200');
/** A request the parser refuses as it is entered: an LNURL. */
const LNURL =
  'LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS';
const COMMIT: Step = drive => drive.activate(SEND);

interface Paying {
  request?: string;
  /** The camera read `request` from home, as the scan overlay opens Send. */
  scanned?: boolean;
  /** Settings > Auto-pay; off if unset. */
  autoPay?: AutoPay;
  snapshot?: WalletSnapshot;
  /** Later reads of the wallet, one after each step, as polls bring them. */
  later?: WalletSnapshot[];
  client?: Partial<WalletAdapter>;
  steps?: Step[];
}

export function send(
  name: string,
  make: () => Paying = () => ({}),
  hold?: number,
): Shot {
  return wallet(
    `send, ${name}`,
    () => {
      const {
        request = ADDRESS,
        scanned = false,
        autoPay,
        snapshot,
        later,
        client,
        steps,
      } = make();
      return {
        snapshot,
        later,
        client,
        autoPay,
        open: [scanned ? open.scanned(request) : open.send(request)],
        steps,
      };
    },
    hold,
  );
}

/** Reviewed, with the review as `over` sets it when the wallet is asked. */
const reviewed = (name: string, over: () => Partial<SendReview>) =>
  send(name, () => ({
    client: { prepareSend: async () => reviewOf(over()) },
    steps: [...AMOUNT_4200, REVIEW],
  }));

/**
 * Reviewed and held to send, with the wallet answering `send`, and `after`
 * run once it has committed.
 */
const sent = (
  name: string,
  answer: WalletAdapter['send'],
  before: Step[] = [],
  after: Step[] = [],
  hold?: number,
) =>
  send(
    name,
    () => ({
      client: { send: answer },
      steps: [...before, ...AMOUNT_4200, REVIEW, COMMIT, ...after],
    }),
    hold,
  );

/**
 * How long after the hold commits a wallet on a phone answers: after the
 * burst, so the comet is seen running before the result grows out of the
 * hold.
 */
export const AFTER_BURST_MS = 1200;

/** `status`, answered `ms` after the hold commits. */
export const answered =
  (
    status: SendResult['status'],
    over: Partial<SendResult> = {},
    ms = AFTER_BURST_MS,
  ): WalletAdapter['send'] =>
  () =>
    new Promise(resolve =>
      setTimeout(() => resolve(resultOf(status, over)), ms),
    );

/** The steps that see a late answer land: a wait a little past it. */
const landed = [wait(AFTER_BURST_MS + 100)];

/**
 * A payment to the address the engine took before naming its transaction,
 * as the embedded engine answers a splice-out as the splice starts: priced
 * as a splice, and answered pending with no transaction and no hash.
 */
const broadcasting = (): Partial<WalletAdapter> => ({
  prepareSend: async () => ratedReviewOf(),
  send: answered('pending', { paymentHash: undefined }),
});

/** Reviewed, and refused by the engine with `code`. */
const refused = (name: string, code: string, before: Step[] = AMOUNT_4200) =>
  send(name, () => ({
    client: {
      prepareSend: async () => {
        throw refusal('The engine said no.', code);
      },
    },
    steps: [...before, REVIEW],
  }));

const sends: Shot[] = [
  send('empty', () => ({ request: '' })),
  send('a request taken as a chip'),
  send('max amount chip selected', () => ({
    steps: [press(copy.amount.spoken(198_000))],
  })),
  send('max Lightning review with three bounds', () => ({
    client: {
      prepareSend: async () =>
        reviewOf({
          max: true,
          amountSats: 198_000,
          minRecipientSats: 198_000,
          feeSats: 2_000,
          maxFeeSats: 2_000,
          totalSats: 200_000,
          debitSats: 200_000,
          debitMsat: '200000000',
          maxFeeMsat: '2000000',
          keptSats: 1_402,
          keptReason: 'commitment-cost',
        }),
    },
    steps: [press(copy.amount.spoken(198_000)), REVIEW],
  })),
  send('an amount the request fixes', () => ({ request: INVOICE })),
  send('an amount keyed in', () => ({ steps: keyed('4200') })),
  send('more than can be sent now', () => ({ steps: keyed('255000') })),
  send('more than the wallet holds', () => ({ steps: keyed('300000') })),
  send('the longest amount, past what the wallet holds', () => ({
    steps: keyed('9999999999999999'),
  })),
  send('a stale balance', () => ({
    snapshot: stale(onMainnet()),
  })),
  send('a request that cannot be paid', () => ({ request: LNURL })),
  send('on a test network', () => ({
    snapshot: fresh(),
    steps: [...AMOUNT_4200, REVIEW],
  })),
  send('preparing', () => ({
    client: { prepareSend: never },
    steps: [...AMOUNT_4200, REVIEW],
  })),
  reviewed('review', () => ({})),
  reviewed('review, with the fee the route should cost', () => ({
    feeSats: 1_012,
    totalSats: 5_212,
    estimatedFeeSats: 12,
  })),
  // A payment to an address is priced as a splice, at the engine's normal
  // rate unless the slider under the sum chose another.
  send('review, over Bitcoin', () => ({
    client: {
      prepareSend: async input =>
        ratedReviewOf({}, input.feeRate ?? FEE_RATES.normal),
    },
    steps: [...AMOUNT_4200, REVIEW],
  })),
  // The same sum in BTC, its widest face: the rate keeps its column while
  // the sum fits its room, and drops under the fee at the largest text sizes.
  send('review, over Bitcoin, in BTC', () => ({
    client: {
      prepareSend: async input =>
        ratedReviewOf({}, input.feeRate ?? FEE_RATES.normal),
    },
    steps: [...inBtc, ...AMOUNT_4200, REVIEW],
  })),
  send('review, over Bitcoin, the fee rate raised', () => ({
    client: {
      prepareSend: async input =>
        ratedReviewOf({}, input.feeRate ?? FEE_RATES.normal),
    },
    steps: [...AMOUNT_4200, REVIEW, drive => drive.call('onChoose', 8)],
  })),
  send('review, over Bitcoin, a rate refused', () => ({
    client: {
      prepareSend: async input => {
        if (input.feeRate) {
          throw refusal(
            'The available balance is too low for this payment and its fee.',
            'INSUFFICIENT_FUNDS',
          );
        }
        return ratedReviewOf();
      },
    },
    steps: [...AMOUNT_4200, REVIEW, drive => drive.call('onChoose', 8)],
  })),
  reviewed('review, by direct funding', () => ({
    route: 'bitcoin',
    method: 'direct-funding',
    feeSats: 1_000,
    totalSats: 5_200,
  })),
  reviewed('review, with warnings', () => ({
    warnings: ['This invoice expires soon.'],
  })),
  reviewed('review, the quote nearly out', () => ({
    expiresAt: Date.now() + 5_000,
  })),
  reviewed('review, the quote run out', () => ({
    expiresAt: Date.now() - 1,
  })),
  // The browser hold reads real pointer and key events rather than a
  // gesture handler, so the desktop runner presses it down itself
  // (scripts/desktop/gallery.mjs) once the review is reached.
  send('review, held down', () => ({
    steps: [...AMOUNT_4200, REVIEW],
  })),
  sent('sending', never),
  sent('sent', async () => resultOf('completed')),
  // A scanned invoice within Settings > Auto-pay's share: reviewed on its
  // own and gone with no hold, the complete played for the payer, the comet
  // running, and the result growing out of the hold once it answers.
  send(
    'sent by Auto-pay',
    () => ({
      request: INVOICE,
      scanned: true,
      autoPay: { on: true, share: 50 },
      client: {
        prepareSend: async () =>
          reviewOf({ amountSats: 24_425, feeSats: 20, totalSats: 24_445 }),
        send: answered('completed', { amountSats: 24_425 }),
      },
      steps: landed,
    }),
    SEEN_THROUGH,
  ),
  sent('sent, with amounts hidden', async () => resultOf('completed'), [
    hideBalance,
  ]),
  sent(
    'sent, after the burst',
    answered('completed'),
    [],
    landed,
    SEEN_THROUGH,
  ),
  send(
    'sent after the burst, with warnings',
    () => ({
      client: {
        prepareSend: async () =>
          reviewOf({ warnings: ['This invoice expires soon.'] }),
        send: answered('completed'),
      },
      steps: [...AMOUNT_4200, REVIEW, COMMIT, ...landed],
    }),
    SEEN_THROUGH,
  ),
  sent(
    'failed, after the burst',
    answered('failed', { message: 'No route to the recipient.' }),
    [],
    landed,
    SEEN_THROUGH,
  ),
  sent(
    'on its way, after the burst',
    answered('pending'),
    [],
    landed,
    SEEN_THROUGH,
  ),
  send(
    'sending to Bitcoin, after the burst',
    () => ({
      client: broadcasting(),
      steps: [...AMOUNT_4200, REVIEW, COMMIT, ...landed],
    }),
    SEEN_THROUGH,
  ),
  // The history names its transaction a few seconds on, as a read brings
  // the payment's row: the orbit resolves where it stands into the clock
  // disc, the transaction fades in under it, and it goes home.
  send(
    'sending to Bitcoin, seen broadcast',
    () => ({
      client: broadcasting(),
      steps: [...AMOUNT_4200, REVIEW, COMMIT, ...landed, wait(1_500)],
      later: [
        onMainnet({
          activity: [
            activityOf('sent', 'pending', {
              rail: 'chain',
              id: 'submission:gallery-payment',
              txid: hex(41),
            }),
          ],
        }),
      ],
    }),
    SEEN_THROUGH,
  ),
  sent(
    'unknown, after the burst',
    answered('uncertain'),
    [],
    landed,
    SEEN_THROUGH,
  ),
  send('an amount keyed in, in sats', () => ({
    steps: [...inSats, ...AMOUNT_4200],
  })),
  send('review in sats', () => ({
    client: { prepareSend: async () => reviewOf({}) },
    steps: [...inSats, ...AMOUNT_4200, REVIEW],
  })),
  sent('sent in sats', async () => resultOf('completed'), inSats),
  sent('on its way', async () => resultOf('pending')),
  sent('unknown', async () => resultOf('uncertain')),
  sent('unknown, the connection ended mid-send', async () => {
    throw refusal('The connection ended.', 'RESULT_UNCERTAIN');
  }),
  sent('failed', async () =>
    resultOf('failed', { message: 'No route to the recipient.' }),
  ),
  send('a held request', () => {
    holdRequest(ADDRESS, { status: 'uncertain' });
    return {};
  }),
  send('a held request, its payment still under way', () => {
    holdRequest(ADDRESS, { status: 'pending' });
    return {};
  }),
  send('a request paid already', () => {
    // A request that names its amount is paid once, so it rests paid.
    const request = `bitcoin:${ADDRESS}?amount=0.000042`;
    holdRequest(request, { status: 'completed' });
    return { request };
  }),
  send('a held request, paid while it shows', () => {
    // The held ring on screen resolves into the paid mark it watched.
    const request = `bitcoin:${ADDRESS}?amount=0.000042`;
    holdRequest(request, { status: 'pending' });
    return {
      request,
      steps: [() => holdRequest(request, { status: 'completed' })],
    };
  }),
  refused('a held request, the engine says already out', 'ALREADY_SUBMITTED'),
  refused('a request refused', 'INVALID_REQUEST'),
  refused('short of funds, within what is held', 'INSUFFICIENT_FUNDS'),
  refused(
    'short of funds, past what is held',
    'INSUFFICIENT_FUNDS',
    keyed('300000'),
  ),
  refused('the primary node away', 'PRIMARY_DOWN'),
  refused('no route', 'NO_ROUTE'),
  refused('the channel funding unconfirmed', 'FUNDING_UNCONFIRMED'),
  sent('the quote ran out as it was sent', async () => {
    throw refusal('The quote expired.', 'QUOTE_EXPIRED');
  }),
];

// Receive.

const CONTINUE = press(copy.receive.continue);
const CREATE = press(copy.receive.create);
const AMOUNT = keyed('10000');
const TO_QUOTE = [...AMOUNT, CONTINUE];
export const TO_REQUEST = [...TO_QUOTE, CREATE];

/** Long enough to see a request's frame listen through two of its pings. */
const LISTENING = 6000;

/**
 * Long enough to see a request waiting, then paid as the wallet's next poll
 * brings the receipt, and its bloom fold back into the ring.
 */
const ARRIVING = 4500;
const OFFLINE = press(copy.receive.offline);
const offering: Partial<WalletAdapter> = {
  getConfig: async () => configOf({ offlineReceiveAvailable: true }),
};

interface Receiving {
  snapshot?: WalletSnapshot;
  client?: Partial<WalletAdapter>;
  steps?: Step[];
}

export function receive(
  name: string,
  make: () => Receiving = () => ({}),
  hold?: number,
): Shot {
  return wallet(
    `receive, ${name}`,
    () => ({
      ...make(),
      open: [open.receive()],
    }),
    hold,
  );
}

/** A request made, and what the wallet says has arrived for it. */
const arrived = (
  name: string,
  status: ReturnType<typeof receiptOf>,
  before: Step[] = [],
) =>
  receive(
    name,
    () => ({
      client: { getReceiveStatus: async () => status },
      steps: [...before, ...TO_REQUEST],
    }),
    SEEN_THROUGH,
  );

/**
 * A request made and waiting, then paid: the wallet says nothing has
 * arrived until a step says it has, and its next poll brings the receipt.
 * `snapshot` is read as the state comes up, so its balance is fresh then.
 */
const arriving = (name: string, snapshot?: () => WalletSnapshot) =>
  receive(
    name,
    () => {
      let paid = false;
      return {
        snapshot: snapshot?.(),
        client: {
          getReceiveStatus: async () =>
            receiptOf(paid ? 'completed' : 'waiting'),
        },
        steps: [
          ...TO_REQUEST,
          () => {
            paid = true;
          },
          // Past the next 2 s poll, as driven runs drop the dwell.
          wait(2_500),
        ],
      };
    },
    ARRIVING,
  );

const TXID = hex(400);

const onlyAmount = (receivableSats: number) =>
  onMainnet({ balance: { receivableSats } });

/** `digits` keyed in, and refused as more than the primary funds at once. */
const pastCap = (name: string, digits: string) =>
  receive(name, () => ({
    snapshot: onlyAmount(0),
    client: {
      quoteReceive: async () => {
        throw refusal(
          'the provider funds at most 1000000 sats for one receive',
          'RECEIVE_UNAVAILABLE',
        );
      },
    },
    steps: [...keyed(digits), CONTINUE],
  }));

const receives: Shot[] = [
  receive('any amount'),
  receive('an amount keyed in', () => ({ steps: AMOUNT })),
  receive('an amount required', () => ({ snapshot: onlyAmount(0) })),
  receive('a note', () => ({
    steps: [
      press(copy.receive.addNote),
      drive => drive.type(copy.receive.note, NOTE),
    ],
  })),
  receive('offline offered', () => ({ client: offering })),
  receive('offline on', () => ({ client: offering, steps: [OFFLINE] })),
  receive('offline on, over what fits', () => ({
    client: offering,
    steps: [OFFLINE, ...keyed('60000')],
  })),
  receive('a stale balance', () => ({
    snapshot: stale(onMainnet()),
  })),
  receive('on a test network', () => ({
    snapshot: fresh(),
    steps: TO_REQUEST,
  })),
  receive('the quote refused', () => ({
    client: {
      quoteReceive: async () => {
        throw new Error('No route to the primary.');
      },
    },
    steps: [CONTINUE],
  })),
  pastCap('the amount refused, past what the primary funds', '2000000'),
  pastCap('nine figures refused, stepped down to fit', '999999999'),
  receive('the primary node away', () => ({
    client: {
      quoteReceive: async () => {
        throw refusal('Your primary node needs to reconnect.', 'PRIMARY_DOWN');
      },
    },
    steps: [CONTINUE],
  })),
  receive('the quote', () => ({ steps: TO_QUOTE })),
  receive('the quote, with a fee', () => ({
    client: {
      quoteReceive: async input =>
        quoteOf(input, { feeSats: 100, netSats: 9_900 }),
    },
    steps: TO_QUOTE,
  })),
  receive('the quote, a channel made just in time', () => ({
    snapshot: onlyAmount(0),
    client: {
      quoteReceive: async input =>
        quoteOf(input, { feeSats: 1_000, netSats: 9_000 }),
    },
    steps: TO_QUOTE,
  })),
  receive('the quote, for any amount', () => ({ steps: [CONTINUE] })),
  receive('the quote, offline', () => ({
    client: offering,
    steps: [OFFLINE, ...TO_QUOTE],
  })),
  receive('the quote, run out', () => ({
    client: {
      quoteReceive: async input =>
        quoteOf(input, { expiresAt: Date.now() - 1 }),
    },
    steps: TO_QUOTE,
  })),
  receive('the quote in sats, with a fee', () => ({
    client: {
      quoteReceive: async input =>
        quoteOf(input, { feeSats: 100, netSats: 9_900 }),
    },
    steps: [...inSats, ...TO_QUOTE],
  })),
  receive('the request', () => ({ steps: TO_REQUEST })),
  receive('the request in sats', () => ({ steps: [...inSats, ...TO_REQUEST] })),
  receive('the request, for any amount', () => ({
    steps: [CONTINUE, CREATE],
  })),
  receive('the request, over Lightning only', () => ({
    client: {
      receive: async quote =>
        requestFor(quote, {
          address: undefined,
          bitcoinTracking: 'lightning-only',
          warnings: ['Bitcoin fallback is unavailable.'],
        }),
    },
    steps: TO_REQUEST,
  })),
  receive('the request, offline', () => ({
    client: {
      ...offering,
      receive: async quote => requestFor(quote, { offlineReceive: true }),
    },
    steps: [OFFLINE, ...TO_REQUEST],
  })),
  receive('the request, running out', () => ({
    client: {
      receive: async quote =>
        requestFor(quote, {
          createdAt: Date.now() - 50 * 60_000,
          expiresAt: Date.now() + 5 * 60_000,
        }),
    },
    steps: TO_REQUEST,
  })),
  receive('the request, lifted', () => ({
    steps: [...TO_REQUEST, press(copy.receive.qr)],
  })),
  receive('the request, copied', () => ({
    steps: [...TO_REQUEST, press(copy.receive.copy)],
  })),
  receive('the request, expiring', () => ({
    client: {
      receive: async quote =>
        requestFor(quote, { expiresAt: Date.now() + 600 }),
    },
    steps: TO_REQUEST,
  })),
  receive('the request, on a reused address', () => ({
    client: {
      getReceiveStatus: async () => {
        throw refusal(copy.receive.reusedAddress, 'AMBIGUOUS_RECEIVE_ADDRESS');
      },
    },
    steps: TO_REQUEST,
  })),
  arrived('a payment detected, confirming', receiptOf('pending')),
  arrived('part of it here', receiptOf('partial')),
  arrived('received', receiptOf('completed')),
  arrived(
    'received on chain',
    receiptOf('completed', {
      method: 'bitcoin',
      txid: TXID,
      txids: [TXID],
      transactions: [{ txid: TXID, amountSats: 10_000, confirmed: true }],
    }),
  ),
  arrived('received, hidden', receiptOf('completed'), [hideBalance]),
  receive('the request, listening', () => ({ steps: TO_REQUEST }), LISTENING),
  arriving('received, as it arrives'),
  arriving('received, as it arrives, on a test network', fresh),
];

export const PAYMENTS: Shot[] = [...sends, ...receives];
