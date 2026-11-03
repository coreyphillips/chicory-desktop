import { Easing } from 'react-native-reanimated';
import { GLYPHS } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { durations } from '../../motion/tokens';

/**
 * The timing and geometry the settings surfaces move by, as plain numbers so
 * each is a table test: how an outcome's glyph draws in (REDESIGN.md 4), and
 * the backup and restore flows (REDESIGN.md 6, Backup and setup).
 */

/** How one part of a glyph arrives: when, for how long, and whether it pops. */
export interface DrawStep {
  delay: number;
  duration: number;
  /** A dot pops on the reveal spring instead of drawing, having no length. */
  pop: boolean;
}

const drawn = (delay: number, duration: number): DrawStep => ({
  delay,
  duration,
  pop: false,
});

/**
 * How each part of `name` draws itself in (REDESIGN.md 4, Animated glyphs):
 * the cross is two 140ms strokes, the second 60ms behind the first, and the
 * bang's line draws in 200ms before its dot pops. Anything else, the check
 * included, draws all its parts together over 420ms.
 */
export function drawPlan(name: GlyphName): DrawStep[] {
  if (name === 'cross') return [drawn(0, 140), drawn(60, 140)];
  if (name === 'bang') {
    return [drawn(0, 200), { delay: 200, duration: 0, pop: true }];
  }
  return GLYPHS[name].map(() => drawn(0, durations.draw));
}

/** The recovery words rise in reading order, this far apart. */
export const WORD_STAGGER = 30;
/** How far each word rises as it fades in. */
export const WORD_RISE = 6;

/** When the word at `index` starts to rise, from the moment they are shown. */
export const wordDelay = (index: number) => index * WORD_STAGGER;

/**
 * Confirming the phrase is written down is a hold, and a longer one than a
 * payment's: it closes the only reminder there is.
 */
export const BACKUP_HOLD = 900;

/** The hold's fill: quick off the mark, then easing into the last stretch. */
export const HOLD_CURVE = Easing.bezier(0.35, 0, 0.25, 1);

/**
 * When the hold ramp plays each of its four steps, in ms from the press: a
 * tick at each of the first three quarters, and the commit at the fourth.
 */
export function holdSteps(duration: number): number[] {
  return [1, 2, 3, 4].map(step => (duration * step) / 4);
}

/** The words in a typed phrase, however it is spaced. */
export function countWords(phrase: string): number {
  return phrase.trim().split(/\s+/).filter(Boolean).length;
}

/** A short recovery phrase has this many words, and a long one twice it. */
export const RING = 12;

/**
 * Whether `count` typed words make a phrase: it is ready at exactly 12 or
 * 24, and over past 24. The bloom lights a petal per word (`lit`).
 */
export function phraseBloom(count: number): { ready: boolean; over: boolean } {
  return {
    ready: count === RING || count === 2 * RING,
    over: count > 2 * RING,
  };
}
