import React, { useCallback, useEffect } from 'react';
import type { Ref } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { HostInstance, StyleProp, ViewStyle } from 'react-native';
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  AnimatedStyle,
  EntryAnimationsValues,
  EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { copy } from '../../design/copy';
import { Glyph } from '../../design/glyphs';
import type { GlyphName } from '../../design/glyphs';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { riseIn, sceneOut } from '../../motion/presets';
import { curves, durations, springs } from '../../motion/tokens';
import { motionReduced } from '../../services/motion';
import { usePrimary } from '../../stage/panes/Primary';
import { HIT_SLOP, radius, space } from '../../theme';
import { ALL, FILTERS } from './model';
import { BAR_HEIGHT } from './sheet';

/**
 * The filter bar over the list (REDESIGN.md 6, filters): a glyph chip for each
 * kind of payment, and a search glyph that opens into the field. Tapping the
 * chosen chip again shows everything.
 *
 * `usable` is false while the bar is out of reach, at home under the preview,
 * and then it takes no touches and a screen reader passes over it. A refresh
 * that failed puts a radish retry at its end. On a test network, `test`, the
 * field's caret is slate where it would be bloom.
 */
export function FilterBar({
  usable,
  filter,
  onFilter,
  query,
  onQuery,
  searching,
  onSearching,
  refreshError,
  onRetry,
  test = false,
  style,
}: {
  usable: boolean;
  filter: string;
  onFilter: (value: string) => void;
  query: string;
  onQuery?: (value: string) => void;
  searching: boolean;
  onSearching: (open: boolean) => void;
  refreshError?: string;
  onRetry?: () => void;
  test?: boolean;
  style?: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;
}) {
  // A search with words in it stays open wherever the list goes.
  const open = !!onQuery && (searching || !!query);
  // A screen reader lands on the first filter as the list opens, or on the
  // field while a search is open, since the filters are not drawn then.
  const primary = usePrimary();
  const holdField = useCallback(
    (field: HostInstance | null) => {
      primary.current = field;
    },
    [primary],
  );
  const close = () => {
    onQuery?.('');
    onSearching(false);
  };
  return (
    <Reanimated.View
      style={[styles.bar, style]}
      pointerEvents={usable ? 'auto' : 'none'}
      accessibilityElementsHidden={!usable}
      importantForAccessibility={usable ? 'auto' : 'no-hide-descendants'}
    >
      {open ? (
        <Reanimated.View
          key="search"
          entering={searchOpens()}
          exiting={sceneOut()}
          style={styles.search}
        >
          <Glyph name="search" size={18} color={palette.steam} />
          <TextInput
            ref={holdField}
            accessibilityLabel={copy.activity.search}
            style={styles.field}
            value={query}
            editable={usable}
            onChangeText={usable ? onQuery : undefined}
            onBlur={() => {
              if (!query) onSearching(false);
            }}
            autoFocus={searching && !query}
            selectionColor={test ? palette.slate : palette.bloom}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          <GlyphButton
            glyph="close"
            label={copy.activity.clearSearch}
            onPress={usable ? close : undefined}
          />
        </Reanimated.View>
      ) : (
        <Reanimated.View
          key="chips"
          entering={riseIn(0)}
          exiting={sceneOut()}
          style={styles.chips}
        >
          {FILTERS.map(({ value, glyph }, index) => (
            <FilterChip
              key={value}
              ref={index === 0 ? primary : undefined}
              glyph={glyph}
              label={copy.activity.filters[value]}
              selected={filter === value}
              onPress={
                usable
                  ? () => onFilter(filter === value ? ALL : value)
                  : undefined
              }
            />
          ))}
          <View style={styles.spacer} />
          {refreshError ? (
            <GlyphButton
              glyph="refresh"
              color={palette.radish}
              label={copy.activity.refreshFailed(refreshError)}
              hint={copy.activity.retry}
              onPress={usable ? onRetry : undefined}
            />
          ) : null}
          {onQuery ? (
            <GlyphButton
              glyph="search"
              label={copy.activity.search}
              onPress={usable ? () => onSearching(true) : undefined}
            />
          ) : null}
        </Reanimated.View>
      )}
    </Reanimated.View>
  );
}

/** How wide the search glyph is, which the field grows out of. */
const GLYPH_WIDTH = 40;

/**
 * The field growing leftward out of the search glyph at the bar's end, on
 * the standard curve. Under Reduce Motion it fades in where it stands.
 */
function searchOpens(): EntryExitAnimationFunction {
  if (motionReduced()) return riseIn(0);
  return (values: EntryAnimationsValues) => {
    'worklet';
    const config = { duration: durations.move, easing: curves.standard };
    return {
      initialValues: {
        originX: values.targetOriginX + values.targetWidth - GLYPH_WIDTH,
        width: GLYPH_WIDTH,
        opacity: 0,
      },
      animations: {
        originX: withTiming(values.targetOriginX, config),
        width: withTiming(values.targetWidth, config),
        opacity: withTiming(1, config),
      },
    };
  };
}

/**
 * One filter. The chosen one sits on a mocha disc that springs in behind its
 * glyph, and a screen reader hears it as selected.
 */
function FilterChip({
  glyph,
  label,
  selected,
  onPress,
  ref,
}: {
  glyph: GlyphName;
  label: string;
  selected: boolean;
  onPress?: () => void;
  ref?: Ref<HostInstance>;
}) {
  const on = useSharedValue(selected ? 1 : 0);
  useEffect(() => {
    on.set(withSpring(selected ? 1 : 0, springs.snap));
  }, [selected, on]);
  const disc = useAnimatedStyle(() => ({
    opacity: on.get(),
    transform: [{ scale: 0.7 + 0.3 * on.get() }],
  }));
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      hitSlop={HIT_SLOP}
      onPress={
        onPress &&
        (() => {
          haptics.tick();
          onPress();
        })
      }
      style={styles.chip}
    >
      <Reanimated.View style={[styles.disc, disc]} />
      <Glyph
        name={glyph}
        size={18}
        color={selected ? palette.cream : palette.steam}
      />
    </Pressable>
  );
}

/** A bare glyph that does one thing, named for a screen reader. */
function GlyphButton({
  glyph,
  label,
  hint,
  color = palette.steam,
  onPress,
}: {
  glyph: GlyphName;
  label: string;
  hint?: string;
  color?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={HIT_SLOP}
      onPress={
        onPress &&
        (() => {
          haptics.tick();
          onPress();
        })
      }
      style={({ pressed }) => [styles.glyphButton, pressed && styles.pressed]}
    >
      <Glyph name={glyph} size={20} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { height: BAR_HEIGHT, justifyContent: 'center' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: space.xxs },
  chip: {
    width: 44,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disc: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.round,
    backgroundColor: palette.mocha,
  },
  spacer: { flex: 1 },
  glyphButton: {
    width: GLYPH_WIDTH,
    height: 36,
    borderRadius: radius.round,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { backgroundColor: palette.mocha },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    height: 40,
    paddingLeft: space.sm,
    borderRadius: radius.round,
    backgroundColor: palette.mocha,
    overflow: 'hidden',
  },
  field: {
    flex: 1,
    fontSize: 15,
    color: palette.cream,
    paddingVertical: 0,
  },
});
