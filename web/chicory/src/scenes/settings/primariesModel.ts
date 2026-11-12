import type { PrimaryStatus } from '@beignet/wallet-core';
import { compact } from '../../theme';

/**
 * The fill target a wallet is given as it ranks a second primary node and
 * none was saved (coreyphillips/beignet#1924). Without one every receive
 * goes to rank 1 for as long as it answers, so a second node would hold
 * nothing until the first was away; with one, receives fill each node to
 * this amount in rank order before moving on to the next. The field under
 * the list shows it, prefilled, so it is the owner's to change.
 */
export const DEFAULT_FILL_TARGET_SATS = 1_000_000;

/** The fill target the field shows: the saved one, else the default. */
export function fillTargetShown(
  thresholdSat: number | null | undefined,
): number {
  return thresholdSat != null && thresholdSat > 0
    ? thresholdSat
    : DEFAULT_FILL_TARGET_SATS;
}

/** How far a node's bar is drawn, and what full would be. */
export interface Fill {
  /** 0 to 1 of the bar. */
  level: number;
  /** The sats a full bar stands for. */
  of: number;
  /** Several nodes: this one has reached the fill target. */
  full: boolean;
}

/**
 * How full a node is. With several nodes it is the balance held with the
 * node against the fill target, since that is what decides where the next
 * receive goes. With one node there is no target: the bar is the balance
 * against the channel capacity as the wallet knows it, the balance plus the
 * room left to receive, so it reads as how much of the channel is on this
 * side.
 */
export function fillOf(
  entry: Pick<PrimaryStatus, 'balanceSat'>,
  {
    total,
    target,
    receivableSats,
  }: { total: number; target: number; receivableSats: number },
): Fill {
  const balance = Math.max(0, entry.balanceSat);
  if (total <= 1) {
    const of = balance + Math.max(0, receivableSats);
    return { level: of > 0 ? balance / of : 0, of, full: false };
  }
  const of = Math.max(1, target);
  return { level: Math.min(1, balance / of), of, full: balance >= of };
}

/**
 * A Porch link (coreyphillips/beignet#1980): the node waits at a relay, and
 * its address is the relay's WebSocket URL, a fixed path and the node's
 * route id.
 */
const PORCH_LINK =
  /^([0-9a-fA-F]{66})@(wss?:\/\/[^/?#]+)(\/v1\/p\/)([^/?#]+)$/i;

/** The key, the relay, the path and the route id of a Porch link, or null. */
export function porchLinkParts(
  uri: string,
): { key: string; relay: string; path: string; route: string } | null {
  const match = PORCH_LINK.exec(uri.trim());
  if (!match) return null;
  const [, key, relay, path, route] = match;
  return { key, relay, path, route };
}

/**
 * Whether what is being typed or was scanned is headed for a Porch link:
 * a key and a WebSocket address. The form says what such a link means
 * before it is saved, so this does not wait for the whole link.
 */
export const looksLikePorchLink = (uri: string): boolean =>
  /@wss?:\/\//i.test(uri);

/**
 * A node's name in the list: its host and port, with the key left out,
 * since the key is for copying and the host is for recognising. An onion
 * host keeps its first and last characters and its `.onion`; an Iroh node
 * its id, shortened; a Porch node is named by its relay, without the route.
 * Anything that is not a node address is drawn as it is.
 */
export function hostLabel(uri: string): string {
  const porch = porchLinkParts(uri);
  if (porch) return porch.relay.toLowerCase();
  const match = /^[0-9a-fA-F]{66}@(.+?)(:\d+)?$/.exec(uri.trim());
  if (!match) return uri.trim();
  const [, host, port = ''] = match;
  if (/^iroh:/i.test(host)) {
    return `iroh:${compact(host.slice(5).split('?')[0], 6)}`;
  }
  if (/\.onion$/i.test(host)) {
    return `${compact(host.slice(0, -6), 6)}.onion${port}`;
  }
  return `${host}${port}`;
}

/** `order` with the item at `from` moved to `to`. */
export function moved<T>(order: readonly T[], from: number, to: number): T[] {
  const next = order.slice();
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) {
    return next;
  }
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Where each row's top is, with `gap` between rows. */
function topsOf(heights: readonly number[], gap: number): number[] {
  'worklet';
  const tops: number[] = [];
  let y = 0;
  for (let i = 0; i < heights.length; i++) {
    tops.push(y);
    y += heights[i] + gap;
  }
  return tops;
}

/**
 * The slot the row at `from` would land in, dragged `dy` down: it takes a
 * neighbour's place once its centre has passed that neighbour's centre, so
 * a row half dragged over the next one has not yet moved.
 */
export function slotAt(
  from: number,
  dy: number,
  heights: readonly number[],
  gap: number,
): number {
  'worklet';
  const n = heights.length;
  if (from < 0 || from >= n) return from;
  const tops = topsOf(heights, gap);
  const centre = tops[from] + heights[from] / 2 + dy;
  let to = from;
  if (dy > 0) {
    while (to < n - 1 && centre > tops[to + 1] + heights[to + 1] / 2) to++;
  } else {
    while (to > 0 && centre < tops[to - 1] + heights[to - 1] / 2) to--;
  }
  return to;
}

/**
 * How far the row at `index` moves out of the way while the row at `from`
 * is held over slot `to`: up by the held row's `size` when the held row is
 * passing down over it, down when passing up, else not at all.
 */
export function shiftOf(
  index: number,
  from: number,
  to: number,
  size: number,
): number {
  'worklet';
  if (index === from) return 0;
  if (from < index && index <= to) return -size;
  if (to <= index && index < from) return size;
  return 0;
}

/**
 * Where the held row comes to rest, as a translation from where it began,
 * once it is let go over slot `to`: the top of that slot in the new order.
 */
export function restingOffset(
  from: number,
  to: number,
  heights: readonly number[],
  gap: number,
): number {
  'worklet';
  if (to === from || from < 0 || from >= heights.length) return 0;
  const tops = topsOf(heights, gap);
  const at = Math.max(0, Math.min(heights.length - 1, to));
  if (at > from) return tops[at] + heights[at] - heights[from] - tops[from];
  return tops[at] - tops[from];
}
