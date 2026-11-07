import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { HostInstance } from 'react-native';
import { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { steady } from '../../motion/steady';
import { springs } from '../../motion/tokens';
import { restingRect } from '../../services/motion';

/**
 * The hand-over from Home's action circle to the scene it opens (REDESIGN.md
 * 7, T1 and T2). The tapped circle travels to where the scene draws its own
 * 88pt control and grows into it, whole all the way, and fades only once it
 * has landed, under the control that has come up over it in the same place,
 * so the two read as one element and never as two circles.
 *
 * `x` and `y` are that control's centre in window points: the bottom centre
 * of the slot (`launchLanding` in stage/layout) until the scene measures its
 * own (`useLaunchLanding`). `handover` runs from 0, while the circle is on
 * its way, to 1 once the control has taken over: Home starts it as the
 * circle arrives on the control (`landedAt`), and the canvas only makes
 * sure it comes, and turns it back to 0 as the scene leaves.
 */
export interface Launch {
  x: SharedValue<number>;
  y: SharedValue<number>;
  handover: SharedValue<number>;
}

const LaunchContext = createContext<Launch | null>(null);

export const LaunchProvider = LaunchContext.Provider;

const LandingArea = createContext('');

/**
 * What the canvas has laid the scenes out in, as a key that changes with it.
 * The window's own size changes a commit too soon: the column beside the
 * scene follows the canvas's measure, which comes after it.
 */
export const LandingAreaProvider = LandingArea.Provider;

/** The canvas's hand-over, or null off the canvas. */
export function useLaunch(): Launch | null {
  return useContext(LaunchContext);
}

/**
 * For a scene's primary control: a ref and an `onLayout` for the view that
 * holds it, so the circle that opened the scene lands on it exactly rather
 * than on the slot's bottom centre, and a `style` for an animated view
 * around it that holds the control unseen until the circle has landed and
 * hands over, so the two are never drawn apart. Off the canvas the ref and
 * the layout do nothing and the style shows the control.
 *
 * The control is read where layout puts it (`restingRect`), whatever is moving
 * it at the time, so the circle lands where it will rest. A row can move without
 * changing size, which fires no layout on the web, so it is read again whenever
 * the canvas's layout changes, or `moved` does, for a scene that pins its row
 * itself.
 */
export function useLaunchLanding(moved?: unknown) {
  const launch = useLaunch();
  const area = useContext(LandingArea);
  const style = useAnimatedStyle(
    () => ({ opacity: launch ? launch.handover.get() : 1 }),
    [launch],
  );
  const ref = useRef<HostInstance>(null);
  const onLayout = useCallback(() => {
    if (!launch || !ref.current) return;
    const { left, top, width, height } = restingRect(
      ref.current as unknown as Element,
    );
    if (!width || !height) return;
    launch.x.set(steady(withSpring(left + width / 2, springs.pane)));
    launch.y.set(steady(withSpring(top + height / 2, springs.pane)));
  }, [launch]);
  useEffect(onLayout, [onLayout, moved, area]);
  return { ref, onLayout, style };
}
