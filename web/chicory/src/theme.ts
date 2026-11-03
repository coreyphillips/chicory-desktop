import { Platform } from 'react-native';
import type { TextStyle } from 'react-native';
import { formatSats, satsToBtcString } from '@beignet/wallet-core';
import type { PaymentStatus } from '@beignet/wallet-core';
import { palette } from './design/palette';

/**
 * One source of truth for the app's surfaces, spacing and type. Motion is
 * src/motion's.
 *
 * The colours are Chicory bloom (`src/design/palette.ts`) and no longer mirror
 * beignet-web's greys and coral. The redesign says most things with colour,
 * glyph and motion instead of prose, so the phone needs its own semantic set,
 * with the numbers that matter held to 7:1 contrast, rather than a browser
 * palette that leans on layout and words.
 *
 * `colors` keeps its old names as aliases of the new tokens, so screens that
 * have not been redrawn yet restyle at once. New code reads `palette`.
 *
 * The palette is deliberately dark-only. There is no light theme to fall back
 * to, so nothing here reads `useColorScheme`.
 */
export const colors = {
  // Structure, back to front.
  background: palette.roast,
  surface: palette.espresso,
  raised: palette.mocha,
  overlay: palette.cocoa,
  line: palette.husk,
  input: palette.bark,

  // Ink.
  text: palette.cream,
  muted: palette.steam,
  faint: palette.dust,
  ink: palette.ink,

  // Brand and semantics.
  primary: palette.bloom,
  mint: palette.sage,
  cream: palette.cream,
  warning: palette.honey,
  danger: palette.radish,

  // Tinted fills, so a notice, chip or icon tile can carry meaning without a
  // translucent overlay.
  primarySoft: palette.bloomSoft,
  mintSoft: palette.sageSoft,
  warningSoft: palette.honeySoft,
  dangerSoft: palette.radishSoft,
  neutralSoft: palette.creamSoft,
};

/** 4pt rhythm. Every gap, pad and inset in the app comes from here. */
export const space = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 44,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 24,
  xxl: 28,
  pill: 999,
  qr: 24,
  pane: 28,
  round: 999,
};

/**
 * `monospace` is an Android-only family alias. On iOS it is not a registered
 * family, so payment hashes, transaction ids, addresses and node URIs silently
 * fell back to the proportional system font. Menlo ships with iOS.
 */
export const fonts = {
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }) as string,
};

// Figures that change in place must not shift sideways as they change.
const TABULAR: TextStyle['fontVariant'] = ['tabular-nums'];

/**
 * Named type ramp. Sizes pair with a line height so blocks stack predictably.
 * The hero never uses `adjustsFontSizeToFit`; it steps down to 56, 48 and 40
 * by fitted width, so a balance never shrinks mid-roll.
 */
export const type = {
  hero: {
    fontSize: 64,
    lineHeight: 72,
    letterSpacing: -1.5,
    fontWeight: '300',
    fontVariant: TABULAR,
  },
  heroUnit: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  amount: {
    fontSize: 48,
    lineHeight: 56,
    fontWeight: '300',
    fontVariant: TABULAR,
  },
  amountDetail: {
    fontSize: 40,
    lineHeight: 48,
    fontWeight: '300',
    fontVariant: TABULAR,
  },
  line: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '400',
    fontVariant: TABULAR,
  },
  // Received rows are set at 600 and sent rows keep this 400, so direction
  // reads before the sign does.
  row: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '400',
    fontVariant: TABULAR,
  },
  meta: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '400',
    fontVariant: TABULAR,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    fontVariant: TABULAR,
  },
  word: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  keypad: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '300',
    fontVariant: TABULAR,
  },
  // The Whisper pill's words (REDESIGN.md rule 3).
  whisper: { fontSize: 13, lineHeight: 18 },

  // The Settings language, and the screens not yet redrawn.
  display: {
    fontSize: 60,
    lineHeight: 64,
    letterSpacing: -3,
    fontWeight: '400',
  },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '600' },
  heading: {
    fontSize: 21,
    lineHeight: 27,
    letterSpacing: -0.4,
    fontWeight: '600',
  },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 18, fontWeight: '400' },
  micro: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
    fontWeight: '600',
  },
  eyebrow: {
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 2.2,
    fontWeight: '700',
  },
} as const;

