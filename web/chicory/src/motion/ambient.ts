import { useSyncExternalStore } from 'react';

/*
 * The ambient clock (REDESIGN.md 3.5): whether decoration may move.
 *
 * A loop that only decorates, such as the backdrop's drift, the mark's
 * breath, the vessel's sheen or the pulse dot's ping, comes to rest once
 * nobody has touched the app for AMBIENT_REST_MS, and starts again with the
 * next touch or the next change worth seeing. A phone left on a table then
 * draws nothing, which spares its battery, and a tool that waits for the
 * screen to be still before it reads it, as Android's uiautomator does, can
 * read it.
 *
 * A loop that says something is under way (a payment's orbit, a waiting
 * request's dashes, the stale shimmer, the reconnecting pulse, a busy
 * control's spin, the chase while a wallet opens) never consults it.
 */

/** How long the app may go untouched before its decoration rests. */
export const AMBIENT_REST_MS = 20_000;

let stirred = Date.now();
let resting = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function tell() {
  for (const listener of listeners) listener();
}

/**
 * Waits out what is left of the quiet and then rests, while any decoration
 * is listening. With none, no timer runs: the next to listen does the sums.
 */
function schedule() {
  if (timer !== null || resting || listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    if (Date.now() - stirred < AMBIENT_REST_MS) {
      schedule();
      return;
    }
    resting = true;
    tell();
  }, Math.max(0, stirred + AMBIENT_REST_MS - Date.now()));
}

/**
 * Something happened worth moving for: a touch anywhere, or a change the
 * app shows. Decoration at rest starts again, and the quiet starts over.
 */
export function wakeAmbient(): void {
  stirred = Date.now();
  if (!resting) return;
  resting = false;
  tell();
  schedule();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

const atRest = () => resting;
const unheard = () => () => {};
const never = () => false;

/**
 * Whether decoration is at rest, kept current. Pass `ambient` false for a
 * loop that carries meaning: it neither listens nor rests.
 */
export function useAmbientRest(ambient = true): boolean {
  return useSyncExternalStore(
    ambient ? subscribe : unheard,
    ambient ? atRest : never,
  );
}

/**
 * For the root view: a touch that starts or moves anywhere under it wakes
 * decoration. They only look, and never take the touch from what is under
 * the finger.
 */
export const wakeOnTouch = {
  onStartShouldSetResponderCapture: () => {
    wakeAmbient();
    return false;
  },
  onMoveShouldSetResponderCapture: () => {
    wakeAmbient();
    return false;
  },
};
