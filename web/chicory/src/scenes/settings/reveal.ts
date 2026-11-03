import { useCallback, useMemo, useRef } from 'react';
import type { ComponentRef } from 'react';
import type { HostInstance, ScrollView } from 'react-native';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import type { SlotScroll } from '../../stage/panes/SceneSlot';
import { space } from '../../theme';

/*
 * Bringing a row that opens into view (REDESIGN.md 6, Settings). A row
 * near the foot of the page opened below the fold: its chevron turned and
 * nothing else on screen changed until the person scrolled. So as a row
 * opens, and as what it holds grows a lot by the person's own doing (Empty
 * wallet's form becoming its review, the servers' editor opening), the page
 * scrolls just far enough to show it: its header stays in view under the
 * title's fade, and as much of what it opened as fits shows below it.
 *
 * The page only ever scrolls down, toward what is out of view, and never
 * for a row already in view. It never scrolls a row's header out of view,
 * nor brings back one the person scrolled away, and it leaves the page
 * alone while a finger is on it or a fling is still gliding.
 */

/** How far under the title's fade an opened row's header stays. */
export const REVEAL_MARGIN = space.xs;

/**
 * How much a row's height must grow while it is open, in points, before
 * what it shows is brought into view again: more than a control's height,
 * so a line of error is left where it is, and a review or an editor is not.
 */
export const REVEAL_GROWTH = 48;

/** How often the slot reports its scroll, in ms: once a frame. */
export const SCROLL_THROTTLE = 16;

/** A move smaller than this, in points, is not worth making. */
const REVEAL_SLACK = 1;

/** Where a row is and what of the page is in view, in its content's points. */
export interface RevealGeometry {
  /** The row's top, its header's, from the top of what scrolls. */
  rowTop: number;
  /** The row's foot, below what it opened. */
  rowBottom: number;
  /** How far down the view the page is seen clearly: under the title's fade. */
  viewportTop: number;
  /** How far down the view the page is seen at all: above the home indicator. */
  viewportHeight: number;
  /** How far the page is scrolled now. */
  current: number;
  /** How far under `viewportTop` the row's header stays. */
  margin: number;
}

/**
 * Where to scroll so an opened row shows (see above), or null to stay: as
 * far down as brings the row's foot to the foot of the view, but no further
 * than keeps its header `margin` under the view's clear top. A row already
 * in view, a header already scrolled out of view, or a move of less than a
 * point stays where it is.
 */
export function revealOffset({
  rowTop,
  rowBottom,
  viewportTop,
  viewportHeight,
  current,
  margin,
}: RevealGeometry): number | null {
  if (viewportHeight <= viewportTop || rowBottom <= rowTop) return null;
  const foot = rowBottom - viewportHeight;
  const head = rowTop - viewportTop - margin;
  const target = Math.floor(Math.min(foot, head));
  return target > current + REVEAL_SLACK ? target : null;
}

/** What `reveal` measures: a view on the page, as a ref holds it. */
export type Revealable = Pick<HostInstance, 'measureLayout'>;

/**
 * Settings' scroll, for the slot it scrolls in (`SlotScroll`), and `reveal`,
 * which scrolls the page so the row `node` frames is in view (see above).
 * `top` is the band under the title that its fade covers, and `bottom` the
 * home indicator's, neither of which counts as in view.
 *
 * The row is measured where its layout will end up, against what scrolls,
 * not where a transition has drawn it so far, so a row still growing open
 * is brought into view at the size it is growing to, as the page and the
 * row move together. Under Reduce Motion the page moves at once.
 *
 * A row that asks before the page has been laid out is shown once it has.
 */
export function useReveal({ top, bottom }: { top: number; bottom: number }) {
  const { reduced } = useMotionPrefs();
  const view = useRef<ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  const height = useRef(0);
  // A finger is on the page, or a fling it gave is still gliding.
  const touching = useRef(false);
  const gliding = useRef(false);
  const waiting = useRef<Revealable | null>(null);
  // Read where it is used, so a reveal follows the setting as it changes.
  const still = useRef(reduced);
  still.current = reduced;
  const moving = () => touching.current || gliding.current;

  const reveal = useCallback(
    (node: Revealable | null) => {
      if (!node || moving()) return;
      const page = view.current;
      const content = page?.getInnerViewRef();
      if (!page || !content) return;
      if (height.current <= 0) {
        waiting.current = node;
        return;
      }
      node.measureLayout(
        content,
        (_left, rowTop, _width, rowHeight) => {
          if (moving()) return;
          const y = revealOffset({
            rowTop,
            rowBottom: rowTop + rowHeight,
            viewportTop: top,
            viewportHeight: height.current - bottom,
            current: offset.current,
            margin: REVEAL_MARGIN,
          });
          if (y !== null) page.scrollTo({ y, animated: !still.current });
        },
        () => {},
      );
    },
    [top, bottom],
  );

  const scroll = useMemo<SlotScroll>(
    () => ({
      ref: view,
      throttle: SCROLL_THROTTLE,
      onLayout: event => {
        height.current = event.nativeEvent.layout.height;
        const next = waiting.current;
        waiting.current = null;
        if (next) reveal(next);
      },
      onScroll: event => {
        offset.current = event.nativeEvent.contentOffset.y;
      },
      onScrollBeginDrag: () => {
        touching.current = true;
        gliding.current = false;
      },
      onScrollEndDrag: () => {
        touching.current = false;
      },
      onMomentumScrollBegin: () => {
        gliding.current = true;
      },
      onMomentumScrollEnd: event => {
        gliding.current = false;
        offset.current = event.nativeEvent.contentOffset.y;
      },
    }),
    [reveal],
  );

  return { scroll, reveal };
}
