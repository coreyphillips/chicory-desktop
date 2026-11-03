/**
 * The transitions in flight, so work that would stutter a pane move can wait
 * for it to settle.
 *
 * InteractionManager did this job, and it throws in React Native 0.87. The
 * canvas marks each move with `beginTransition`; `afterTransition` holds work
 * until none is running and then hands it to an idle callback, so it still
 * yields to the next frame.
 */

/**
 * A move whose end() is never called, because its component unmounted or an
 * animation callback was dropped, must not hold queued work forever. Each
 * transition ends itself this long after its expected finish.
 */
const SAFETY_MS = 120;
const IDLE_TIMEOUT_MS = 500;

// React Native installs this global, but its type definitions leave it out.
// It is absent under Jest, where a timeout stands in.
declare const requestIdleCallback:
  | ((callback: () => void, options: { timeout: number }) => number)
  | undefined;

interface Task {
  run: () => void;
  cancelled: boolean;
}

let running = 0;
let waiting: Task[] = [];

function whenIdle(fn: () => void) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(fn, 0);
  }
}

function release() {
  const due = waiting;
  waiting = [];
  for (const task of due) {
    whenIdle(() => {
      if (task.cancelled) return;
      // A move that began since this was released goes first.
      if (running > 0) {
        waiting.push(task);
        return;
      }
      task.run();
    });
  }
}

/**
 * Marks a transition of about `ms` as running. The returned end() may be
 * called any number of times; only the first counts. `onEnd` runs once when
 * it ends, whether by end() or by the safety timeout.
 */
export function beginTransition(ms: number, onEnd?: () => void): () => void {
  running += 1;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(safety);
    running -= 1;
    onEnd?.();
    if (running === 0) release();
  };
  const safety = setTimeout(end, ms + SAFETY_MS);
  return end;
}

export const isTransitioning = () => running > 0;

/**
 * Runs `fn` once no transition is running and the JS thread is idle. Returns a
 * cancel, for an effect that unmounts first.
 */
export function afterTransition(fn: () => void): () => void {
  const task: Task = { run: fn, cancelled: false };
  waiting.push(task);
  if (running === 0) release();
  return () => {
    task.cancelled = true;
    waiting = waiting.filter(other => other !== task);
  };
}
