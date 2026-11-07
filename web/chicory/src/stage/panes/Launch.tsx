import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { useWindowDimensions } from 'react-native';
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

/** The canvas's hand-over, or null off the canvas. */
export function useLaunch(): Launch | null {
  return useContext(LaunchContext);
}

/** How far apart two readings of the control may be and still agree. */
export const SETTLED_PT = 0.25;

/** The most frames the control is followed for, about 750ms. */
export const WATCH_FRAMES = 45;

/**
 * For a scene's primary control: a ref and an `onLayout` for the view that
 * holds it, so the circle that opened the scene lands on it exactly rather
 * than on the slot's bottom centre, and a `style` for an animated view
 * around it that holds the control unseen until the circle has landed and
 * hands over, so the two are never drawn apart. Off the canvas the ref and
 * the layout do nothing and the style shows the control.
 *
 * The control is read as it will rest, without the entrances of the step it
 * is drawn in (`restingRect`). They wait out a delay before they move, so two
 * readings would agree on a place the control only starts from, and the
 * circle would land short of it and hop to it as they handed over. What can
 * still move it is read again each frame, the circle's landing following it,
 * until two readings agree, and for WATCH_FRAMES at most. A row can move without
 * changing size, which fires no layout on the web, so it is read again whenever
 * the window changes, or `moved` does, for a scene that pins its row itself.
 */
export function useLaunchLanding(moved?: unknown) {
  const launch = useLaunch();
  const { width, height } = useWindowDimensions();
  const style = useAnimatedStyle(
    () => ({ opacity: launch ? launch.handover.get() : 1 }),
    [launch],
  );
  const ref = useRef<HostInstance>(null);
  // The watch under way, which a later layout or the unmount cuts short.
  const watch = useRef(0);
  useEffect(
    () => () => {
      watch.current += 1;
    },
    [],
  );
  const onLayout = useCallback(() => {
    if (!launch) return;
    watch.current += 1;
    const run = watch.current;
    let last: { x: number; y: number } | null = null;
    let frames = 0;
    const read = () => {
      if (watch.current !== run) return;
      if (!ref.current) return;
      const { left, top, width, height } = restingRect(
        ref.current as unknown as Element,
      );
      if (!width || !height) return;
      const at = { x: left + width / 2, y: top + height / 2 };
      const moved = !last || !samePlace(last, at);
      last = at;
      frames += 1;
      if (!moved) return;
      launch.x.set(steady(withSpring(at.x, springs.pane)));
      launch.y.set(steady(withSpring(at.y, springs.pane)));
      if (frames < WATCH_FRAMES) requestAnimationFrame(read);
    };
    read();
  }, [launch]);
  useEffect(onLayout, [onLayout, moved, width, height]);
  return { ref, onLayout, style };
}

/** Whether two readings of the control agree (SETTLED_PT). */
export function samePlace(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return Math.abs(a.x - b.x) <= SETTLED_PT && Math.abs(a.y - b.y) <= SETTLED_PT;
}
