import type { Activity } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import type { GlyphName } from '../../design/glyphs';
import { btc, number, unitAffixes } from '../../theme';
import type { Unit } from '../../theme';

/**
 * What a payment's ring shows (REDESIGN.md 6, Activity row). Colour, the
 * ring's pattern and the glyph each carry the state, so it reads without the
 * colour and without words:
 *
 * - full: a closed ring, the outcome is known
 * - orbit: an arc going round, money is moving
 * - dashed: a waiting request, turning slowly
 * - split: part received, the rest dashed in honey
 * - held: steady honey with a halo, the outcome is unknown
 * - gap: an open ring, the status could not be read
 * - expired: short dashes, faded
 *
 * `progress` fills an orbit as confirmations arrive, `split` is the share of
 * a partial payment already here, and `badge` is a micro-glyph at the ring's
 * lower right.
 */
export interface RingVisual {
  tone: 'bloom' | 'sage' | 'honey' | 'radish' | 'dust' | 'steam';
  pattern: 'full' | 'orbit' | 'dashed' | 'split' | 'held' | 'gap' | 'expired';
  progress?: number;
  split?: number;
  glyph: GlyphName;
  badge?: GlyphName;
}

const KIND: Record<Activity['kind'], GlyphName> = {
  sent: 'send',
  received: 'receive',
  request: 'qr',
  transfer: 'swap',
};

const share = (part: number, whole: number) =>
  whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;

/**
 * The ring for one payment, most urgent state first. An unknown outcome
 * outranks everything, because it is the one state that must never be read
 * as done: a payment someone might make again. Failure and expiry come next,
 * since they are final, then the in-between states, then completion.
 */
export function ringVisual(item: Activity): RingVisual {
  const kind = KIND[item.kind];
  const request = item.receiveRequest;
  const status = item.receiveStatus;
  const open = item.status !== 'completed';
  const ring = (visual: RingVisual): RingVisual =>
    request?.legacy ? { ...visual, badge: 'chain' } : visual;

  if (item.status === 'uncertain') {
    return ring({ tone: 'honey', pattern: 'held', glyph: 'pause' });
  }
  if (item.status === 'failed') {
    return ring({ tone: 'radish', pattern: 'full', glyph: 'cross' });
  }
  if (item.status === 'expired') {
    return ring({ tone: 'dust', pattern: 'expired', glyph: kind });
  }
  if (status?.phase === 'partial') {
    return ring({
      tone: 'sage',
      pattern: 'split',
      split: share(status.receivedSats, request?.amountSats ?? 0),
      glyph: 'receive',
    });
  }
  // An address used twice cannot tell whose coins arrived: a safety state.
  if (open && request?.bitcoinTracking === 'ambiguous') {
    return ring({ tone: 'honey', pattern: 'full', glyph: 'twin' });
  }
  if (open && item.receiveStatusUnavailable) {
    return ring({ tone: 'steam', pattern: 'gap', glyph: 'question' });
  }
  if (status?.phase === 'pending') {
    return ring({
      tone: 'sage',
      pattern: 'orbit',
      progress: share(status.confirmedSats, status.receivedSats),
      glyph: 'receive',
    });
  }
  if (item.kind === 'received' && item.status === 'pending') {
    return ring({ tone: 'sage', pattern: 'orbit', glyph: 'receive' });
  }
  if (item.status === 'pending' && item.kind === 'request') {
    return ring({
      tone: 'bloom',
      pattern: 'dashed',
      glyph: request?.offlineReceive ? 'moon' : 'qr',
    });
  }
  if (item.status === 'pending') {
    return ring({ tone: 'bloom', pattern: 'orbit', glyph: kind });
  }
  // Completed. A paid request is money that came in.
  if (item.kind === 'received' || item.kind === 'request') {
    return ring({ tone: 'sage', pattern: 'full', glyph: 'receive' });
  }
  return ring({ tone: 'steam', pattern: 'full', glyph: kind });
}

/** How a payment moved: over Lightning, on chain, or as direct funding. */
export type Rail = 'bolt' | 'chain' | 'fund';

/** The engine's title for a completed direct funding, its only mark. */
const DIRECT_FUNDING = 'Direct funding sent';

