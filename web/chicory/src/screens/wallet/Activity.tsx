import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type {
  FlatList as RNFlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { FlatList } from 'react-native-gesture-handler';
import type { PanGesture } from 'react-native-gesture-handler';
import Reanimated, { useSharedValue } from 'react-native-reanimated';
import type { AnimatedStyle, SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Activity, WalletSnapshot } from '@beignet/wallet-core';
import { palette } from '../../design/palette';
import { Bloom } from '../../glyphs/Bloom';
import { ActivityRow, RowListContext } from '../../scenes/activity/ActivityRow';
import type { RowList } from '../../scenes/activity/ActivityRow';
import { FilterBar } from '../../scenes/activity/FilterBar';
import { isTestNetwork } from '../../scenes/home/visual';
import {
  DAY_HEIGHT,
  activitySections,
  emptyLabel,
  sectionLayout,
} from '../../scenes/activity/model';
import type { ActivitySection } from '../../scenes/activity/model';
import { usePaneActive } from '../../stage/panes/Pane';
import type { Rect } from '../../stage/scene';
import { useStableActivity } from '../../stage/useStableActivity';
import { space, type as typography } from '../../theme';
import type { Unit } from '../../theme';

export { ActivityRow } from '../../scenes/activity/ActivityRow';

type Animated = StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;

/**
 * What the canvas's sheet hands the list it holds, so the list moves with the
 * sheet: whether it is the whole list or home's preview, the styles that fade
 * the bar in and make room for it, the drag the list scrolls alongside, and
 * where the list reports its scroll.
 */
export interface SheetBinding {
  /** The whole list, rather than the still preview at home. */
  opened: boolean;
  barStyle: Animated;
  listStyle: Animated;
  gesture: PanGesture;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  listRef: RefObject<RNFlatList<ActivitySection> | null>;
  searching: boolean;
  onSearching: (open: boolean) => void;
  /** The system bar's height, kept clear below the last row. */
  bottomInset: number;
  /** The clock of the rows coming back in, as the rows read it. */
  rowsBack?: SharedValue<number>;
  /** The payment whose detail has grown out of its row, or ''. */
  lifted?: SharedValue<string>;
}

/**
 * The full history (REDESIGN.md 6): the filter bar, then one list with the
 * payments that need attention pinned in a honey band at its top, and the
 * rest under their days. Empty, it is a sleeping bud and no words.
 *
 * On the canvas, `sheet` binds it to the sheet: at home it is a still preview
 * with the bar out of reach, and opened it scrolls. Drawn on its own, it is
 * the whole list.
 *
 * The list is a `FlatList` rather than rows in the app's ScrollView: a wallet
 * with hundreds of payments used to mount every row at once. Rows are fixed
 * heights, so it places any of them without measuring.
 */
export function ActivityScreen({
  snapshot,
  onDetail,
  filter,
  onFilter,
  query = '',
  onQuery,
  hidden = false,
  unit = 'sats',
  symbol = false,
  banner,
  refreshError,
  onRetry,
  sheet,
  liftedId,
}: {
  snapshot: WalletSnapshot;
  onDetail: (item: Activity, rect?: Rect) => void;
  filter: string;
  onFilter: (value: string) => void;
  query?: string;
  onQuery?: (value: string) => void;
  hidden?: boolean;
  unit?: Unit;
  /** Sats are drawn as `₿2,000` (`unitAffixes`). */
  symbol?: boolean;
  /** Something that must stay above the list, such as a pending backup. */
  banner?: ReactNode;
  /** Why the last refresh failed, when it did: a retry joins the bar. */
  refreshError?: string;
  onRetry?: () => void;
  sheet?: SheetBinding;
  liftedId?: string;
}) {
  const live = usePaneActive();
  const opened = sheet ? sheet.opened : true;
  const [searchingHere, setSearchingHere] = useState(false);
  const searching = sheet ? sheet.searching : searchingHere;
  const onSearching = sheet ? sheet.onSearching : setSearchingHere;

  // A poll that changed nothing a row shows hands back the same objects, so
  // the memoized rows stay put across it.
  const activity = useStableActivity(snapshot.activity);
  const test = isTestNetwork(snapshot.wallet.network);
  // Filtering trails typing by a frame. The field itself still binds `query`,
  // so it never feels behind; only the list waits.
  const needle = useDeferredValue(query).trim().toLowerCase();
  const rows = useMemo(
    () => activitySections(activity, filter, needle),
    [activity, filter, needle],
  );
  const layout = useMemo(() => sectionLayout(rows), [rows]);
  const getItemLayout = useCallback(
    (_: unknown, index: number) => layout[index],
    [layout],
  );

  // The ids this list has already shown. Until its first commit everything
  // counts as seen, so opening the list does not animate every row in.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    known.current = new Set(activity.map(item => item.id));
  }, [activity]);
  const back = sheet?.rowsBack;
  const selectedRow = useSharedValue(liftedId ?? '');
  useLayoutEffect(() => { selectedRow.set(liftedId ?? ''); }, [liftedId, selectedRow]);
  const lifted = sheet?.lifted ?? selectedRow;
  const rowList = useMemo<RowList>(
    () => ({
      seen: id => !known.current || known.current.has(id),
      back,
      lifted,
    }),
    [back, lifted],
  );

  // Stable identities, so the memoized rows can stay put across a keystroke
  // and across a background poll that changed nothing they show.
  const renderItem = useCallback(
    ({ item: row, index }: { item: ActivitySection; index: number }) =>
      row.kind === 'header' ? (
        <Text numberOfLines={1} maxFontSizeMultiplier={1.4} style={styles.day}>
          {row.label}
        </Text>
      ) : (
        <ActivityRow
          item={row.item}
          band={row.band}
          hidden={hidden}
          unit={unit}
          symbol={symbol}
          test={test}
          index={index}
          onPress={onDetail}
        />
      ),
    [hidden, unit, symbol, test, onDetail],
  );
  const { bottom } = useSafeAreaInsets();
  const inset = sheet ? sheet.bottomInset : bottom;

  return (
    <View style={styles.fill}>
      <View style={styles.edge}>
        <FilterBar
          usable={live && opened}
          filter={filter}
          onFilter={onFilter}
          query={query}
          onQuery={onQuery}
          searching={searching}
          onSearching={onSearching}
          refreshError={refreshError}
          onRetry={onRetry}
          test={test}
          style={sheet?.barStyle}
        />
      </View>
      <Reanimated.View style={[styles.fill, sheet?.listStyle]}>
        {banner ? <View style={styles.banner}>{banner}</View> : null}
        <RowListContext value={rowList}>
          <FlatList
            ref={sheet?.listRef}
            data={rows}
            keyExtractor={row => row.id}
            getItemLayout={getItemLayout}
            renderItem={renderItem}
            scrollEnabled={opened}
            simultaneousWith={sheet?.gesture}
            onScroll={sheet?.onScroll}
            scrollEventThrottle={32}
            // The sheet takes a pull down at the top, so the list does not
            // stretch there.
            bounces={false}
            overScrollMode="never"
            contentContainerStyle={[
              styles.content,
              { paddingBottom: inset + space.xxxl },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            removeClippedSubviews
            initialNumToRender={12}
            windowSize={9}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Bloom
                  size={72}
                  tone="dormant"
                  mode="breathe"
                  open={0.1}
                  accessibilityLabel={emptyLabel(filter, query)}
                />
              </View>
            }
          />
        </RowListContext>
      </Reanimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  edge: { paddingHorizontal: space.xl },
  banner: { paddingHorizontal: space.xl, paddingBottom: space.md },
  content: {
    paddingHorizontal: space.xl,
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
  },
  day: {
    ...typography.micro,
    height: DAY_HEIGHT,
    paddingTop: space.md,
    color: palette.dust,
    textTransform: 'uppercase',
  },
  empty: { alignItems: 'center', paddingTop: space.xxl },
});
