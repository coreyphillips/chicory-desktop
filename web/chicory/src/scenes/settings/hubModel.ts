import type { WalletSnapshot } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import type { BloomBreath, BloomTone } from '../../glyphs/Bloom';
import { durations, overlap } from '../../motion/tokens';
import { answering, isTestNetwork, markVisual, setupOf } from '../home/visual';
import type { Setup } from '../home/visual';

/*
 * Settings as a grouped hub (REDESIGN.md 6, Settings), as plain data, so
 * each rule is a table test: which items the page draws and in what order,
 * where each row sits in its group's card, when each arrives, which row is
 * open, and what the card and the rows say.
 *
 * The page is one flat list of keyed items rather than cards that hold
 * rows. While the recovery phrase is still to be saved, its item leads the
 * page in honey; once saved it slides to the top of the Wallet group as the
 * same item, under the same key, so the view that moves is the one that was
 * there. A card that held its rows would have to hand the item from one
 * parent to another, and lay out a transition inside a transition.
 */

export { answering };

/** The rows of the hub: each is a setting, a way to look, or a way out. */
export type HubRow =
  | 'recovery'
  | 'primary'
  | 'network'
  | 'fullBackup'
  | 'applock'
  | 'haptics'
  | 'autopay'
  | 'empty'
  | 'leave'
  | 'erase'
  | 'diagnostics';

/** The groups the rows are gathered in, each under a header of its own. */
export type HubGroup = 'wallet' | 'phone' | 'funds' | 'help';

/**
 * Where a row sits in its group's card: alone in it, at its top, between
 * two others, or at its foot. The card is drawn by its rows, each rounding
 * only the corners at the card's edge, and each joined to the one above it
 * by a hairline.
 */
export type HubEdge = 'only' | 'first' | 'middle' | 'last';

/**
 * What an item is: the wallet's card, the recovery phrase leading the page
 * while it is still to be saved, a group's header, a row, or the versions
 * at the foot.
 */
export type HubKind = 'card' | 'lead' | 'header' | 'row' | 'about';

/** One item of the page, as `hubItems` lays it out. */
export interface HubEntry {
  /** Its key in the list, which stays its own wherever it moves. */
  key: string;
  kind: HubKind;
  /** The group it belongs to; the card and the versions belong to none. */
  group: HubGroup | null;
  /** The row it draws, for a row or the lead. */
  row: HubRow | null;
  /** Where it sits in its group's card; 'only' for anything not in one. */
  edge: HubEdge;
  /** Its step in the arrival cascade (`stagger`). */
  step: number;
}

/** What decides the page's items: whatever may or may not be drawn. */
export interface HubShape {
  /** The recovery phrase is still to be saved, so it leads the page. */
  lead: boolean;
  /** The engine can empty the wallet to an address. */
  drain: boolean;
  /** This phone can erase its wallets (device mode). */
  erase: boolean;
  /** The desktop host can save and restore a portable full backup. */
  fullBackup?: boolean;
}

/** The groups, top to bottom. */
export const GROUPS: readonly HubGroup[] = ['wallet', 'phone', 'funds', 'help'];

/**
 * How many steps the items cascade in as Settings arrives: the card first,
 * then the recovery phrase to save, or the Wallet group when there is none,
 * and everything after with the last step, so the whole page lands inside
 * the 350ms a handover may take (REDESIGN.md 3.5, the overlap rule).
 */
export const HUB_CASCADE = 2;

/** When the last of the page has landed, in ms from the slide's start. */
export const HUB_LANDS =
  overlap.enterDelay + HUB_CASCADE * overlap.staggerMin + durations.enter;

/** The rows of `group`, top to bottom, for a page of `shape`. */
export function rowsOf(group: HubGroup, shape: HubShape): HubRow[] {
  switch (group) {
    case 'wallet':
      return [
        ...(shape.lead ? [] : (['recovery'] as const)),
        'primary',
        'network',
        ...(shape.fullBackup ? (['fullBackup'] as const) : []),
      ];
    case 'phone':
      return ['applock', 'autopay'];
    case 'funds':
      return [
        ...(shape.drain ? (['empty'] as const) : []),
        'leave',
        ...(shape.erase ? (['erase'] as const) : []),
      ];
    case 'help':
      return ['diagnostics'];
  }
}

