import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import type { PropsWithChildren } from 'react';
import type { HostInstance } from 'react-native';
import { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { steady } from '../../motion/steady';
import { springs } from '../../motion/tokens';

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
 * Where the control is read from the window includes whatever still moves
 * it, such as an entrance of the step it is drawn in, so one reading taken
 * as it is laid out could send the circle to where the control was on its
 * way in, several points off where it comes to rest. So the control is
 * read again each frame, the circle's landing following it, until two
 * readings agree, and for WATCH_FRAMES at most.
 */
export function useLaunchLanding() {
  const launch = useLaunch();
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
      ref.current?.measureInWindow((x, y, width, height) => {
        if (watch.current !== run || !width || !height) return;
        const at = { x: x + width / 2, y: y + height / 2 };
        const moved = !last || !samePlace(last, at);
        last = at;
        frames += 1;
        if (!moved) return;
        launch.x.set(steady(withSpring(at.x, springs.pane)));
        launch.y.set(steady(withSpring(at.y, springs.pane)));
        if (frames < WATCH_FRAMES) requestAnimationFrame(read);
      });
    };
    read();
  }, [launch]);
  return { ref, onLayout, style };
}

/** Whether two readings of the control agree (SETTLED_PT). */
export function samePlace(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return Math.abs(a.x - b.x) <= SETTLED_PT && Math.abs(a.y - b.y) <= SETTLED_PT;
}

/**
 * A scene an action circle opens, Send or Receive, which tells the hand-over
 * as it comes and goes: `onOpen` as it opens, before anything else of it
 * runs, and `onLeave` once, as it goes: as it starts `leaving`, while the
 * canvas fades it out where it was, or else as it is taken away.
 */
export function Launched({
  onOpen,
  onLeave,
  leaving = false,
  children,
}: PropsWithChildren<{
  onOpen: () => void;
  onLeave: () => void;
  leaving?: boolean;
}>) {
  const calls = useRef({ onOpen, onLeave });
  useLayoutEffect(() => {
    calls.current = { onOpen, onLeave };
  });
  const left = useRef(false);
  useLayoutEffect(() => {
    const { current } = calls;
    current.onOpen();
    return () => {
      if (!left.current) current.onLeave();
    };
  }, []);
  useLayoutEffect(() => {
    if (!leaving || left.current) return;
    left.current = true;
    calls.current.onLeave();
  }, [leaving]);
  return <>{children}</>;
}
