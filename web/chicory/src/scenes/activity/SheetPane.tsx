import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { FlatList } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copy } from '../../design/copy';
import { haptics } from '../../design/haptics';
import { palette } from '../../design/palette';
import { curves, durations, overlap } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { ActivityScreen } from '../../screens/wallet/Activity';
import type { SheetBinding } from '../../screens/wallet/Activity';
import type { RegionProps } from '../../stage/Canvas';
import type { CanvasSceneName } from '../../stage/layout';
import { usePaneActive, usePanes } from '../../stage/panes/Pane';
import { useSceneBack, useStage } from '../../stage/StageContext';
import { HIT_SLOP, radius } from '../../theme';
import { BackupShelf } from './BackupShelf';
import { ALL } from './model';
import type { ActivitySection } from './model';
import {
  DETAIL_DROP,
  DETAIL_FADE,
  GRIP_HEIGHT,
  ROW_RETURN_SPAN,
  filterFor,
  listShift,
  sheetProgress,
} from './sheet';
import { useSheetDrag } from './useSheetDrag';

const EXIT = { duration: durations.exit, easing: curves.exit };
const ENTER = { duration: durations.enter, easing: curves.enter };
const FADE = {
  duration: durations.crossfade,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};

/**
 * Everything on the sheet: a grip, and the one Activity list, which keeps its
 * instance, scroll and search from Home to Activity (REDESIGN.md 6, 7).
 *
 * At home the list is a still preview under the grip; opened, it scrolls, and
 * the filter bar has faded in above it. A drag moves the sheet between the
 * two, and the grip opens it with a tap. When a payment's detail grows out of
 * a row, or Send or Receive takes the canvas, the rows step back.
 */
export function SheetPane({
  shown,
  snapshot,
  session,
  view,
  backup,
}: RegionProps & {
  /** The scene the canvas shows. */
  shown: CanvasSceneName;
}) {
  const { state, actions } = useStage();
  const live = usePaneActive();
  const panes = usePanes();
  const { reduced } = useMotionPrefs();
  const { bottom } = useSafeAreaInsets();
  const opened = shown === 'activity';
  const sheet = shown === 'home' || opened;
  const drag = useSheetDrag(shown, live && sheet);
  const list = useRef<FlatList<ActivitySection>>(null);

  // An open search closes on Android back before the sheet does.
  const [searching, setSearching] = useState(false);
  const { query, setQuery } = view;
  const closeSearch = useCallback(() => {
    setQuery('');
    setSearching(false);
    return true;
  }, [setQuery]);
  useSceneBack(closeSearch, live && opened && (searching || !!query));

  // T4 and T1: the rows and the bar fade, and the rows drop under a detail,
  // as the canvas moves on, and come back once it has returned. Back from
  // Send or Receive the rows also come back in one after another, 25ms
  // apart, on a clock of their own (`rowReturn`).
  const shows = useSharedValue(sheet ? 1 : 0);
  const drop = useSharedValue(0);
  const rowsBack = useSharedValue(ROW_RETURN_SPAN);
  const before = useRef(shown);
  useLayoutEffect(() => {
    const from = before.current;
    before.current = shown;
    if (reduced) {
      shows.set(withTiming(sheet ? 1 : 0, FADE));
      drop.set(0);
      rowsBack.set(ROW_RETURN_SPAN);
      return;
    }
    if (sheet) {
      shows.set(withDelay(overlap.enterDelay, withTiming(1, ENTER)));
      drop.set(withDelay(overlap.enterDelay, withTiming(0, ENTER)));
      if (from === 'send' || from === 'receive') {
        rowsBack.set(0);
        rowsBack.set(
          withDelay(
            overlap.enterDelay,
            withTiming(ROW_RETURN_SPAN, {
              duration: ROW_RETURN_SPAN,
              easing: curves.linear,
            }),
          ),
        );
      }
    } else {
      shows.set(withTiming(0, shown === 'detail' ? DETAIL_FADE : EXIT));
      drop.set(shown === 'detail' ? withTiming(DETAIL_DROP, EXIT) : 0);
    }
  }, [sheet, shown, reduced, shows, drop, rowsBack]);

  // A payment's detail grows out of its row, and that row's ring and amount
  // are the ones that fly: the row steps out as the card appears, while the
  // rows around it fade and drop (T4). It is back as the list comes back.
  const lifted = useSharedValue('');
  const detailOf = state.scene.name === 'detail' ? state.scene.item.id : '';
  useLayoutEffect(() => {
    lifted.set(detailOf);
  }, [lifted, detailOf]);

  // The bar arrives over the last part of the way up, and the list gives
  // back the room it takes at home.
  const { home, compact } = panes.stops;
  const barStyle = useAnimatedStyle(() => {
    const progress = sheetProgress(panes.seam.get(), { home, compact });
    return { opacity: filterFor(progress) * shows.get() };
  }, [home, compact]);
  const listStyle = useAnimatedStyle(() => {
    const progress = sheetProgress(panes.seam.get(), { home, compact });
    return {
      opacity: shows.get(),
      transform: [{ translateY: listShift(progress) + drop.get() }],
    };
  }, [home, compact]);

  // Back home, the preview shows the newest payments, wherever the list
  // was scrolled to and whatever it was narrowed to: the bar that would say
  // so is gone there, and a preview that quietly left out a payment would
  // mislead.
  const was = useRef(shown);
  const { setFilter } = view;
  useLayoutEffect(() => {
    if (shown === 'home' && was.current !== 'home') {
      list.current?.scrollToOffset({ offset: 0 });
      setFilter(ALL);
      setQuery('');
      setSearching(false);
    }
    was.current = shown;
  }, [shown, setFilter, setQuery]);

  const binding: SheetBinding = {
    opened,
    barStyle,
    listStyle,
    gesture: drag.gesture,
    onScroll: drag.onScroll,
    listRef: list,
    rowsBack,
    lifted,
    searching,
    onSearching: setSearching,
    bottomInset: bottom,
  };

  return (
    <GestureDetector gesture={drag.gesture}>
      <View style={styles.fill} collapsable={false}>
        <Grip home={shown === 'home'} onOpen={actions.openActivity} />
        <ActivityScreen
          snapshot={snapshot}
          hidden={view.hidden}
          unit={view.unit}
          symbol={view.symbol}
          onDetail={actions.openDetail}
          filter={view.filter}
          onFilter={view.setFilter}
          query={query}
          onQuery={setQuery}
          refreshError={opened ? session.error : ''}
          onRetry={session.manualRefresh}
          // A recovery phrase still to save is pinned first on the open
          // list, as the shield that opens Settings, where the phrase and
          // its words are; back from there returns to the list. At home the
          // status row carries the shield.
          banner={
            opened && backup?.pending ? (
              <BackupShelf onOpen={actions.openSettings} />
            ) : undefined
          }
          sheet={binding}
        />
      </View>
    </GestureDetector>
  );
}

/**
 * The grip at the top of the sheet. At home it opens Activity with a tap; on
 * the open list it is only something to drag by.
 */
function Grip({ home, onOpen }: { home: boolean; onOpen: () => void }) {
  const live = usePaneActive();
  const grabber = <View style={styles.grabber} />;
  if (!home) {
    return (
      <View
        style={styles.grip}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {grabber}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.activity.sheet}
      hitSlop={HIT_SLOP}
      onPress={
        live
          ? () => {
              haptics.tick();
              onOpen();
            }
          : undefined
      }
      style={styles.grip}
    >
      {grabber}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grip: {
    height: GRIP_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: radius.round,
    backgroundColor: palette.husk,
  },
});
