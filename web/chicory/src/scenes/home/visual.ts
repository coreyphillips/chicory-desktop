import type { WalletRecord, WalletSnapshot } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import type { GlyphName } from '../../design/glyphs';
import type { HeldTint } from '../../stage/StageContext';

/**
 * How the vessel under the hero looks (REDESIGN.md 5, Vessel): a pill whose
 * solid part is what can be spent now and whose glass is what is on its way.
 * The glass's style says why that money is waiting, from the wallet's last
 * channelize decision and splice, so the vessel explains without a sentence.
 */
export interface VesselVisual {
  /**
   * A 2pt hairline when everything is spendable, 8pt with money in flight or
   * out of reach.
   */
  weight: 'hairline' | 'swollen';
  /** The spendable share of the pill, drawn solid bloom, from 0 to 1. */
  solid: number;
  /**
   * The share that cannot be sent now and is not on its way either
   * (`unreachableSats`), drawn hatched at the pill's left end. 0 when the
   * gap is no more than a channel reserve.
   */
  unreachable: number;
  /**
   * Why that share cannot be sent, as far as the snapshot tells:
   * `unplugged` while the primary is not connected, drawn honey under an
   * unplug; otherwise `held`, drawn in dust with no glyph. The totals alone
   * cannot tell a peer that is away from the reserve a large channel keeps
   * (1% of a channel the wallet holds little of can be much of what it
   * holds), so without a disconnection the vessel only shows the share and
   * never says a channel is away. Null when nothing is out of reach.
   */
  reach: 'unplugged' | 'held' | null;
  /**
   * The arriving share: bloom glass, dust seeds below the channel floor,
   * honey or radish glass when it is held up, or a sage wash once a splice
   * has been put back.
   */
  fill: 'glass' | 'seeds' | 'honey' | 'radish' | 'sage';
  /** The light across the glass: the usual sweep, slower, backwards, or none. */
  sheen: 'sweep' | 'slow' | 'reversed' | 'none';
  /** The glyph beside the pill that names the wait, if any, and its colour. */
  glyph: GlyphName | null;
  tone: 'bloom' | 'honey' | 'radish' | 'sage' | 'dust';
  /** A failed move is retried, and the refresh glyph wears a retry ring. */
  retry: boolean;
}

type Balance = Pick<
  WalletSnapshot['balance'],
  'availableSats' | 'pendingSats'
> &
  Partial<Pick<WalletSnapshot['balance'], 'totalSats'>>;
type Lfbw = WalletRecord['lfbw'];

/**
 * How much of the balance a channel reserve can explain, as a share of the
 * total and a floor in sats. Past both, the gap is money out of reach.
 *
 * The total counts all of the wallet's Lightning money, while what can be
 * sent is what its node can send now, so the two always differ by the
 * reserve each channel keeps: 1% of the channel by default in CLN and LND,
 * and never less than the dust limit, 546 sats. A wallet-funded channel
 * holds about all of its capacity, so its reserve is about 1% of what it
 * holds. The device pass measured 984 of 88,488 (1.1%) on one channel and
 * 546 of 29,475 (1.85%, the dust floor) on another. Twice the reserve's
 * share covers a channel the wallet holds half of, and the floor covers the
 * dust minimum on a small channel and the commitment fee a funder keeps
 * back, with room to spare. A peer that is away takes its whole channel out
 * of reach, which the pass saw as 95,034 of 123,963 and 84,488 of 84,488,
 * far past either.
 */
export const RESERVE_SHARE = 0.02;
export const RESERVE_FLOOR_SATS = 1_000;

/**
 * The Lightning money that cannot be sent now and is not on its way either,
 * in sats: what the total holds past what can be sent and what is arriving
 * (wallet-core counts the total as Lightning plus everything pending, and
 * what can be sent as what the node can send). A channel reserve alone is
 * never counted: only a gap more than RESERVE_SHARE of the total plus
 * RESERVE_FLOOR_SATS, which a reserve cannot explain, as when the peer of
 * a channel holding the money is away. 0 without a total.
 */
export function unreachableSats(balance: Balance): number {
  const { totalSats } = balance;
  if (totalSats === undefined) return 0;
  const gap =
    totalSats -
    Math.max(0, balance.availableSats) -
    Math.max(0, balance.pendingSats);
  const reserve = RESERVE_SHARE * totalSats + RESERVE_FLOOR_SATS;
  return gap > reserve ? gap : 0;
}

/** Waits that clear by themselves once a transaction confirms. */
const CONFIRMING = new Set(['splicing', 'channel-pending', 'unconfirmed']);
/** Decisions that are moving money into the channel right now. */
const MOVING = new Set(['splice-in', 'open', 'open-v2']);

/**
 * The least the wallet moves into its channel, in sats: wallet-core's
 * CHANNELIZE_FLOOR_SATS, which it does not export. Less than this on chain
 * stays put until more arrives.
 */
export const CHANNEL_FLOOR_SATS = 25_000;

