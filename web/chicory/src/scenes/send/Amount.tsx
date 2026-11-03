import React from 'react';
import type { ComponentRef, Ref } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { copy } from '../../design/copy';
import { palette } from '../../design/palette';
import { Odometer } from '../../glyphs/Odometer';
import type { Unit } from '../../theme';
import { type as typography } from '../../theme';

/**
 * An amount of a payment at 48pt, with its unit, in `color`, drawn by the
 * odometer: in the unit the balance is shown in, sats as `₿2,000` with
 * `symbol` on, and as its six dots while amounts are hidden (`masked`). It
 * is one element to a screen reader, read as the amount in sats, or as
 * hidden. `ref` is that element, where a screen reader lands on a review.
 */
export function Amount({
  sats,
  unit = 'sats',
  symbol = false,
  masked = false,
  color = palette.cream,
  minimum = false,
  hint,
  ref,
}: {
  sats: number;
  unit?: Unit;
  symbol?: boolean;
  masked?: boolean;
  color?: string;
  minimum?: boolean;
  hint?: string;
  ref?: Ref<ComponentRef<typeof View>>;
}) {
  return (
    <View
      ref={ref}
      accessible
      accessibilityLabel={
        masked
          ? copy.amount.hidden
          : minimum
          ? copy.send.recipientAtLeast(sats)
          : copy.amount.spoken(sats)
      }
      accessibilityHint={hint}
    >
      {/* The odometer is its own element too; here the wrapper speaks. */}
      <View
        style={minimum ? styles.minimum : undefined}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {minimum && !masked ? (
          <Text style={[styles.sign, { color }]} maxFontSizeMultiplier={1.2}>
            ≥
          </Text>
        ) : null}
        <Odometer
          sats={sats}
          unit={unit}
          symbol={symbol}
          masked={masked}
          variant="amount"
          color={color}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  minimum: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sign: { ...typography.amount },
});
