import { useEffect, useState } from 'react';

/**
 * A clock the screen can read.
 *
 * One hook for every countdown and staleness check, so no screen keeps its own
 * interval. `enabled` lets a component that has nothing to count (a payment
 * detail with no request, a home screen before its first snapshot) skip the
 * timer entirely rather than ticking for nothing.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    // Re-enabling must not show the moment the clock was paused.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * Whether a timestamp has aged past a threshold.
 *
 * The moment it trips is known the instant the timestamp is: it is
 * `updatedAt + afterMs`. Polling a clock to discover it meant the whole app
 * re-rendered every few seconds, forever, to flip one boolean. One scheduled
 * timeout does the same job, and in the ordinary case, where a fresh reading
 * arrives well before the threshold, it is rescheduled and never fires at all.
 */
export function useStaleAfter(
  updatedAt: number | undefined,
  afterMs: number,
): boolean {
  const [stale, setStale] = useState(
    () => updatedAt !== undefined && Date.now() - updatedAt > afterMs,
  );
  useEffect(() => {
    if (updatedAt === undefined) {
      setStale(false);
      return;
    }
    const due = updatedAt + afterMs - Date.now();
    if (due <= 0) {
      setStale(true);
      return;
    }
    setStale(false);
    const timer = setTimeout(() => setStale(true), due);
    return () => clearTimeout(timer);
  }, [updatedAt, afterMs]);
  return stale;
}