/**
 * The vessel for a balance and the wallet's lightning-first record.
 *
 * The channelize decision rides on the record long after its money has
 * moved, so it only styles the glass while money is actually in flight. A
 * splice conflict or revert is kept on the record only while it is worth
 * telling, so it shows whenever it is there. Failures come first, then what
 * needs attention, then plain explanations.
 *
 * Below the floor is the one decision that does not say where the money in
 * flight is. The engine weighs only what is on chain, so once a channel open
 * or a splice has taken the deposit, it records below the floor while that
 * money confirms into the channel. Seeds are for a deposit too small to move
 * and nothing more: with the floor's worth or more in flight, or a payer's
 * transfer growing the channel, the money is committed, and it waits for its
 * confirmation.
 *
 * Money out of reach (`unreachableSats`) swells the pill too, and takes its
 * share of it beside the spendable part and the glass. What the glass looks
 * like still answers only for the money in flight.
 */
export function vesselVisual(
  balance: Balance,
  lfbw: Lfbw,
  connected = true,
): VesselVisual {
  const available = Math.max(0, balance.availableSats);
  const pending = Math.max(0, balance.pendingSats);
  const away = unreachableSats(balance);
  const inFlight = pending > 0;
  const whole = available + away + pending;
  const plain: VesselVisual = {
    weight: inFlight || away > 0 ? 'swollen' : 'hairline',
    solid: whole > 0 ? available / whole : 1,
    unreachable: whole > 0 ? away / whole : 0,
    reach: away > 0 ? (connected ? 'held' : 'unplugged') : null,
    fill: 'glass',
    sheen: inFlight ? 'sweep' : 'none',
    glyph: null,
    tone: 'bloom',
    retry: false,
  };
  const last = inFlight ? lfbw?.lastChannelize : undefined;
  const splice = lfbw?.lastSplice;
  const decided = last?.action === 'wait' ? last.reason ?? '' : null;
  const committed =
    pending >= CHANNEL_FLOOR_SATS || (inFlight && !!lfbw?.unpairedFunding);
  const wait =
    decided === 'below-floor' && committed ? 'channel-pending' : decided;

  if (last?.action === 'failed') {
    return {
      ...plain,
      fill: 'radish',
      sheen: 'none',
      glyph: 'refresh',
      tone: 'radish',
      retry: true,
    };
  }
  if (splice?.state === 'conflicted') {
    return {
      ...plain,
      fill: 'honey',
      sheen: 'reversed',
      glyph: 'rewind',
      tone: 'honey',
    };
  }
  if (wait === 'fee-too-high') {
    return {
      ...plain,
      fill: 'honey',
      sheen: 'none',
      glyph: 'gauge',
      tone: 'honey',
    };
  }
  if (wait === 'below-floor') {
    return { ...plain, fill: 'seeds', sheen: 'none', tone: 'dust' };
  }
  if (inFlight && lfbw?.unpairedFunding) {
    return { ...plain, glyph: 'inflow' };
  }
  if (wait !== null && CONFIRMING.has(wait)) {
    return { ...plain, sheen: 'slow', glyph: 'clock' };
  }
  if (last && MOVING.has(last.action)) {
    return { ...plain, glyph: 'sprout' };
  }
  if (splice?.state === 'reverted') {
    return {
      ...plain,
      fill: 'sage',
      sheen: 'none',
      glyph: 'rewind',
      tone: 'sage',
    };
  }
  return plain;
}

type Snapshot = Pick<WalletSnapshot, 'wallet' | 'primary' | 'activity'>;

/** Anything off mainnet: play money, drawn in slate so it never passes for real. */
export const isTestNetwork = (network: string) => network !== 'mainnet';

/** Where the wallet's lightning setup is: under way, done, or stopped short. */
export type Setup = 'pending' | 'ready' | 'failed';

/**
 * A wallet without lightning-first funding has no setup to wait for, so it
 * counts as ready. A setup error means it stopped, whatever the status says.
 */
export function setupOf(snapshot: Pick<Snapshot, 'wallet' | 'primary'>): Setup {
  const { wallet, primary } = snapshot;
  if (wallet.lfbw?.enabled === false || primary.setup === 'ready') {
    return 'ready';
  }
  if (primary.setupError || primary.setup === 'failed') return 'failed';
  return 'pending';
}

/** The state of the wallet the status row reads, beyond the snapshot. */
export interface HealthInput {
  snapshot: Pick<Snapshot, 'wallet' | 'primary'>;
  /** The balance is too old to spend against. */
  stale: boolean;
  /** A refresh is under way. */
  refreshing: boolean;
  /** The engine is still starting, so the figures are the saved ones. */
  connecting: boolean;
  /** Why the last refresh failed, or empty when it worked. */
  error: string;
  /** A recovery phrase is still to be saved. */
  backupPending: boolean;
}

/**
 * How the bloom mark in the status row looks (REDESIGN.md 6, Wallet
 * health): the mark says how the wallet is, and its PulseDot how the
 * connection is.
 */
