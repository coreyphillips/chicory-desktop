import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { usePanGesture } from 'react-native-gesture-handler';
import type {
  PanGesture,
  PanGestureConfig,
} from 'react-native-gesture-handler';
import {
  ReduceMotion,
  cancelAnimation,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { haptics } from '../../design/haptics';
import { steady } from '../../motion/steady';
import { curves, durations, springs } from '../../motion/tokens';
import { useMotionPrefs } from '../../motion/useMotionPrefs';
import { SCENE_LAYOUT } from '../../stage/layout';
import type { CanvasSceneName } from '../../stage/layout';
import { usePanes } from '../../stage/panes/Pane';
import { stageReducer } from '../../stage/scene';
import type { StageAction } from '../../stage/scene';
import { useStage } from '../../stage/StageContext';
import {
  BAR_HEIGHT,
  GRIP_HEIGHT,
  barFor,
  dragSeam,
  pastThreshold,
  releaseOpens,
  sheetProgress,
} from './sheet';

/** A settle that still runs under Reduce Motion, where nothing should glide. */
const SETTLE_FADE = {
  duration: durations.crossfade,
  easing: curves.standard,
  reduceMotion: ReduceMotion.Never,
};

const OPEN: StageAction = { type: 'open', scene: { name: 'activity' } };
const HOME: StageAction = { type: 'home' };

/** The poses a release can settle into: the whole list, or home. */
const LIST_POSE = SCENE_LAYOUT.activity;
const HOME_POSE = SCENE_LAYOUT.home;

/**
 * Starts the sheet toward where a release leads, on the UI thread as the
 * finger lifts: the list's stop and pose when the release opens it, home's
 * when it does not, on the springs the canvas's own move uses. Waiting for
 * the JavaScript thread left the sheet held where the finger let go for as
 * long as the thread was busy, which as the wallet opens can be most of a
 * second. The move that follows from the JavaScript thread, the canvas's
 * own or the spring back a refused move gets, carries on from wherever this
 * has got to.
 */
export function settleOnRelease(
  panes: Pick<ReturnType<typeof usePanes>, 'seam' | 'hero' | 'bar'>,
  stops: { compact: number; home: number },
  opens: boolean,
  velocity: number,
): void {
  'worklet';
  const pose = opens ? LIST_POSE : HOME_POSE;
  const rest = opens ? stops.compact : stops.home;
  panes.seam.set(steady(withSpring(rest, { ...springs.pane, velocity })));
  panes.hero.set(steady(withSpring(pose.hero, springs.pane)));
  panes.bar.set(steady(withSpring(pose.bar, springs.pane)));
}

/**
 * The sheet's drag between home and the whole list (REDESIGN.md 7, T5).
 *
 * From home a drag anywhere on the sheet moves it, since the preview does not
 * scroll. From the list it moves only once the list is at its top and the
 * finger goes down, or when the drag began on the grip and the filter bar
 * above the list. Past either stop it rubber-bands, and while it moves the
 * balance shrinks and the action row fades with it.
 *
 * Let go, it goes where the finger threw it, or past 40% up or 25% down,
 * springing on with the finger's speed. A tick marks crossing the threshold
 * mid drag and a soft tap the snap. The stage then moves to the scene the
 * sheet landed on, through the same action a tap would dispatch, handed the
 * finger's speed, so the canvas's own spring carries on from the fling
 * rather than starting from rest.
 *
 * Returns the gesture, for the sheet and for the list to scroll alongside,
 * and `onScroll` for the list.
 */
export function useSheetDrag(shown: CanvasSceneName, enabled: boolean) {
  const panes = usePanes();
  const { state, actions, panes: motion } = useStage();
  const { reduced } = useMotionPrefs();
  const opened = shown === 'activity';

  // What the worklets read, kept current from render.
  const stops = useSharedValue(panes.stops);
  const open = useSharedValue(opened);
  const atTop = useSharedValue(true);
  useLayoutEffect(() => {
    stops.set(panes.stops);
    open.set(opened);
  }, [panes.stops, opened, stops, open]);

  // The drag in flight: where the seam began, whether the sheet has taken
  // the finger yet and at which translation, and which side of the threshold
  // it is on.
  const start = useSharedValue(0);
  const engaged = useSharedValue(false);
  const base = useSharedValue(0);
  const fromHeader = useSharedValue(false);
  const past = useSharedValue(false);

  // The stage as of this render, to tell whether the scene a release asks
  // for would be refused.
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);

  const settle = useCallback(
    (opens: boolean, velocity: number) => {
      const { seam, hero, bar } = panes;
      if (opens !== opened) {
        const action = opens ? OPEN : HOME;
        // The same refusals a tap meets: a pane still moving, or a reducer
        // that will not go there, such as while a payment is in flight.
        const goes =
          !motion.current?.moving() &&
          stageReducer(latest.current, action) !== latest.current;
        if (goes) {
          haptics.soft();
          if (opens) actions.openActivity({ velocity });
          else actions.home({ velocity });
          return;
        }
      }
      // Back where it began: the canvas has nothing new to aim for, so the
      // sheet puts itself and what moved with it back.
      const pose = SCENE_LAYOUT[opened ? 'activity' : 'home'];
      const rest = opened ? panes.stops.compact : panes.stops.home;
      if (reduced) {
        seam.set(withTiming(rest, SETTLE_FADE));
        hero.set(pose.hero);
        bar.set(withTiming(pose.bar, SETTLE_FADE));
        return;
      }
      // The UI spring has already taken the release velocity. Keep its
      // steady clock and current speed, without adding that velocity again.
      // A refused move aims back at the original stop on the same clock.
      settleOnRelease(panes, panes.stops, opened, 0);
    },
    [panes, opened, motion, actions, reduced],
  );

  const tick = useCallback(() => haptics.tick(), []);

  // Held across renders, so a poll or a keystroke that redraws the sheet
  // does not hand the gesture a new configuration.
  const config = useMemo<PanGestureConfig>(
    () => ({
      enabled,
      activeOffsetY: [-10, 10],
      failOffsetX: [-24, 24],
      onBegin: event => {
        'worklet';
        fromHeader.set(event.y < GRIP_HEIGHT + BAR_HEIGHT);
      },
      onActivate: event => {
        'worklet';
        past.set(false);
        // At home the sheet always takes the finger. Over the list it waits
        // for the list to be at its top, unless the drag began above it.
        const takes = !open.get() || fromHeader.get();
        engaged.set(takes);
        base.set(takes ? 0 : event.translationY);
        if (takes) {
          cancelAnimation(panes.seam);
          start.set(panes.seam.get());
        }
      },
      onUpdate: event => {
        'worklet';
        if (!engaged.get()) {
          // The list scrolls until it is back at its top with the finger still
          // going down; from there the sheet carries on from where it is.
          // Until then the sheet's own spring is left alone: a scroll that
          // never takes the sheet must not stop it halfway to its stop.
          if (!atTop.get() || event.translationY <= base.get()) {
            base.set(event.translationY);
            return;
          }
          engaged.set(true);
          cancelAnimation(panes.seam);
          start.set(panes.seam.get());
        }
        const at = stops.get();
        const seam = dragSeam(start.get(), event.translationY - base.get(), at);
        panes.seam.set(seam);
        const progress = sheetProgress(seam, at);
        panes.hero.set(1 - progress);
        panes.bar.set(barFor(progress));
        const crossed = pastThreshold(open.get(), progress);
        if (crossed !== past.get()) {
          past.set(crossed);
          scheduleOnRN(tick);
        }
      },
      onDeactivate: event => {
        'worklet';
        if (!engaged.get()) return;
        engaged.set(false);
        const progress = sheetProgress(panes.seam.get(), stops.get());
        const opens = releaseOpens(open.get(), progress, event.velocityY);
        // Under Reduce Motion a move is a crossfade the canvas runs, so the
        // sheet waits for it as before.
        if (!reduced)
          settleOnRelease(panes, stops.get(), opens, event.velocityY);
        scheduleOnRN(settle, opens, event.velocityY);
      },
    }),
    [
      enabled,
      settle,
      tick,
      panes,
      stops,
      open,
      atTop,
      start,
      engaged,
      base,
      fromHeader,
      past,
      reduced,
    ],
  );
  const gesture: PanGesture = usePanGesture(config);

  // The list reports its offset only as it crosses its top, which is all the
  // drag needs to know.
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const top = event.nativeEvent.contentOffset.y <= 0;
      if (top !== atTop.get()) atTop.set(top);
    },
    [atTop],
  );

  return { gesture, onScroll };
}
