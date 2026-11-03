import type { Network } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import type { GlyphName } from '../../design/glyphs';
import type { BloomMode, BloomTone } from '../../glyphs/Bloom';
import type { BiometryKind } from '../../services/lock';
import { STATUS_ROW } from '../../stage/layout';
import type { Rect } from '../../stage/scene';
import { space } from '../../theme';

/**
 * What each shell phase draws for each of its states (REDESIGN.md 5 and 6),
 * as pure data, so the state-to-visual map is a table test and the views only
 * animate between answers they are given.
 */

/** The sizes the phases draw at, in points. */
export const SIZES = {
  /** The closed bud on the lock screen. */
  bud: 120,
  /** The loader and the transit bloom. */
  loader: 96,
  /** The status row's mark on the wallet canvas. */
  mark: 28,
  /** The welcome bloom, the largest thing the app draws. */
  welcome: 140,
  /** Glyph controls: the primary, a retry, the secondary and a cog. */
  primary: 72,
  retry: 64,
  secondary: 56,
  cog: 44,
} as const;

/**
 * A wait shorter than this shows nothing: the lock check and a quick open
 * stay plain roast rather than flashing a bud or a loader.
 */
export const QUIET_MS = 250;

/** How far the lock's bud is open: closed, with the tips just parting. */
export const BUD_OPEN = 0.08;

/**
 * How far a dormant bloom is open: at rest, most of the way, in husk and
 * bark. A wallet that is here but cannot be reached, saved or offline.
 */
export const DORMANT_OPEN = 0.7;

/**
 * The network the launch restore opens on, once the stage can know it: the
 * saved session's as soon as it has been read, or else the profile the
 * restore settles on, once it is no longer the `first` the session started
 * with, a stand-in. Null until then.
 */
export function openingNetwork(
  saved: { network?: Network } | null | undefined,
  profile: { network: Network },
  first: { network: Network },
): Network | null {
  if (saved?.network) return saved.network;
  return profile === first ? null : profile.network;
}

/**
 * The longest the opening loader holds back for the network it opens on,
 * before it shows in the tone it has.
 */
export const TONE_WAIT_MS = 1500;

/** Slate stands in for bloom on every network whose coins are not real. */
export function bloomTone(network: Network | null | undefined): BloomTone {
  return !network || network === 'mainnet' ? 'live' : 'test';
}

/** The glyph for the way this phone proves its owner; the passcode is the floor. */
export function unlockGlyph(kind: BiometryKind | null): GlyphName {
  switch (kind) {
    case 'face':
      return 'faceScan';
    case 'fingerprint':
      return 'fingerprint';
    case 'iris':
      return 'eye';
    default:
      return 'passcode';
  }
}

export interface LockVisual {
  /** What the glyph says to a screen reader and in the Whisper pill. */
  status: string;
  /** What the whole screen, the one control, says after its label. */
  value: string;
  /** The glyph draws itself over and over while the system prompt is up. */
  drawing: boolean;
  /** A refusal: the bud shakes and the glyph turns radish until the next try. */
  refused: boolean;
}

export function lockVisual({
  prompting,
  error,
}: {
  prompting: boolean;
  error: string;
}): LockVisual {
  return {
    status: error || copy.phase.locked,
    value: error ? `${copy.phase.locked}. ${error}` : copy.phase.locked,
    drawing: prompting,
    // A new prompt clears the error, so a refusal never shows mid-prompt.
    refused: !!error && !prompting,
  };
}

export type TransitKind = 'closing' | 'switching' | 'erasing';

export interface TransitVisual {
  kind: TransitKind;
  /** The sentence the old screen showed, now spoken. */
  label: string;
  /** The tone the bloom starts in, and the one it recolors toward. */
  from: BloomTone;
  to: BloomTone;
  mode: BloomMode;
}

export function transitVisual({
  erasing,
  closing,
  switchTarget,
  network,
}: {
  erasing: boolean;
  closing: boolean;
  switchTarget: Network | null;
  /** The network the wallet is on as the transit starts, when known. */
  network?: Network;
}): TransitVisual {
  const here = bloomTone(network);
  if (erasing) {
    return {
      kind: 'erasing',
      label: copy.phase.erasing,
      from: here,
      to: 'dormant',
      mode: 'still',
    };
  }
  if (closing) {
    return {
      kind: 'closing',
      label: copy.phase.closing,
      from: here,
      to: here,
      mode: 'still',
    };
  }
  return {
    kind: 'switching',
    label: copy.phase.switching(switchTarget),
    // Without the network it is leaving, the bloom starts where it will end.
    from: network ? here : bloomTone(switchTarget),
    to: bloomTone(switchTarget),
    mode: 'ratchet',
  };
}

export interface WelcomeControl {
  glyph: GlyphName;
  label: string;
}

export interface WelcomeVisual {
  /** How far the bloom is open once it has unfolded. */
  open: number;
  mode: BloomMode;
  /** The open failed, so the bloom half wilts. */
  wilted: boolean;
  /** The one big control, or none while the chase stands in for it. */
  primary: WelcomeControl | null;
}

/**
 * The first-run screen. `returning` is a wallet this phone remembers, which a
 * lock closed on purpose: opening it again is the way back, not a new wallet.
 */
export function welcomeVisual({
  error,
  opening,
  returning,
}: {
  error: string;
  opening: boolean;
  returning: boolean;
}): WelcomeVisual {
  if (opening) {
    return { open: 1, mode: 'chase', wilted: false, primary: null };
  }
  if (error) {
    return {
      open: 0.5,
      mode: 'still',
      wilted: true,
      primary: { glyph: 'refresh', label: copy.phase.tryAgain },
    };
  }
  return {
    open: 1,
    mode: 'breathe',
    wilted: false,
    primary: returning
      ? { glyph: 'unlock', label: copy.phase.tryAgain }
      : { glyph: 'sprout', label: copy.phase.createWallet },
  };
}

export interface Point {
  x: number;
  y: number;
}

/** Where the status row's mark sits in the window, at its centre. */
export function markPoint(insets: { top: number; left: number }): Point {
  return {
    x: insets.left + space.xl + SIZES.mark / 2,
    y: insets.top + STATUS_ROW / 2,
  };
}

/**
 * The offset and scale that put a view of `size` points, laid out with its
 * centre at `centre`, over the status row's mark: where the transit bloom
 * flies in from, and where the unlocked bloom flies off to.
 */
export function markFlight(
  mark: Point,
  centre: Point,
  size: number,
): { dx: number; dy: number; scale: number } {
  'worklet';
  return {
    dx: mark.x - centre.x,
    dy: mark.y - centre.y,
    scale: SIZES.mark / size,
  };
}

/**
 * The offset and scale that put a view laid out at `to` over `from`, both in
 * window points: where the loading page's mark starts, over the picker row it
 * was chosen from (R-2).
 */
export function flightFrom(
  from: Rect,
  to: Rect,
): { dx: number; dy: number; scale: number } {
  'worklet';
  return {
    dx: from.x + from.width / 2 - (to.x + to.width / 2),
    dy: from.y + from.height / 2 - (to.y + to.height / 2),
    scale: to.width > 0 ? from.width / to.width : 1,
  };
}

/** The Loading phase's wave: this many dots, each a step behind the last. */
export const WAVE = { dots: 5, step: 140, size: 10 } as const;

/** The unplug glyph's halves drift this far apart and back. */
export const UNPLUG_DRIFT = 1.5;