/** Minimum comfortable touch target, per the platform guidelines. */
export const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

/**
 * The least any control may be touched by (REDESIGN.md 3.4), its frame and
 * its hitSlop together.
 */
export const MIN_TARGET = 48;

/**
 * Display formatting for satoshi amounts.
 *
 * `formatSats` validates through `parseSats` before formatting, so a value that
 * is not a whole number of sats within the Bitcoin supply is refused rather
 * than rounded into a plausible-looking lie. This is a render path, so an
 * invalid amount becomes a visible placeholder instead of throwing: the wallet
 * should say it does not know, not crash or invent a figure.
 */
/**
 * Formatting an amount goes through ICU, and on Hermes it is constructing the
 * formatter that costs, not using it. Every visible row runs this on every
 * render, so the results are kept. The set of amounts on screen is small and
 * repeats constantly; the cap is only there so a long session cannot grow it
 * without bound.
 */
const SATS_CACHE = new Map<number, string>();
const SATS_CACHE_LIMIT = 512;
export const number = (value: number): string => {
  const cached = SATS_CACHE.get(value);
  if (cached !== undefined) return cached;
  let formatted: string;
  try {
    formatted = formatSats(value);
  } catch {
    return '-';
  }
  if (SATS_CACHE.size >= SATS_CACHE_LIMIT) SATS_CACHE.clear();
  SATS_CACHE.set(value, formatted);
  return formatted;
};

/** The same amount as a BTC string, for the unit toggle. Never a float. */
export const btc = (value: number): string => {
  try {
    return satsToBtcString(value);
  } catch {
    return '-';
  }
};

export type Unit = 'sats' | 'btc';

/** What a hidden amount shows, everywhere an amount can appear. */
export const MASK = '••••••';

/** Payment outcomes in the app's own words, never the raw wire enum. */
export const STATUS_LABELS: Record<PaymentStatus, string> = {
  completed: 'Completed',
  pending: 'In progress',
  uncertain: 'Needs checking',
  failed: 'Failed',
  expired: 'Expired',
};
export const statusLabel = (status: PaymentStatus): string =>
  STATUS_LABELS[status] ?? status;

/** The bitcoin sign, U+20BF. */
const BITCOIN_SIGN = '₿';

/**
 * What stands on either side of an amount's figures in `unit`. `symbol`
 * draws the integer face as BIP 177 does, `₿2,000` rather than `2,000 sats`:
 * the same integer, the sign before it and no word after it. BTC keeps its
 * suffix either way.
 */
export const unitAffixes = (
  unit: Unit,
  symbol = false,
): { prefix: string; suffix: string } =>
  unit === 'btc'
    ? { prefix: '', suffix: 'BTC' }
    : symbol
    ? { prefix: BITCOIN_SIGN, suffix: '' }
    : { prefix: '', suffix: 'sats' };

/**
 * The face a tap on the balance rolls to: the integer after the bitcoin sign,
 * then BTC, then sats, then the bitcoin sign again. The balance opens on the
 * bitcoin sign (`DEFAULT_FACE`).
 */
export const nextFace = (
  unit: Unit,
  symbol: boolean,
): { unit: Unit; symbol: boolean } =>
  unit === 'btc'
    ? { unit: 'sats', symbol: false }
    : symbol
    ? { unit: 'btc', symbol: false }
    : { unit: 'sats', symbol: true };

/**
 * How the bitcoin sign is set beside figures, as measured on a phone in each
 * platform's system face. SF Pro on iOS draws it at the weight asked for.
 * Android draws it at one weight whatever is asked, a little heavier than
 * the light figures, and taller against its figures than SF's, so each
 * platform has its own shares, chosen so the sign looks the same on both.
 *
 * - `display`: beside figures drawn on their own, as the odometer, the keypad
 *   and the quote draw them, the sign is this share of their size, about nine
 *   tenths of a figure's height.
 * - `text`: inside a line of text, standing on its baseline, the share at
 *   which the sign's top meets the figures' tops. At a display share it reads
 *   as a superscript there, and at the text's own size it overshoots them.
 * - `drop`: how far below the figures' middle the sign's glyph sits in its
 *   face, as a share of their size, when both are centred in one line box.
 * - `natural`: the face's own line height, as a share of its size, on a
 *   platform that centres text in its line box only when the box is at least
 *   that tall. iOS sets a line box any shorter from its top, so large figures
 *   in their tight box (72 for 64pt) ride half the shortfall high, 2.2pt,
 *   while the smaller sign, whose own line height fits, stays centred.
 * - `kern`: a display sign drawn in by this share of the figures' size, so the
 *   gap after it is the gap between two figures. SF leaves it 2pt wider at
 *   64pt; Roboto's is already theirs.
 */
