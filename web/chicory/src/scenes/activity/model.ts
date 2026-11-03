import type { Activity } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import type { GlyphName } from '../../design/glyphs';
import { dayLabel, space, statusLabel } from '../../theme';
import { figureOf } from './visual';

export function activityStatus(item: Activity) {
  if (item.receiveStatus?.phase === 'partial') return 'Partially received';
  if (item.receiveStatus?.phase === 'pending') return 'Confirming';
  if (item.status === 'pending' && item.kind === 'request')
    return 'Awaiting payment';
  if (item.status === 'pending' && item.kind === 'received')
    return 'Confirming';
  return statusLabel(item.status);
}

/** The filter that shows everything, which tapping the chosen chip returns to. */
export const ALL = 'All';

/** The filter chips, each a glyph that names its payments. */
export const FILTERS = [
  { value: 'Sent', glyph: 'send' },
  { value: 'Received', glyph: 'receive' },
  { value: 'Requests', glyph: 'qr' },
  { value: 'Pending', glyph: 'orbit' },
] as const satisfies readonly { value: string; glyph: GlyphName }[];

export type Filter = (typeof FILTERS)[number]['value'];

function matchesFilter(item: Activity, filter: string) {
  switch (filter) {
    case 'Sent':
      return item.kind === 'sent';
    case 'Received':
      return item.kind === 'received';
    case 'Requests':
      // A request that has since been paid is still findable here, which is
      // where people look for "the code I sent someone".
      return item.kind === 'request' || !!item.receiveRequest;
    case 'Pending':
      return (
        item.status === 'pending' ||
        item.status === 'uncertain' ||
        item.receiveStatus?.phase === 'partial'
      );
    default:
      return true;
  }
}

/**
 * The amount as a search can find it: its bare digits, and as a row draws
 * it in either unit, with and without its unit ("10,000 sats", "₿10,000",
 * "0.0001").
 */
function amountTexts(sats: number): string[] {
  const inSats = figureOf(sats, 'sats');
  const inSymbol = figureOf(sats, 'sats', true);
  const inBtc = figureOf(sats, 'btc');
  return [
    String(sats),
    `${inSats.value} ${inSats.suffix}`,
    `${inSymbol.prefix}${inSymbol.value}`,
    `${inBtc.value}${inBtc.dim} ${inBtc.suffix}`,
  ];
}

/** `needle` is already trimmed and lowercased: this runs once per row. */
function matchesQuery(item: Activity, needle: string) {
  if (!needle) return true;
  const has = (value: string | undefined) =>
    !!value && value.toLowerCase().includes(needle);
  return (
    has(item.title) ||
    has(item.description) ||
    has(item.reference) ||
    has(item.txid) ||
    has(item.paymentHash) ||
    has(item.address) ||
    has(item.drain?.address) ||
    item.drain?.txids.some(has) ||
    amountTexts(item.amountSats).some(has)
  );
}

/**
 * What a payment needs from its owner, if anything (REDESIGN.md 6, attention
 * shelf): an unknown outcome, which must not be paid again, or a request
 * paid only in part.
 */
export function attentionOf(item: Activity): 'uncertain' | 'partial' | null {
  if (item.status === 'uncertain') return 'uncertain';
  if (item.receiveStatus?.phase === 'partial') return 'partial';
  return null;
}

/** Where a pinned row sits in the honey band, for its rounded corners. */
export type Band = 'solo' | 'start' | 'middle' | 'end';

export type ActivitySection =
  | { kind: 'header'; id: string; label: string }
  | { kind: 'item'; id: string; item: Activity; band?: Band };

function bandAt(index: number, count: number): Band {
  if (count === 1) return 'solo';
  if (index === 0) return 'start';
  return index === count - 1 ? 'end' : 'middle';
}

/**
 * The history as the list shows it: the payments that pass the filter and
 * the search, the ones that need attention pinned first in a band of their
 * own (unknown outcomes, then partial payments), and the rest under a day
 * header wherever the day changes. A pinned payment is not repeated below:
 * it drops back into its day once it is resolved.
 */
export function activitySections(
  activity: readonly Activity[],
  filter: string,
  needle: string,
): ActivitySection[] {
  const matched = activity.filter(
    item => matchesFilter(item, filter) && matchesQuery(item, needle),
  );
  const pinned = [
    ...matched.filter(item => attentionOf(item) === 'uncertain'),
    ...matched.filter(item => attentionOf(item) === 'partial'),
  ];
  const out: ActivitySection[] = pinned.map((item, index) => ({
    kind: 'item',
    id: item.id,
    item,
    band: bandAt(index, pinned.length),
  }));
  let day = '';
  for (const item of matched) {
    if (attentionOf(item)) continue;
    const label = dayLabel(item.timestamp);
    if (label !== day) {
      day = label;
      // Keyed by the payment it heads, since a history out of order can
      // come back to a day it has already headed.
      out.push({ kind: 'header', id: `day:${item.id}`, label });
    }
    out.push({ kind: 'item', id: item.id, item });
  }
  return out;
}

/** A row's height, fixed so the list can place any row without measuring. */
export const ROW_HEIGHT = 64;
/** A day header's height. */
export const DAY_HEIGHT = 36;

/**
 * Where a row draws what a payment's detail flies out of (REDESIGN.md 7, T4):
 * its ring at the left, then after a gap the amount, and a note under the
 * amount when there is one. A pinned row's band reaches past the rows around
 * it by `ROW_BAND` on each side, and pads its content back into line.
 */
export const ROW_RING = 40;
export const ROW_GAP = space.sm;
export const ROW_BAND = space.sm;
export const NOTE_GAP = 2;
/** The infinity a request of any amount shows in place of a figure. */
export const ROW_OPEN = 22;

/** Where each section sits in the list, for `getItemLayout`. */
export function sectionLayout(
  sections: readonly ActivitySection[],
): { length: number; offset: number; index: number }[] {
  let offset = 0;
  return sections.map((section, index) => {
    const length = section.kind === 'header' ? DAY_HEIGHT : ROW_HEIGHT;
    const at = { length, offset, index };
    offset += length;
    return at;
  });
}

/**
 * What the empty list says to a screen reader: why nothing is here. The
 * screen itself shows a sleeping bud and no words.
 */
export function emptyLabel(filter: string, query: string): string {
  const search = query.trim();
  if (search) return copy.activity.noMatches(search);
  if (filter !== ALL) return copy.activity.noFiltered(filter);
  return copy.activity.empty;
}

// Held rather than rebuilt: this runs for every visible row.
const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

/** A row's time of day. Its date is the day header above it. */
export const timeLabel = (timestamp: number) => TIME.format(timestamp);