export interface MarkVisual {
  /** Ratchets while a refresh runs, and breathes while setup is under way. */
  mode: 'still' | 'breathe' | 'ratchet';
  /**
   * What a breath moves: the centre alone while setup is under way, with the
   * petals held still at .6, and otherwise the whole flower.
   */
  breath: 'whole' | 'center';
  /** How far the petals are open: .6 during setup, all the way once ready. */
  open: number;
  /**
   * Slate on a test network, whatever else holds; otherwise dormant while
   * the balance is old.
   */
  tone: 'live' | 'test' | 'dormant';
  /** The honey halo of a recovery phrase still to save. */
  halo: boolean;
  /** Setup stopped short: the petals droop and a honey pip sits on the mark. */
  droop: boolean;
  /** The flask micro glyph beside the mark on a test network. */
  flask: boolean;
  pulse: 'live' | 'reconnecting' | 'failed';
}

/**
 * Whether the wallet has answered lately. A snapshot's own `connected` is
 * only as new as the snapshot: figures from a cached launch, or ones old
 * enough to be gated, say nothing about the connection now, and the dot
 * waits for a live read before it turns sage again. Settings' card and its
 * Primary node row read the connection by the same rule, so the page and
 * the mark never disagree about it.
 */
export const answering = ({
  snapshot,
  stale,
  connecting,
}: Pick<HealthInput, 'snapshot' | 'stale' | 'connecting'>) =>
  snapshot.primary.connected && !stale && !connecting;

export function markVisual(input: HealthInput): MarkVisual {
  const { snapshot, stale, refreshing, connecting, error } = input;
  const setup = setupOf(snapshot);
  const test = isTestNetwork(snapshot.wallet.network);
  return {
    mode:
      refreshing || connecting
        ? 'ratchet'
        : setup === 'pending'
        ? 'breathe'
        : 'still',
    breath: setup === 'pending' ? 'center' : 'whole',
    open: setup === 'pending' ? 0.6 : setup === 'failed' ? 0.8 : 1,
    // A test network's outline outlasts an old balance: slate replaces bloom
    // everywhere (REDESIGN.md 6), and the hero, the actions and the dot
    // still say the balance is old.
    tone: test ? 'test' : stale ? 'dormant' : 'live',
    halo: input.backupPending,
    droop: setup === 'failed',
    flask: test,
    pulse: error ? 'failed' : answering(input) ? 'live' : 'reconnecting',
  };
}

/**
 * Everything the mark shows, in words, for its accessibility value and its
 * whisper: the connection, how old the balance is, the setup, the network
 * when it is not mainnet, and a backup still to save. A failed refresh says
 * what the notice above Home used to say, with the engine's reason.
 */
export function healthText(input: HealthInput): string {
  const { snapshot, stale, refreshing, connecting, error } = input;
  const setup = setupOf(snapshot);
  const { network } = snapshot.wallet;
  return [
    error
      ? copy.health.refreshFailedDetail(error)
      : answering(input)
      ? copy.health.fresh
      : copy.health.reconnecting,
    stale
      ? connecting || refreshing
        ? copy.health.cached
        : copy.health.stale
      : '',
    setup === 'pending' ? copy.health.setupPending : '',
    setup === 'failed'
      ? [copy.health.setupFailed, snapshot.primary.setupError ?? ''].join(' ')
      : '',
    isTestNetwork(network) ? copy.health.testNetwork(network) : '',
    input.backupPending ? copy.health.backupPending : '',
  ]
    .map(part => part.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * The top pane's light (REDESIGN.md 3.2): which colour the bloom glow takes,
 * whether an old balance dims it, and the one lasting state tint. The tints
 * that flash, sage for money arriving and radish for a failure, come from
 * events rather than from a state, so they are not here.
 */
export interface BackdropVisual {
  glow: 'bloom' | 'slate';
  dim: boolean;
  tint: HeldTint | null;
}

/**
 * Honey while something needs attention: a backup to save or a payment
 * whose outcome is unknown. Night while an offline request is open and
 * still unexpired as of the snapshot, the one sign of offline receive the
 * wallet itself records. `held` is the tint a scene holds through the
 * stage's tint channel, such as night while Receive has offline chosen, or
 * honey while Send shows an outcome the wallet has not read yet. Honey is a
 * safety state, so it wins over night whoever holds either.
 */
export function backdropVisual({
  snapshot,
  stale,
  backupPending,
  held = null,
}: {
  snapshot: Pick<Snapshot, 'wallet' | 'activity'> & { updatedAt: number };
  stale: boolean;
  backupPending: boolean;
  held?: HeldTint | null;
}): BackdropVisual {
  const uncertain = snapshot.activity.some(item => item.status === 'uncertain');
  const offline = snapshot.activity.some(
    item =>
      item.kind === 'request' &&
      item.status === 'pending' &&
      !!item.receiveRequest?.offlineReceive &&
      item.receiveRequest.expiresAt > snapshot.updatedAt,
  );
  return {
    glow: isTestNetwork(snapshot.wallet.network) ? 'slate' : 'bloom',
    dim: stale,
    tint:
      backupPending || uncertain || held === 'honey'
        ? 'honey'
        : offline || held === 'night'
        ? 'night'
        : null,
  };
}
