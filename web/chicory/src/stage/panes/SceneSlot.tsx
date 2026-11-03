import React from 'react';
import type {
  ComponentRef,
  PropsWithChildren,
  ReactElement,
  RefObject,
} from 'react';
import {
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type { RefreshControlProps, ScrollViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SLOT_PADDING } from '../layout';
import { usePrimary } from './Primary';

// Padding on both platforms. The app draws edge to edge on Android, where the
// window no longer shrinks for the keyboard (adjustResize does nothing), so
// without it the keyboard covered the lower fields: the Send amount sits under
// a long request. Padding only adds what the keyboard actually overlaps, so a
// window that does resize gets none.
const KEYBOARD_AVOIDING = 'padding' as const;

// How far a scene's content sits inside its slot, kept with the canvas's
// other measures and served here too, where the slot draws it.
export { SLOT_PADDING };

/**
 * For a scene that moves its own page, as Settings brings a row it opens
 * into view: a ref to the slot's scroll view, how often it reports its
 * scroll (`throttle`, in ms), and what it hears of the page's size, its
 * scroll and a finger on it.
 */
export type SlotScroll = Pick<
  ScrollViewProps,
  | 'onLayout'
  | 'onScroll'
  | 'onScrollBeginDrag'
  | 'onScrollEndDrag'
  | 'onMomentumScrollBegin'
  | 'onMomentumScrollEnd'
> & {
  ref: RefObject<ComponentRef<typeof ScrollView> | null>;
  throttle: number;
};

/**
 * A scrolling place for a whole scene, that keeps its fields above the
 * keyboard.
 *
 * `label` names the scene for a screen reader where a title bar used to: a
 * header it reaches first, which draws nothing. On the canvas that header is
 * the scene's primary element, where a screen reader lands as the scene
 * settles (`usePrimary`). `offset` is how far below the
 * top of the safe area the slot's parent starts, for a slot the canvas places
 * lower down. `scroll`, when given, lets the scene follow and move its own
 * page (`SlotScroll`); the keyboard is kept clear of the fields either way.
 */
export function SceneSlot({
  label,
  offset = 0,
  refreshControl,
  scroll,
  children,
}: PropsWithChildren<{
  label?: string;
  offset?: number;
  refreshControl?: ReactElement<RefreshControlProps>;
  scroll?: SlotScroll;
}>) {
  // The view measures itself against its parent, and the keyboard against the
  // window. Every slot's parent starts below the top inset, and `offset` below
  // that, so together they are the distance between the two.
  const insets = useSafeAreaInsets();
  const header = usePrimary();
  return (
    <KeyboardAvoidingView
      style={styles.slot}
      behavior={KEYBOARD_AVOIDING}
      keyboardVerticalOffset={insets.top + offset}
    >
      {label ? (
        <View
          ref={header}
          accessible
          accessibilityRole="header"
          accessibilityLabel={label}
          style={styles.title}
        />
      ) : null}
      <ScrollView
        ref={scroll?.ref}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={refreshControl}
        scrollEventThrottle={scroll?.throttle}
        onLayout={scroll?.onLayout}
        onScroll={scroll?.onScroll}
        onScrollBeginDrag={scroll?.onScrollBeginDrag}
        onScrollEndDrag={scroll?.onScrollEndDrag}
        onMomentumScrollBegin={scroll?.onMomentumScrollBegin}
        onMomentumScrollEnd={scroll?.onMomentumScrollEnd}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  slot: { flex: 1 },
  // A point rather than nothing: a screen reader passes over an element with
  // no size at all.
  title: { position: 'absolute', top: 0, left: 0, width: 1, height: 1 },
  content: {
    paddingHorizontal: SLOT_PADDING.side,
    paddingTop: SLOT_PADDING.top,
    paddingBottom: SLOT_PADDING.bottom,
    flexGrow: 1,
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
  },
});
