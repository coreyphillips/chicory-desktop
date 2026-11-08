import React, { memo } from 'react';
import Svg, { Path } from 'react-native-svg';
import { palette } from './palette';

export { GLYPH_LENGTHS } from './glyphLengths';

/**
 * Chicory's glyphs (REDESIGN.md 4): a 24 grid with 2 units of padding, round
 * caps and joins, and no fills. Outside Settings a glyph is often the whole
 * message, so each shape means one thing.
 *
 * A glyph is a list of parts, so an animated glyph can draw, turn or slide one
 * part on its own: the cross's second stroke, the clock's minute hand, the
 * chain's halves. A glyph that never moves in pieces is a single part named
 * after itself. A dot is a stroke .01 long whose round caps make the dot.
 *
 * scripts/glyph-lengths.mjs reads this table to generate GLYPH_LENGTHS, so it
 * stays plain literals, the constants just above it, and spreads of them.
 */
export interface GlyphPart {
  id: string;
  d: string;
}

const REFRESH: GlyphPart = {
  id: 'refresh',
  d: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
};
const LOCK_BODY: GlyphPart = { id: 'body', d: 'M6 11h12v9H6z' };
const CHAIN: GlyphPart[] = [
  { id: 'upper', d: 'M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7l-1 1' },
  { id: 'lower', d: 'M14 10a4 4 0 0 0-6-.5l-2 2a4 4 0 0 0 5.7 5.7l1-1' },
];