const SIGN_SET = Platform.select({
  ios: { display: 0.75, text: 0.9, drop: 0, natural: 1.193, kern: 0.03 },
  default: { display: 0.7, text: 0.85, drop: 0.046, natural: 0, kern: 0 },
});

/** The bitcoin sign's share of figures drawn on their own (`SIGN_SET`). */
export const SYMBOL_SCALE = SIGN_SET.display;

/** The bitcoin sign's share of a line of text it stands in (`SIGN_SET`). */
export const TEXT_SYMBOL_SCALE = SIGN_SET.text;

/**
 * How far the bitcoin sign is raised beside figures set at `size` in a line
 * box `line` tall, so its middle is theirs (`SIGN_SET`): what its glyph
 * drops, and half of what the figures ride high in a box shorter than their
 * own line height.
 */
export const symbolLift = (size: number, line: number): number =>
  SIGN_SET.drop * size + Math.max(0, SIGN_SET.natural * size - line) / 2;

/**
 * The bitcoin sign beside light figures set at `size` on their own, in their
 * face and their line box `line` tall: at SYMBOL_SCALE of their size, a
 * weight heavier so its strokes, scaled down, are as thick as theirs, raised
 * so its middle is theirs (`symbolLift`), and drawn in to their spacing.
 * `scale` is how much the system's text size grows the figures, which the
 * lift and kern follow. Beside the mask's dots, which keep their own spacing,
 * it is not drawn in (`kern`).
 */
export const symbolBeside = (
  size: number,
  line: number,
  scale = 1,
  kern = true,
): TextStyle => ({
  fontSize: size * SIGN_SET.display,
  fontWeight: '400',
  marginRight: kern ? -SIGN_SET.kern * size * scale : 0,
  transform: [{ translateY: -symbolLift(size, line) * scale }],
});

/**
 * One amount, rendered in the unit the user chose, with what stands either
 * side of it (`unitAffixes`). A sign, where one is drawn, goes before the
 * prefix: `−₿2,000`.
 */
export const amountIn = (
  value: number,
  unit: Unit,
  symbol = false,
): { prefix: string; value: string; suffix: string } => ({
  ...unitAffixes(unit, symbol),
  value: unit === 'btc' ? btc(value) : number(value),
});

export const compact = (value: string, length = 12) =>
  value.length > length * 2 + 3
    ? `${value.slice(0, length)}…${value.slice(-length)}`
    : value;

// `toLocaleString` builds a formatter on every call. Held here instead, because
// these run once per visible row per render.
const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const DAY_MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

export const dateLabel = (timestamp: number) => DATE_TIME.format(timestamp);

const midnightOf = (value: Date) =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();

/**
 * Section headers in Activity: Today / Yesterday / a date.
 *
 * Cached by the local day a timestamp falls in, because a list of payments
 * spans a handful of days however long it is. The cache is dropped whenever
 * today moves, so "Today" cannot survive midnight.
 */
const DAY_CACHE = new Map<number, string>();
let dayCacheToday = Number.NaN;
export const dayLabel = (timestamp: number, now = Date.now()) => {
  const day = new Date(timestamp);
  const today = new Date(now);
  const todayMidnight = midnightOf(today);
  if (todayMidnight !== dayCacheToday) {
    dayCacheToday = todayMidnight;
    DAY_CACHE.clear();
  }
  const dayMidnight = midnightOf(day);
  const cached = DAY_CACHE.get(dayMidnight);
  if (cached !== undefined) return cached;
  const days = Math.round((todayMidnight - dayMidnight) / 86400000);
  const label =
    days <= 0
      ? 'Today'
      : days === 1
      ? 'Yesterday'
      : days < 7
      ? WEEKDAY.format(day)
      : day.getFullYear() === today.getFullYear()
      ? DAY_MONTH.format(day)
      : DAY_MONTH_YEAR.format(day);
  DAY_CACHE.set(dayMidnight, label);
  return label;
};
