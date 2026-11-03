import React, { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import type { HostInstance, StyleProp, ViewStyle } from 'react-native';
import Reanimated from 'react-native-reanimated';
import type { AnimatedStyle, SharedValue } from 'react-native-reanimated';
import type { Stops } from '../layout';
import { setBrowserInert } from '../../../../platform/browserFocus';

const PaneActive = createContext(true);

/**
 * Whether the pane this is drawn in is the one in use. A control reads it and
 * drops its handlers when it is not, so nothing can press what is hidden.
 * Outside any pane, as in Settings or a phase view, it is always true.
 */
export function usePaneActive(): boolean {
  return useContext(PaneActive);
}

/**
 * One layer of the canvas. A pane that is not in use stays drawn, so it can
 * move and fade on its way out, but it cannot be used: touches pass through
 * it, a screen reader skips it, and the controls inside drop their handlers.
 * Panes nest, and a pane is only in use while every pane around it is.
 */
export function Pane({
  active,
  style,
  children,
}: PropsWithChildren<{
  active: boolean;
  style?: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;
}>) {
  const live = usePaneActive() && active;
  const host = useRef<HostInstance>(null);
  useLayoutEffect(() => {
    if (Platform.OS === 'web') setBrowserInert(host.current, !live);
  }, [live]);
  return (
    <Reanimated.View
      ref={host}
      style={style}
      pointerEvents={live ? 'auto' : 'none'}
      accessibilityElementsHidden={!live}
      importantForAccessibility={live ? 'auto' : 'no-hide-descendants'}
    >
      <PaneActive.Provider value={live}>{children}</PaneActive.Provider>
    </Reanimated.View>
  );
}

/**
 * The canvas's motion, for anything drawn on it that moves with the panes.
 * `seam` is the sheet's top edge in points, `hero` runs from the mini strip
 * (0) to the full balance (1), `bar` is the action row's opacity, and `cover`
 * runs from nothing (0) to Settings over the whole canvas (1), and `scan`
 * likewise to the scan overlay open over it. `pull` is how
 * far a finger has pulled the home pane down, in points, and 0 whenever no
 * finger pulls: Home's pan writes it, and the status row's mark opens its
 * petals with it. `veil` is the clock of the crossfade that stands in for a
 * move under Reduce Motion, 1 at rest: the sheet and the balance take their
 * opacity from it (`veilOpacity`). The canvas always has one; a region drawn
 * on panes of its own, as a suite draws one, may leave it out. `stops` are
 * where the seam can rest at the canvas's current size.
 */
export interface Panes {
  seam: SharedValue<number>;
  hero: SharedValue<number>;
  bar: SharedValue<number>;
  cover: SharedValue<number>;
  scan: SharedValue<number>;
  pull: SharedValue<number>;
  veil?: SharedValue<number>;
  stops: Stops;
}

const PanesContext = createContext<Panes | null>(null);

export const PanesProvider = PanesContext.Provider;

/** The canvas this is drawn on. Throws outside one. */
export function usePanes(): Panes {
  const panes = useContext(PanesContext);
  if (!panes) throw new Error('usePanes is only available on the canvas.');
  return panes;
}

/**
 * The canvas this is drawn on, or null off it, for a control drawn both on
 * the canvas and over a shell phase.
 */
export function useCanvasPanes(): Panes | null {
  return useContext(PanesContext);
}