export const GLYPHS = {
  // Kept from the classic set.
  check: [{ id: 'check', d: 'm5 12 4 4L19 6' }],
  close: [{ id: 'close', d: 'm6 6 12 12M6 18 18 6' }],
  copy: [{ id: 'copy', d: 'M8 8H4v12h12v-4M8 4h12v12H8z' }],
  scan: [
    {
      id: 'scan',
      d: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16',
    },
  ],
  search: [
    { id: 'search', d: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4' },
  ],
  lock: [LOCK_BODY, { id: 'shackle', d: 'M9 11V8a3 3 0 0 1 6 0v3' }],
  key: [
    {
      id: 'key',
      d: 'M15 3a6 6 0 1 0-4.5 10.4L4 20v1h4v-2h2v-2h2l1.5-1.5A6 6 0 0 0 15 3zM16.5 7.5v.01',
    },
  ],
  shield: [
    { id: 'shield', d: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6' },
  ],
  eye: [
    { id: 'outline', d: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z' },
    { id: 'pupil', d: 'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z' },
  ],
  eyeOff: [
    {
      id: 'eyeOff',
      d: 'M4 4l16 16M10.6 10.7a2 2 0 0 0 2.8 2.8M6.7 6.8C3.9 8.5 2 12 2 12s3.6 6 10 6c1.7 0 3.2-.4 4.5-1M20.9 14.4C21.6 13.3 22 12 22 12s-3.6-6-10-6c-.6 0-1.2.1-1.7.2',
    },
  ],
  refresh: [REFRESH],
  bolt: [{ id: 'bolt', d: 'M13 3 5 14h6l-1 7 8-11h-6z' }],
  clock: [
    { id: 'face', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
    // Apart, so a clock that waits can turn its minute hand alone.
    { id: 'minute', d: 'M12 7v5' },
    { id: 'hour', d: 'M12 12l3 2' },
  ],
  share: [
    {
      id: 'share',
      d: 'M12 15V3m0 0L8 7m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
    },
  ],
  plus: [{ id: 'plus', d: 'M12 4v16M4 12h16' }],

  // Renamed: the old arrowUp, arrowDown and link.
  send: [{ id: 'send', d: 'M6 18 18 6M6 6h12v12' }],
  receive: [{ id: 'receive', d: 'M18 6 6 18M6 6v12h12' }],
  chain: CHAIN,

  // Settings only.
  alert: [{ id: 'alert', d: 'M12 4 2 20h20zM12 10v4M12 17.5v.5' }],
  info: [
    { id: 'info', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8v.5' },
  ],
  back: [{ id: 'back', d: 'M20 12H4m7-7-7 7 7 7' }],
  chevron: [{ id: 'chevron', d: 'm9 5 7 7-7 7' }],
  chevronDown: [{ id: 'chevronDown', d: 'm5 9 7 7 7-7' }],
  wallet: [
    {
      id: 'wallet',
      d: 'M6 5h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM3 9h18m-6 5h6M16 13.5a.5.5 0 1 0 0 1 .5.5 0 1 0 0-1z',
    },
  ],

  // New for the redesign.
  cog: [
    {
      id: 'cog',
      d: 'M10.04 5.18L10.23 2.87L13.77 2.87L13.96 5.18A7.1 7.1 0 0 1 15.44 5.79L17.2 4.29L19.71 6.8L18.21 8.56A7.1 7.1 0 0 1 18.82 10.04L21.13 10.23L21.13 13.77L18.82 13.96A7.1 7.1 0 0 1 18.21 15.44L19.71 17.2L17.2 19.71L15.44 18.21A7.1 7.1 0 0 1 13.96 18.82L13.77 21.13L10.23 21.13L10.04 18.82A7.1 7.1 0 0 1 8.56 18.21L6.8 19.71L4.29 17.2L5.79 15.44A7.1 7.1 0 0 1 5.18 13.96L2.87 13.77L2.87 10.23L5.18 10.04A7.1 7.1 0 0 1 5.79 8.56L4.29 6.8L6.8 4.29L8.56 5.79A7.1 7.1 0 0 1 10.04 5.18ZM12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
    },
  ],
  question: [
    {
      id: 'question',
      d: 'M9.2 9a2.8 2.8 0 1 1 4.2 2.4c-.9.6-1.4 1.2-1.4 2.2v.6M12 17.5v.01',
    },
  ],
  pause: [
    { id: 'left', d: 'M9 7v10' },
    { id: 'right', d: 'M15 7v10' },
  ],
  cross: [
    { id: 'first', d: 'm7.5 7.5 9 9' },
    { id: 'second', d: 'M16.5 7.5l-9 9' },
  ],
  bang: [
    { id: 'line', d: 'M12 5.5v8.5' },
    { id: 'dot', d: 'M12 18.5v.01' },
  ],
  moon: [
    {
      id: 'moon',
      d: 'M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1z',
    },
  ],
  unplug: [
    {
      id: 'left',
      d: 'M3 12h3M6 9.5h2.5a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5H6z',
    },
    {
      id: 'right',
      d: 'M21 12h-3M18 9.5h-2.5a1.5 1.5 0 0 0-1.5 1.5v2a1.5 1.5 0 0 0 1.5 1.5H18z',
    },
    { id: 'spark', d: 'M12 5.5v2M12 16.5v2' },
  ],
  infinity: [
    {
      id: 'infinity',
      d: 'M8 9.3c-3.6 0-3.6 5.4 0 5.4 2.6 0 5.4-5.4 8-5.4 3.6 0 3.6 5.4 0 5.4-2.6 0-5.4-5.4-8-5.4z',
    },
  ],
  clipboard: [
    {
      id: 'clipboard',
      d: 'M9 3.5h6v3H9zM9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2',
    },
  ],
  backspace: [
    {
      id: 'backspace',
      d: 'M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7zM12 9.5l5 5M17 9.5l-5 5',
    },
  ],
  qr: [
    {
      id: 'qr',
      d: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2',
    },
  ],
  sprout: [
    {
      id: 'sprout',
      d: 'M12 21v-8M12 13C12 9 9 7 5 7c0 4 3 6 7 6zM12 11c0-3.5 2.5-6 6.5-6 0 3.5-2.5 6-6.5 6z',
    },
  ],
  restore: [
    {
      id: 'restore',
      d: 'M4 12a8 8 0 1 0 2.3-5.6M4 4.5v4h4M10 10.5h5M10 13.5h3.5',
    },
  ],
  swap: [{ id: 'swap', d: 'M7 4 4 7l3 3M4 7h12M17 20l3-3-3-3M20 17H8' }],
  shieldAlert: [
    { id: 'shield', d: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z' },
    { id: 'mark', d: 'M12 8.5v4.5M12 16.2v.01' },
  ],
  twin: [
    {
      id: 'twin',
      d: 'M9.5 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM14.5 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
    },
  ],
  linkPlus: [...CHAIN, { id: 'plus', d: 'M18 15v5M15.5 17.5h5' }],
  gauge: [
    { id: 'dial', d: 'M4.5 17a8 8 0 1 1 15 0' },
    { id: 'needle', d: 'M12 13l3.5-3.5M12 13v.01' },
  ],
  rewind: [{ id: 'rewind', d: 'M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5' }],
  inflow: [
    {
      id: 'inflow',
      d: 'M12 3v10M8 9l4 4 4-4M5 14v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-3',
    },
  ],
  fund: [
    {
      id: 'fund',
      d: 'M7 5.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 8.5h8M17 5.5l3 3-3 3M4 16h16M4 20h16',
    },
  ],
  cameraOff: [
    {
      id: 'cameraOff',
      d: 'M4 4l16 16M9 5h6l1.5 2H19a1 1 0 0 1 1 1v8.5M16.5 19H5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h2M10.2 10.3a3 3 0 0 0 4.2 4.2',
    },
  ],
  faceScan: [
    {
      id: 'faceScan',
      d: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5V13h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0',
    },
  ],
  fingerprint: [
    {
      id: 'fingerprint',
      d: 'M8 5.5a7.5 7.5 0 0 1 11.5 6.5v1M4.5 10a7.5 7.5 0 0 1 1.3-3M4.5 14.5v-2M8.5 19a11 11 0 0 1-1-4.5V12a4.5 4.5 0 0 1 9 0v1.5M12 12v2.5a9 9 0 0 0 1.8 5.5M16.3 17.5a14 14 0 0 1-.3-3',
    },
  ],
  passcode: [
    {
      id: 'passcode',
      d: 'M7 9h.01M12 9h.01M17 9h.01M7 14h.01M12 14h.01M17 14h.01',
    },
  ],
  pencil: [{ id: 'pencil', d: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4' }],
  flask: [
    {
      id: 'flask',
      d: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 14h9',
    },
  ],
  hash: [{ id: 'hash', d: 'M10 4 8 20M16 4l-2 16M5 9h15M4 15h15' }],
  pin: [
    {
      id: 'pin',
      d: 'M12 21s7-6.2 7-11.5a7 7 0 1 0-14 0C5 14.8 12 21 12 21zM12 7.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    },
  ],
  boltRetry: [
    REFRESH,
    { id: 'bolt', d: 'M12.6 8.5 10 12.5h3l-.6 3 2.6-4h-3z' },
  ],
  orbit: [{ id: 'orbit', d: 'M12 4a8 8 0 1 1-8 8M12 4v.01' }],
  unlock: [LOCK_BODY, { id: 'shackle', d: 'M9 11V8a3 3 0 0 1 5.8-1.1' }],
  // A phone with a bar either side, apart so Settings can buzz the phone
  // and pop the bars as haptics turn on.
  haptics: [
    {
      id: 'body',
      d: 'M9.5 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    },
    { id: 'left', d: 'M4 9v6' },
    { id: 'right', d: 'M20 9v6' },
  ],
  // The scan frame's corners round a small bolt: a code that pays itself,
  // apart so Settings can close the frame and pop the bolt as Auto-pay turns
  // on.
  autoPay: [
    {
      id: 'frame',
      d: 'M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2',
    },
    { id: 'bolt', d: 'M12.4 6.6 7.6 13.2h3.6l-.6 4.2 4.8-6.6h-3.6z' },
  ],
  // Two columns of three dots: the handle a ranked primary node is dragged
  // by in Settings.
  grip: [
    {
      id: 'grip',
      d: 'M9.5 7v.01M14.5 7v.01M9.5 12v.01M14.5 12v.01M9.5 17v.01M14.5 17v.01',
    },
  ],
} satisfies Record<string, GlyphPart[]>;

export type GlyphName = keyof typeof GLYPHS;

/**
 * The way to the payment list from a result that is over: Send's completed
 * or held result and Receive's receipt draw it alike (REDESIGN.md 6). It is
 * `restore`, an arrow turning back round a list, the history's shape. Never
 * the orbit, which is money still in flight, and not `search`, which the
 * list it opens draws for its own field.
 */
export const HISTORY_GLYPH: GlyphName = 'restore';

/**
 * Stroke width in grid units by rendered size, interpolated between these
 * stops. A small glyph gets a relatively heavier stroke so it does not thin
 * out, and a large one a lighter stroke so it does not turn heavy.
 */
const STROKES: ReadonlyArray<readonly [size: number, width: number]> = [
  [16, 2.0],
  [20, 1.8],
  [24, 1.7],
  [32, 1.5],
  [48, 1.3],
];

export function strokeFor(size: number): number {
  let [fromSize, fromWidth] = STROKES[0];
  if (size <= fromSize) return fromWidth;
  for (const [toSize, toWidth] of STROKES) {
    if (size <= toSize) {
      const t = (size - fromSize) / (toSize - fromSize);
      return fromWidth + (toWidth - fromWidth) * t;
    }
    [fromSize, fromWidth] = [toSize, toWidth];
  }
  return fromWidth;
}

/**
 * Glyphs drawn heavier than the grid, relative to it. The passcode dots are
 * 2.6 at 24 against the grid's 1.7, so they read as keys rather than specks,
 * and they scale with size the same way.
 */
const WEIGHT: Partial<Record<GlyphName, number>> = { passcode: 2.6 / 1.7 };

/**
 * Memoized: its props are primitives, and a screen holds dozens of these, each
 * an SVG subtree that would otherwise rebuild whenever an ancestor rendered.
 * Hidden from assistive tech: the control or status that holds a glyph
 * carries its words.
 */
export const Glyph = memo(function GlyphSvg({
  name,
  size = 24,
  color = palette.cream,
  strokeWidth,
}: {
  name: GlyphName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth ?? strokeFor(size) * (WEIGHT[name] ?? 1)}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {GLYPHS[name].map(part => (
        <Path key={part.id} d={part.d} />
      ))}
    </Svg>
  );
});
Glyph.displayName = 'Glyph';
