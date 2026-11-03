import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether this device wants motion at all.
 *
 * Read as the first caller mounts and kept current through the accessibility
 * event, so a user who turns Reduce Motion on mid-session gets the calmer app
 * immediately. Haptics are not tied to it. With less on screen they carry more
 * of the meaning, so only Settings > Haptics turns them off (REDESIGN.md rule
 * 7).
 *
 * One listener serves every caller, however many keys a keypad or rings a
 * list draws, and the callers that mount together share one read of the
 * setting.
 */
let reduced = false;
export const motionReduced = () => reduced;

const listeners = new Set<() => void>();
let subscription: { remove: () => void } | null = null;
let asking = false;

function apply(next: boolean) {
  if (next === reduced) return;
  reduced = next;
  for (const listener of listeners) listener();
}

// A mount asks the setting again, so a screen drawn later never keeps what
// an earlier one read. The callers that mount in one commit ask once.
function ask() {
  if (asking) return;
  asking = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then(apply, () => {})
    .finally(() => {
      asking = false;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  subscription ??= AccessibilityInfo.addEventListener(
    'reduceMotionChanged',
    apply,
  );
  ask();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, motionReduced);
}
