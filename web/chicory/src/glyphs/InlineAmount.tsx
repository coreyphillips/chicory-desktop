import React from 'react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { TEXT_SYMBOL_SCALE, amountIn } from '../theme';
import type { Unit } from '../theme';

/**
 * An amount's prefix inside a line of text set at `size`, the line's own
 * style carrying on around it: the bitcoin sign at TEXT_SYMBOL_SCALE of the
 * line, standing on its baseline, its top level with the figures' tops.
 * Nothing when there is no prefix.
 */
export function InlineSign({ prefix, size }: { prefix: string; size: number }) {
  if (!prefix) return null;
  return <Text style={{ fontSize: size * TEXT_SYMBOL_SCALE }}>{prefix}</Text>;
}

/**
 * One amount inside a line of text set at `size`: `₿2,000` with the sign
 * set as `InlineSign` sets it, and otherwise the one run it always was,
 * `2,000 sats` or `0.00002000 BTC`.
 */
export function inlineAmount(
  sats: number,
  unit: Unit,
  symbol: boolean,
  size: number,
): ReactNode {
  const shown = amountIn(sats, unit, symbol);
  if (!shown.prefix) return `${shown.value} ${shown.suffix}`;
  return (
    <>
      <InlineSign prefix={shown.prefix} size={size} />
      {shown.value}
    </>
  );
}
