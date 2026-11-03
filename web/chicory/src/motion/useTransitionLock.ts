import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { beginTransition } from './idle';

/**
 * Refuses taps while a pane moves (REDESIGN.md 2.3), so a second tap cannot
 * land on a control that is still on its way somewhere else.
 *
 * `active` is for press handlers: it flips in the same frame as `begin`, before
 * React has re-rendered. `blocking` is for `pointerEvents`. Each `begin` also
 * joins the transition registry, so work queued with `afterTransition` waits
 * for the move as well.
 */
export function useTransitionLock(): {
  active: RefObject<boolean>;
  blocking: boolean;
  begin: (ms: number) => () => void;
} {
  const active = useRef(false);
  const [blocking, setBlocking] = useState(false);
  const open = useRef(new Set<() => void>());

  const begin = useCallback((ms: number) => {
    const end = beginTransition(ms, () => {
      open.current.delete(end);
      if (open.current.size > 0) return;
      active.current = false;
      setBlocking(false);
    });
    open.current.add(end);
    active.current = true;
    setBlocking(true);
    return end;
  }, []);

  // Unmounting mid-move ends its transitions now, instead of leaving queued
  // work waiting on the safety timeout.
  useEffect(() => {
    const pending = open.current;
    return () => {
      for (const end of [...pending]) end();
    };
  }, []);

  return { active, blocking, begin };
}
