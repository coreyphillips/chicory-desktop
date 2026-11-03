import { useState } from 'react';
import type { Activity } from '@beignet/wallet-core';

/** Whether two values hold the same data, however deeply nested. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => same(left[key], right[key]));
}

/**
 * `next`, with each payment that has not changed since `previous` replaced by
 * the object `previous` held for it. When nothing changed at all, `previous`
 * itself, so a list keyed on it does not even re-render.
 */
export function stableActivity(
  previous: readonly Activity[],
  next: readonly Activity[],
): readonly Activity[] {
  const before = new Map(previous.map(item => [item.id, item]));
  let changed = previous.length !== next.length;
  const out = next.map((item, index) => {
    const kept = before.get(item.id);
    const stable = kept && same(kept, item) ? kept : item;
    if (stable !== previous[index]) changed = true;
    return stable;
  });
  return changed ? out : previous;
}

/**
 * The history, stable across polls (REDESIGN.md 2.3, performance). The wallet
 * is read every 12 seconds and each read builds every payment afresh, so
 * without this every memoized row would redraw every time, for nothing.
 */
export function useStableActivity(
  activity: readonly Activity[],
): readonly Activity[] {
  const [held, setHeld] = useState({ source: activity, stable: activity });
  if (held.source === activity) return held.stable;
  // Kept from the render before, the pattern React gives for state derived
  // from a previous prop: the update applies before any child renders.
  const stable = stableActivity(held.stable, activity);
  setHeld({ source: activity, stable });
  return stable;
}
