import { createContext, useContext } from 'react';
import type { Arrival, BuildBeats } from '../layout';

/**
 * The build the canvas is playing as it arrives (REDESIGN.md 7, R-1, R-3
 * and R-5): how it came, when each part's beat falls, and when it began.
 */
export interface Build {
  arrival: Arrival;
  beats: BuildBeats;
  /**
   * When the build began, in `Date.now()` time: as the canvas mounted, and
   * then, once it comes, as the canvas's first frame was painted, which the
   * canvas moves it to (`beganAt`). The beats count from that frame, not
   * from the mount: the frame that mounts the canvas can take a long while
   * to paint, and every part's entrance runs on a steady clock (`steady`)
   * that spends none of it.
   */
  began: number;
}

const BuildContext = createContext<Build | null>(null);

export const BuildProvider = BuildContext.Provider;

/** Moves `build` to begin at `painted`, the time of its first frame. */
export function beganAt(build: Build, painted: number) {
  build.began = painted;
}

/** Whether `build` has landed by `now`. */
export function buildLanded(build: Build, now: number): boolean {
  return now - build.began > build.beats.done;
}

/**
 * The build under way, for a part of the canvas to enter on its own beat,
 * or null once it has landed, and always off the canvas. A part reads it as
 * it mounts and keeps what it read: an entrance only plays at mount, so a
 * part that mounts after the build, such as a row that arrives later, is
 * not held back to it. A slow first frame does not make a part late: the
 * build only begins once that frame is painted.
 */
export function useBuild(): Build | null {
  const build = useContext(BuildContext);
  if (!build || buildLanded(build, Date.now())) return null;
  return build;
}
