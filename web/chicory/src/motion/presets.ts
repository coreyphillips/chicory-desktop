import {
  FadingTransition,
  LinearTransition,
  ReduceMotion,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type {
  EntryAnimationsValues,
  EntryExitAnimationFunction,
  ExitAnimationsValues,
  LayoutAnimation,
  SharedValue,
  WithTimingConfig,
} from 'react-native-reanimated';
import { motionReduced } from '../services/motion';
import { steady } from './steady';
import { curves, durations, overlap, springs } from './tokens';

/**
 * Layout-animation presets for keyed children, so the incoming view mounts
 * first and the outgoing one unmounts after its fade (REDESIGN.md 3.5).
 *
 * Each preset is a function and reads Reduce Motion when it is called, which
 * is at render: a component that re-renders after the setting changes picks
 * up the calmer version. Under Reduce Motion every preset is a plain
 * crossfade of 160ms or less, because nothing should travel through space.
 *
 * Every one runs on a steady clock (`steady`): the frame that mounts what
 * enters can take a long while to paint, and an entrance counted by the
 * frames' clock would be over, or its delay spent, before it was seen.
 */

interface Pose {
  opacity: number;
  translateY: number;
  scale: number;
}

const SHOWN: Pose = { opacity: 1, translateY: 0, scale: 1 };
const HIDDEN: Pose = { ...SHOWN, opacity: 0 };

const EXIT: WithTimingConfig = {
  duration: durations.exit,
  easing: curves.exit,
};

function tween(
  from: Pose,
  to: Pose,
  config: WithTimingConfig,
  delay = 0,
): EntryExitAnimationFunction {
  return () => {
    'worklet';
    const toward = (value: number) =>
      steady(withDelay(delay, withTiming(value, config), config.reduceMotion));
    return {
      initialValues: {
        opacity: from.opacity,
        transform: [{ translateY: from.translateY }, { scale: from.scale }],
      },
      animations: {
        opacity: toward(to.opacity),
        transform: [
          { translateY: toward(to.translateY) },
          { scale: toward(to.scale) },
        ],
      },
    };
  };
}

/**
 * Reanimated drops an animation entirely when the system asks for reduced
 * motion. A crossfade is still wanted, so the change reads as a change rather
 * than a jump cut, and it moves nothing through space, so it opts out.
 */
function crossfade(from: Pose, to: Pose, duration = durations.crossfade) {
  return tween(from, to, {
    duration,
    easing: curves.standard,
    reduceMotion: ReduceMotion.Never,
  });
}

/** Fades in while rising `distance` points into place. */
export function riseIn(distance = overlap.rise, delay = 0) {
  if (motionReduced()) return crossfade(HIDDEN, SHOWN);
  return tween(
    { ...HIDDEN, translateY: distance },
    SHOWN,
    { duration: durations.enter, easing: curves.enter },
    delay,
  );
}

/**
 * Under Reduce Motion a scene hands over as the panes do (REDESIGN.md 8):
 * the outgoing one fades over the first half of a crossfade and the
 * incoming one over the second, so the two are never both drawn over each
 * other.
 */
const HALF = durations.crossfade / 2;

/** A scene's content, arriving once the outgoing content is on its way. */
export function sceneIn() {
  if (motionReduced()) {
    return tween(
      HIDDEN,
      SHOWN,
      {
        duration: HALF,
        easing: curves.standard,
        reduceMotion: ReduceMotion.Never,
      },
      HALF,
    );
  }
  return riseIn(overlap.rise, overlap.enterDelay);
}

/** A scene's content leaving: it fades and settles back slightly. */
export function sceneOut() {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, HALF);
  return tween(SHOWN, { ...HIDDEN, scale: 0.98 }, EXIT);
}

/**
 * Fades out where it stands, moving nothing: for a page that something laid
 * out to match it replaces, such as the loading page under the canvas.
 */
export function fadeOut() {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, HALF);
  return tween(SHOWN, HIDDEN, EXIT);
}

/**
 * Something another element takes the place of in the same frame, such as
 * the hold a result's mark grows out of (REDESIGN.md 6, Send): drawn whole
 * in the frame its exit starts, which is the frame the other appears over
 * it, and gone from the next, so the two are never seen apart and never
 * seen twice: a mark on its way is drawn over the hold from its first frame,
 * so the hold cannot stay a frame longer. Under Reduce Motion it fades as
 * its scene does.
 */
export function vanish(): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, HALF);
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 1 },
      animations: { opacity: withTiming(0, { duration: 1 }) },
    };
  };
}

/**
 * Something that may be taken over in the frame it leaves, or may not: the
 * hold a result's mark grows out of is, and the hold of a payment the engine
 * refuses is not, since its review goes back to compose with no mark. Which
 * it is gets decided in the render that removes it, so `taken` is read as
 * it leaves, not as it was last drawn: set, it vanishes (`vanish`); clear,
 * it stays whole and leaves with the scene round it, as it would with no
 * exit of its own.
 */
export function vanishIf(
  taken: SharedValue<boolean>,
): EntryExitAnimationFunction {
  // Neither of vanish's exits reads the values an exit is given.
  const gone = vanish() as () => LayoutAnimation;
  const stays = motionReduced() ? HALF : durations.exit;
  return () => {
    'worklet';
    if (taken.get()) return gone();
    return {
      initialValues: { opacity: 1 },
      animations: { opacity: withTiming(1, { duration: stays }) },
    };
  };
}