/**
 * The rail a payment took (REDESIGN.md 6, rail glyph). What arrived for a
 * request decides first, since a request can be paid any of three ways; then
 * the id: `funding:` is a second payment of a request by direct funding,
 * `payment:` is Lightning, `transaction:` is on chain, and a send the app
 * submitted is Lightning when it has a payment hash.
 */
export function railOf(item: Activity): Rail {
  const method = item.receiveStatus?.method;
  if (method === 'bitcoin') return 'chain';
  if (method === 'direct-funding' || item.id.startsWith('funding:'))
    return 'fund';
  if (method === 'lightning' || item.id.startsWith('payment:')) return 'bolt';
  if (item.id.startsWith('submission:')) {
    if (item.paymentHash) return 'bolt';
    return item.title === DIRECT_FUNDING ? 'fund' : 'chain';
  }
  return 'chain';
}

export const RAIL_GLYPH: Record<Rail, GlyphName> = {
  bolt: 'bolt',
  chain: 'chain',
  fund: 'fund',
};

/**
 * How a row sets its amount (REDESIGN.md 6, amount styles). Money in is sage
 * and heavier with a plus, money out cream with a minus, a request steam, and
 * an amount that never moved is dust and struck through. `open` is a request
 * whose payer chooses the amount, drawn as infinity instead of a number.
 *
 * An unknown outcome keeps its sign but never the sage of money that arrived
 * (REDESIGN.md rule 4): the held ring beside it is what it says.
 */
export interface AmountVisual {
  tone: 'sage' | 'cream' | 'steam' | 'dust';
  weight: '600' | '400';
  sign: '+' | '−' | '';
  open: boolean;
  struck: boolean;
}

export function amountVisual(item: Activity): AmountVisual {
  const sign = item.kind === 'received' ? '+' : item.kind === 'sent' ? '−' : '';
  const open =
    item.kind === 'request' &&
    !!item.receiveRequest &&
    item.receiveRequest.amountSats === null;
  if (item.status === 'failed' || item.status === 'expired') {
    return { tone: 'dust', weight: '400', sign, open, struck: true };
  }
  if (item.status === 'uncertain') {
    return { tone: 'cream', weight: '400', sign, open, struck: false };
  }
  if (item.kind === 'received') {
    return { tone: 'sage', weight: '600', sign, open, struck: false };
  }
  if (item.kind === 'request') {
    return { tone: 'steam', weight: '400', sign, open, struck: false };
  }
  return { tone: 'cream', weight: '400', sign, open, struck: false };
}

/** A BTC amount's decimals, all of them, as the hero draws it. */
const BTC_DECIMALS = 8;

/**
 * An amount as a row or a line draws it, the way the Odometer draws the hero
 * (REDESIGN.md 5, Odometer): sats grouped in threes, and BTC with all eight
 * decimals, the zeros after the last significant one set apart as `dim` to
 * be drawn in dust. So a row in BTC lines up with the hero above it. An
 * amount with no significant decimal at all, a fee of nothing or a whole
 * bitcoin, dims all eight, as the hero does. With `symbol` on, sats are
 * `₿` before the figures and no suffix (`unitAffixes`); BTC is unchanged.
 */
export function figureOf(
  sats: number,
  unit: Unit,
  symbol = false,
): { prefix: string; value: string; dim: string; suffix: string } {
  const affixes = unitAffixes(unit, symbol);
  if (unit === 'sats') return { ...affixes, value: number(sats), dim: '' };
  const text = btc(sats);
  const [whole, fraction = ''] = text.split('.');
  if (!/^\d+$/.test(whole)) return { ...affixes, value: text, dim: '' };
  const decimals = fraction.padEnd(BTC_DECIMALS, '0');
  const kept = decimals.replace(/0+$/, '');
  return {
    ...affixes,
    value: `${whole}.${kept}`,
    dim: decimals.slice(kept.length),
  };
}

/** An expired row steps back, so the ones still in play lead. */
export const EXPIRED_OPACITY = 0.55;

/**
 * What a ring's badge or glyph says beyond the status word, for the row's
 * screen reader value: a reused address, an older request, a status that
 * could not be read.
 */
export function ringFlags(visual: RingVisual): string[] {
  const flags: string[] = [];
  if (visual.glyph === 'twin') flags.push(copy.activity.reusedAddress);
  if (visual.pattern === 'gap') flags.push(copy.activity.unavailable);
  if (visual.badge === 'chain') flags.push(copy.activity.legacy);
  return flags;
}
