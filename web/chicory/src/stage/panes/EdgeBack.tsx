import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { PropsWithChildren } from 'react';
import { View, useWindowDimensions } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import type { PanGestureConfig } from 'react-native-gesture-handler';
import { withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { haptics } from '../../design/haptics';
import { springs } from '../../motion/tokens';
import { stageReducer } from '../scene';
import type { StageAction } from '../scene';
import { useStage } from '../StageContext';
import { usePaneActive, usePanes } from './Pane';

/** How far in from the left edge a finger can start the swipe, in points. */
export const EDGE = 28;

/**
 * How far across a swipe must be let go to go back, as a share of the
 * width, and how fast a fling must be, in points a second, to go back from
 * anywhere (REDESIGN.md 7, T5 and T6).
 */
export const RELEASE_AT = 0.4;
export const FLING = 800;

const BACK: StageAction = { type: 'back' };

/**
 * Whether a swipe let go `x` points across a layer `width` wide, at
 * `velocity` points a second, goes back.
 */
export function swipeGoesBack(
  x: number,
  width: number,
  velocity: number,
): boolean {
  'worklet';
  return x > 0 && (x > width * RELEASE_AT || velocity > FLING);
}

/**
 * A layer over the canvas that a swipe in from its left edge takes back,
 * as Settings is (REDESIGN.md 7, T6). The swipe writes the canvas's
 * `cover`, which the layer is drawn on (`SettingsSlide`) and the canvas
 * under it recedes by: the layer follows the finger across, the canvas
 * grows and brightens and the cog unwinds under it. Let go far enough or
 * fast enough, the stage goes back and the layer carries on off the edge
 * from where the finger left it; short of that, or when back would be
 * refused, both spring back.
 */
export function EdgeBack({
  style,
  children,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const panes = usePanes();
  const { state, actions, panes: motion } = useStage();
  const live = usePaneActive();
  const { width } = useWindowDimensions();

  // The stage as of this render, to tell whether back would be refused.
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);

  const release = useCallback(
    (goes: boolean) => {
      const refused =
        !!motion.current?.moving() ||
        stageReducer(latest.current, BACK) === latest.current;
      if (goes && !refused) {
        haptics.soft();
        actions.back();
        return;
      }
      panes.cover.set(withSpring(1, springs.pane));
    },
    [motion, actions, panes],
  );

  const config = useMemo<PanGestureConfig>(() => {
    const follow = (translationX: number) => {
      'worklet';
      const x = Math.max(0, translationX);
      panes.cover.set(1 - Math.min(1, x / width));
    };
    return {
      enabled: live,
      hitSlop: { left: 0, width: EDGE },
      activeOffsetX: 12,
      failOffsetY: [-16, 16],
      onActivate: event => {
        'worklet';
        follow(event.translationX);
      },
      onUpdate: event => {
        'worklet';
        follow(event.translationX);
      },
      onDeactivate: event => {
        'worklet';
        const x = Math.max(0, event.translationX);
        const goes =
          !event.canceled && swipeGoesBack(x, width, event.velocityX);
        scheduleOnRN(release, goes);
      },
    };
  }, [live, width, panes, release]);
  const swipe = usePanGesture(config);

  return (
    <GestureDetector gesture={swipe}>
      <View style={style}>{children}</View>
    </GestureDetector>
  );
}
