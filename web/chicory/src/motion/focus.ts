import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import type { HostInstance } from 'react-native';
import { afterTransition } from './idle';
import { focusBrowserNode } from '../../../platform/browserFocus';

/*
 * Screen reader focus after a transition (REDESIGN.md 9): once a change has
 * settled, focus moves to the new primary element, instead of being lost
 * with the control that was pressed and then removed.
 *
 * The moves still to come, and the moment of the last one, are kept here, so
 * a safety message (`speech.ts`) waits for focus to land before it is said
 * rather than being cut short by the move.
 */

let pending = 0;
let movedAt = -Infinity;

/** Moves a screen reader to `node`, when there is one to move to. */
export function focusOn(node: HostInstance | null | undefined) {
  if (!node) return;
  if (Platform.OS === 'web') {
    if (!focusBrowserNode(node)) return;
  } else AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  movedAt = Date.now();
}

/**
 * Moves a screen reader to what `target` names once no transition is
 * running, and `delay` ms have passed first when one is given (for an
 * element still rising into view). `then` runs just after the move. The move
 * counts as pending from the call until it is made or cancelled. Returns the
 * cancel, for an effect that unmounts first.
 */
export function focusAfterTransition(
  target: () => HostInstance | null | undefined,
  { delay = 0, then }: { delay?: number; then?: () => void } = {},
): () => void {
  pending += 1;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    pending -= 1;
  };
  let cancel = () => {};
  const wait = () => {
    cancel = afterTransition(() => {
      close();
      focusOn(target());
      then?.();
    });
  };
  const timer = delay > 0 ? setTimeout(wait, delay) : null;
  if (timer === null) wait();
  return () => {
    close();
    if (timer !== null) clearTimeout(timer);
    cancel();
  };
}

/** Whether a focus move is waiting for a transition to settle. */
export const focusPending = () => pending > 0;

/** When focus last moved, in `Date.now()` time. */
export const lastFocusMove = () => movedAt;

/**
 * A ref for the element a screen reader should land on whenever `on` turns
 * true, and as it mounts while it is. It moves once no transition is
 * running: an element still arriving may not be in the accessibility tree
 * yet.
 */
export function useFocus<T extends HostInstance = HostInstance>(
  on = true,
): RefObject<T | null> {
  const target = useRef<T>(null);
  useEffect(() => {
    if (!on) return;
    return focusAfterTransition(() => target.current);
  }, [on]);
  return target;
}
