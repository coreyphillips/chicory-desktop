/**
 * What the amount keypad does to an amount, as pure functions over its
 * digits, so every rule is a table test and the keypad only draws.
 *
 * Amounts are whole sats. The keypad can only produce digits, and anything
 * that reaches an amount from elsewhere, such as a preset or a request, is
 * reduced to its digits before it is read, which is exactly what `parseSats`
 * accepts.
 */

/** The supply fits in 16 digits of sats, so a 17th is never an amount. */
export const MOST_DIGITS = 16;

/** A key on the pad: a digit, or `back` to delete the last one. */
export type KeyName =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'back';

/**
 * How an amount sits against what it may be: fine, more than can be sent now
 * but not more than the wallet holds (the rest is still arriving), more than
 * it can ever be, such as the wallet's total or an offline cap, or under the
 * least it can be, such as an offline receive's floor.
 */
export type AmountTone = 'plain' | 'over-spendable' | 'over-total' | 'under';

export const digitsOnly = (value: string) => value.replace(/[^0-9]/g, '');

/** Leading zeros say nothing, so 05 is shown, and read out, as 5. */
const trimmed = (digits: string) => digits.replace(/^0+(?=\d)/, '');

/**
 * Digits grouped in thousands for the reader, as `number()` groups an amount.
 * It works on the digits themselves, so a 16 digit amount past what a
 * JavaScript number holds exactly is still shown exactly.
 */
export function grouped(digits: string): string {
  return trimmed(digitsOnly(digits)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The digits after pressing `key`, or null when the key is refused: a digit
 * past MOST_DIGITS. A zero before any other digit adds nothing, so it leaves
 * the amount as it was.
 */
export function pressKey(digits: string, key: KeyName): string | null {
  if (key === 'back') return digits.slice(0, -1);
  if (digits.length >= MOST_DIGITS) return null;
  if (key === '0' && /^0*$/.test(digits)) return digits;
  return digits + key;
}

/** Whether `digits` hold no amount yet: nothing, or only zeros. */
export const isBlank = (digits: string) => /^0*$/.test(digits);

/**
 * Whether `key` does nothing to an amount that is `blank`: a zero before any
 * other digit, or backspace with nothing to take away. Such a key is drawn
 * dimmed and told to a screen reader as disabled, rather than taking a press
 * and doing nothing.
 */
export function keyIdle(blank: boolean, key: KeyName): boolean {
  return blank && (key === '0' || key === 'back');
}

/**
 * The amount as cells, one per digit from the left, each carrying the
 * separator that follows it. A digit keeps its cell as others are keyed after
 * it, so only the digit that arrives or leaves moves.
 */
export function amountCells(digits: string): { key: string; text: string }[] {
  const shown = trimmed(digitsOnly(digits));
  if (!shown || /^0+$/.test(shown)) return [];
  const count = shown.length;
  return [...shown].map((digit, index) => {
    const left = count - 1 - index;
    return {
      key: `d${index}`,
      text: left > 0 && left % 3 === 0 ? `${digit},` : digit,
    };
  });
}
