import { useCallback, useEffect, useState } from 'react';
import type {
  EntryAnimationsValues,
  EntryExitAnimationFunction,
  LayoutAnimation,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/*
 * Entrances that cannot leave a view hidden.
 *
 * On Android Reanimated can stall a layout animation as the app starts, and
 * the view it was entering keeps its first values for good. After one cold
 * launch on a phone, the activity sheet stayed below the screen and the
 * status dot at nothing, while the rest of the canvas built as it should. It
 * could not be made to happen again on demand; Reanimated's issue #9608 was
 * a stall of the same kind, fixed before the 4.7.0 the app uses.
 *
 * So an entrance that matters says when it has ended, and one that has not
 * ended within its grace is taken to have stalled: the view is drawn again,
 * under a new key and with no entrance, where it rests.
 */

/**
 * An entrance as the app's presets make it. A builder such as `FadeIn` is
 * shared by every view that takes it and `withCallback` changes it for all
 * of them, so a sure entrance is always a function.
 */
export type Entrance = EntryExitAnimationFunction;

/** `entering`, calling `ended` on the JavaScript thread once it has run. */
export function endingWith(entering: Entrance, ended: () => void): Entrance {
  const run = entering as (values: EntryAnimationsValues) => LayoutAnimation;
  const wrapped = (values: EntryAnimationsValues): LayoutAnimation => {
    'worklet';
    const animation = run(values);
    const own = animation.callback;
    return {
      initialValues: animation.initialValues,
      animations: animation.animations,
      callback: (finished: boolean) => {
        'worklet';
        if (own) own(finished);
        // Cancellation can leave the view at its hidden initial values.
        // Keep the grace timer armed until an entrance actually finishes.
        if (finished) scheduleOnRN(ended);
      },
    };
  };
  return wrapped;
}

/** Where an entrance stands: still going, over, or given up on. */
export type EntryState = 'entering' | 'ended' | 'stalled';

/**
 * A view's entrance, read once as it mounts, that is sure to leave it
 * shown: `entering` to pass to the view, and `key` to give it, which
 * changes, drawing the view again with no entrance, if `entering` has not
 * ended `grace` ms after mounting. No entrance has nothing to wait for.
 */
export function useSureEntry(
  entering: Entrance | undefined,
  grace: number,
): { entering: Entrance | undefined; key: string; state: EntryState } {
  const [state, setState] = useState<EntryState>(
    entering ? 'entering' : 'ended',
  );
  const ended = useCallback(
    () => setState(now => (now === 'entering' ? 'ended' : now)),
    [],
  );
  const [wrapped] = useState(() =>
    entering ? endingWith(entering, ended) : undefined,
  );
  useEffect(() => {
    if (state !== 'entering') return;
    const timer = setTimeout(
      () => setState(now => (now === 'entering' ? 'stalled' : now)),
      grace,
    );
    return () => clearTimeout(timer);
  }, [state, grace]);
  return {
    entering: state === 'stalled' ? undefined : wrapped,
    key: state === 'stalled' ? 'rested' : 'entering',
    state,
  };
}

/**
 * How long past the beat an entrance begins on it may take before it is
 * taken to have stalled: longer than any entrance runs, with room for the
 * long frames a cold start has.
 */
export const ENTRY_GRACE_MS = 2500;