/** Fades out while dropping `distance` points, for rows giving way. */
export function dropOut(distance: number) {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, durations.exit);
  return tween(SHOWN, { ...HIDDEN, translateY: distance }, EXIT);
}

/**
 * A layer arriving over the canvas from its right edge on the pane spring, as
 * Settings does. It starts in the same frame as the pane springs, so the two
 * read as one move.
 */
export function slideIn(): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(HIDDEN, SHOWN);
  return (values: EntryAnimationsValues) => {
    'worklet';
    return {
      initialValues: { transform: [{ translateX: values.windowWidth }] },
      animations: {
        transform: [{ translateX: steady(withSpring(0, springs.pane)) }],
      },
    };
  };
}

/** The same layer leaving back off the right edge. */
export function slideOut(): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, durations.exit);
  return (values: ExitAnimationsValues) => {
    'worklet';
    return {
      initialValues: { transform: [{ translateX: 0 }] },
      animations: {
        transform: [
          { translateX: steady(withSpring(values.windowWidth, springs.pane)) },
        ],
      },
    };
  };
}

/*
 * The canvas's build as it arrives, and its leaving (REDESIGN.md 7, R-1 to
 * R-6). Each part enters on its own beat, `delay` ms after the canvas
 * mounts. Under Reduce Motion each is the plain crossfade.
 */

/** Something that comes up from `distance` points below, on the pane spring. */
export function riseFrom(
  distance: number,
  delay = 0,
): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(HIDDEN, SHOWN);
  return () => {
    'worklet';
    return {
      // Android initially hides entering views. Carry opacity through the
      // animation itself so visibility does not depend on its cleanup commit.
      initialValues: { opacity: 1, transform: [{ translateY: distance }] },
      animations: {
        opacity: 1,
        transform: [
          { translateY: steady(withDelay(delay, withSpring(0, springs.pane))) },
        ],
      },
    };
  };
}

/** Something that drops away below the bottom edge as the canvas leaves. */
export function dropAway(): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, durations.exit);
  return (values: ExitAnimationsValues) => {
    'worklet';
    return {
      initialValues: { transform: [{ translateY: 0 }] },
      animations: {
        transform: [
          {
            translateY: steady(
              withTiming(values.windowHeight, {
                duration: durations.move,
                easing: curves.exit,
              }),
            ),
          },
        ],
      },
    };
  };
}

/** Something that fades up in place. */
export function fadeIn(delay = 0): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(HIDDEN, SHOWN);
  return tween(
    HIDDEN,
    SHOWN,
    { duration: durations.enter, easing: curves.enter },
    delay,
  );
}

/**
 * A line that draws itself out from its middle, as the vessel does as the
 * wallet arrives.
 */
export function drawIn(delay = 0): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(HIDDEN, SHOWN);
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ scaleX: 0.2 }] },
      animations: {
        opacity: steady(
          withDelay(
            delay,
            withTiming(1, { duration: durations.enter, easing: curves.enter }),
          ),
        ),
        transform: [
          { scaleX: steady(withDelay(delay, withSpring(1, springs.soft))) },
        ],
      },
    };
  };
}

/** How far a control turns as it spins out or in, in degrees. */
const SPIN = 90;

/**
 * A control arriving where another is leaving, such as the corner's close
 * taking over from its cog (REDESIGN.md 7, T1): it turns in from a quarter
 * turn back, growing as it fades up, once the one it replaces is on its way.
 */
export function spinIn(): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(HIDDEN, SHOWN);
  return () => {
    'worklet';
    const config = { duration: durations.enter, easing: curves.enter };
    const toward = <T extends number | string>(value: T) =>
      steady(withDelay(overlap.enterDelay, withTiming(value, config)));
    return {
      initialValues: {
        opacity: 0,
        transform: [{ rotate: `${-SPIN}deg` }, { scale: 0.6 }],
      },
      animations: {
        opacity: toward(1),
        transform: [{ rotate: toward('0deg') }, { scale: toward(1) }],
      },
    };
  };
}

/** The control it replaces, turning on out of the way as it fades. */
export function spinOut(): EntryExitAnimationFunction {
  if (motionReduced()) return crossfade(SHOWN, HIDDEN, durations.exit);
  return () => {
    'worklet';
    return {
      initialValues: {
        opacity: 1,
        transform: [{ rotate: '0deg' }, { scale: 1 }],
      },
      animations: {
        opacity: steady(withTiming(0, EXIT)),
        transform: [
          { rotate: steady(withTiming(`${SPIN}deg`, EXIT)) },
          { scale: steady(withTiming(0.6, EXIT)) },
        ],
      },
    };
  };
}

/** For the few containers that change size: never LayoutAnimation. */
export function smooth() {
  if (motionReduced()) {
    return FadingTransition.duration(durations.crossfade).reduceMotion(
      ReduceMotion.Never,
    );
  }
  return LinearTransition.duration(durations.move).easing(curves.standard);
}

/**
 * The entering preset for the `index`th of a set of siblings. The step is
 * held between the overlap rule's bounds, so a long list cannot stretch the
 * handover past its budget by accident.
 */
export function stagger(index: number, step = overlap.staggerMin) {
  const gap = Math.min(overlap.staggerMax, Math.max(overlap.staggerMin, step));
  return riseIn(overlap.rise, overlap.enterDelay + index * gap);
}