/** Where the `index`th of `count` rows sits in its card. */
export function edgeOf(index: number, count: number): HubEdge {
  if (count <= 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}

/** Whether a row at `edge` has another row of its card above it. */
export const joinedAbove = (edge: HubEdge) =>
  edge === 'middle' || edge === 'last';

/** Whether a row at `edge` has another row of its card below it. */
export const joinedBelow = (edge: HubEdge) =>
  edge === 'first' || edge === 'middle';

/**
 * Settings' items, top to bottom: the card, the recovery phrase to save
 * when there is one, then each group's header and rows, and the versions.
 * The recovery phrase keeps the key `recovery` whether it leads the page or
 * sits at the top of the Wallet group, so it moves as itself.
 */
export function hubItems(shape: HubShape): HubEntry[] {
  const items: HubEntry[] = [
    {
      key: 'card',
      kind: 'card',
      group: null,
      row: null,
      edge: 'only',
      step: 0,
    },
  ];
  let step = 1;
  if (shape.lead) {
    items.push({
      key: 'recovery',
      kind: 'lead',
      group: 'wallet',
      row: 'recovery',
      edge: 'only',
      step,
    });
    step += 1;
  }
  for (const group of GROUPS) {
    const rows = rowsOf(group, shape);
    items.push({
      key: `header:${group}`,
      kind: 'header',
      group,
      row: null,
      edge: 'only',
      step,
    });
    rows.forEach((row, index) =>
      items.push({
        key: row,
        kind: 'row',
        group,
        row,
        edge: edgeOf(index, rows.length),
        step,
      }),
    );
    step = Math.min(step + 1, HUB_CASCADE);
  }
  items.push({
    key: 'about',
    kind: 'about',
    group: null,
    row: null,
    edge: 'only',
    step: HUB_CASCADE,
  });
  return items;
}

/**
 * The row open after `id` is pressed, with `open` open now: the one pressed,
 * or none when it was the one open. One row is open at a time.
 */
export const nextOpen = (open: HubRow | null, id: HubRow): HubRow | null =>
  id === open ? null : id;

/** What the card's bloom and its status read of the wallet and the session. */
export interface CardInput {
  snapshot: Pick<WalletSnapshot, 'wallet' | 'primary'>;
  /** A refresh is under way. */
  refreshing: boolean;
  /** The engine is still starting, so the figures are the saved ones. */
  connecting: boolean;
  /** The balance is too old to spend against. */
  stale: boolean;
  /** The recovery phrase is still to be saved. */
  backupPending: boolean;
}

/** How the card's bloom looks. */
export interface CardBloom {
  /**
   * Ratchets while a refresh runs or the engine starts, which says
   * something is under way and never rests; otherwise it breathes, which
   * only decorates and rests with the ambient clock (REDESIGN.md 3.5).
   */
  mode: 'breathe' | 'ratchet';
  /** The centre alone breathes while setup is under way. */
  breath: BloomBreath;
  /** .6 while setup is under way, .8 and wilted once it failed, else 1. */
  open: number;
  /** Slate on a test network, dormant while an old balance shows on mainnet. */
  tone: BloomTone;
  /** The honey ring of a recovery phrase still to save. */
  halo: boolean;
  /** Setup stopped short: the petals droop, and a honey pip sits by them. */
  droop: boolean;
}

/**
 * The card's bloom: the status row's mark, larger, read the same way
 * (`markVisual`, REDESIGN.md 6, Wallet health), except that at rest it
 * breathes where the mark holds still, since here it has the room.
 */
export function cardBloom(input: CardInput): CardBloom {
  const mark = markVisual({ ...input, error: '' });
  return {
    mode: input.refreshing || input.connecting ? 'ratchet' : 'breathe',
    breath: mark.breath,
    open: mark.open,
    tone: mark.tone,
    halo: mark.halo,
    droop: mark.droop,
  };
}

/**
 * The mark beside a status: a sage dot while the primary node answers, a
 * honey one that breathes while it is sought, a still honey one where
 * something stopped short, an orbit while work is under way, a flask for a
 * test network, or nothing.
 */
export type StatusLook = 'live' | 'seeking' | 'stopped' | 'working' | 'test';

/** A status as a row or the card draws it, and as a screen reader hears it. */
export interface StatusWords {
  /** What is drawn. */
  words: string;
  /** The mark before the words, or none. */
  look: StatusLook | null;
  /** Honey words, for a state that needs attention. */
  attention: boolean;
  /** What a screen reader hears. */
  said: string;
}

const s = copy.settings;

/**
 * The card's status: whether the primary node answers (`answering`), or
 * that there is none.
 */
export function cardStatus(
  snapshot: Pick<WalletSnapshot, 'primary'>,
  live: boolean,
): StatusWords {
  if (!snapshot.primary.uri) {
    return {
      words: s.primary.none,
      look: null,
      attention: false,
      said: s.primary.none,
    };
  }
  const words = live ? s.card.connected : s.card.connecting;
  return {
    words,
    look: live ? 'live' : 'seeking',
    attention: false,
    said: words,
  };
}

/** Setup in the words the card adds after the connection, if any. */
function setupSaid(setup: Setup): string {
  if (setup === 'failed') return s.primary.setupFailedValue;
  return setup === 'pending' ? s.primary.setupPending : '';
}

/**
 * Everything the card shows, as one line for a screen reader: the wallet,
 * its network, that a test network's coins have no value, whether the
 * primary node answers, and a setup that is under way or stopped short,
 * which the bloom shows by its petals.
 */
export function cardWords({
  snapshot,
  live,
}: {
  snapshot: Pick<WalletSnapshot, 'wallet' | 'primary'>;
  live: boolean;
}): string {
  const { name, network } = snapshot.wallet;
  const status = [cardStatus(snapshot, live).said, setupSaid(setupOf(snapshot))]
    .filter(Boolean)
    .join('. ');
  return [
    s.card.summary(name, network),
    isTestNetwork(network) ? s.testNetwork(network) : '',
    status,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The Primary node row's value: Connected or Connecting by the same rule as
 * the card (`answering`), No primary configured without one, and Setup
 * failed in honey once setup has stopped short, which a screen reader hears
 * after the connection.
 */
export function primaryWords(
  snapshot: Pick<WalletSnapshot, 'wallet' | 'primary'>,
  live: boolean,
): StatusWords {
  const p = s.primary;
  if (!snapshot.primary.uri) {
    return { words: p.none, look: null, attention: false, said: p.none };
  }
  const connection = live ? p.connected : p.connecting;
  if (setupOf(snapshot) === 'failed') {
    return {
      words: p.setupFailedValue,
      look: 'stopped',
      attention: true,
      said: `${connection}. ${p.setupFailedValue}`,
    };
  }
  return {
    words: connection,
    look: live ? 'live' : 'seeking',
    attention: false,
    said: connection,
  };
}

/** The Network & servers row's value: the network, with a flask off mainnet. */
export function networkWords(network: string): StatusWords {
  return {
    words: network,
    look: isTestNetwork(network) ? 'test' : null,
    attention: false,
    said: network,
  };
}

/**
 * Where a drain shown in the wallet's history stands: under way, started
 * without the wallet confirming it did (a safety state, REDESIGN.md rule
 * 4), or neither, as Empty wallet reads it (`inProgress`).
 */
export type DrainState = 'underway' | 'unknown' | null;

export function drainState(activity: WalletSnapshot['activity']): DrainState {
  const drain = activity.find(
    row => row.drain && !['completed', 'failed'].includes(row.status),
  )?.drain;
  if (!drain || drain.phase === 'completed' || drain.phase === 'cancelled') {
    return null;
  }
  return drain.phase === 'review' ? 'unknown' : 'underway';
}

/**
 * The Empty wallet row's value: an orbit and Emptying while a drain is
 * under way, honey Status unknown while the wallet has not confirmed one
 * started, and nothing otherwise.
 */
export function drainWords(state: DrainState): StatusWords | null {
  if (state === 'underway') {
    return {
      words: s.empty.underway,
      look: 'working',
      attention: false,
      said: s.empty.underway,
    };
  }
  if (state === 'unknown') {
    return {
      words: s.empty.unknown,
      look: 'stopped',
      attention: true,
      said: s.empty.uncertainAnnouncement,
    };
  }
  return null;
}
