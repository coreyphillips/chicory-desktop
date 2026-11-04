import { createElement, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { Drive } from './drive';

/**
 * One thing done to a state on the way to what it shows. A step reaches for
 * one control at most, and is run again until that control is there to use
 * (drive.ts, `perform`), so it does nothing else before it reaches. A step
 * that starts something slow, such as a wait for a wallet's late answer,
 * returns a promise, and the step after it waits for that to settle.
 */
export type Step = (drive: Drive) => void | Promise<void>;

/** Taps the control labelled `label`. */
export const press =
  (label: string): Step =>
  drive =>
    drive.press(label);

/** Waits `ms` before the next step, as a person waits for a wallet. */
export const wait =
  (ms: number): Step =>
  () =>
    new Promise(resolve => setTimeout(resolve, ms));

/** A state as drawn: what to draw, and the steps that bring it about. */
export interface Take {
  view: ReactElement;
  steps?: Step[];
}

/**
 * One state of the gallery. `make` runs as the state comes up rather than
 * as the gallery loads, so its fixtures are set at that moment: a request
 * is not already out of date, and a balance is not already stale.
 */
export interface Shot {
  name: string;
  make: () => Take;
  /**
   * How long the state holds once reached, where the gallery's own dwell
   * would cut a motion short: a celebration, or an answer that comes late.
   */
  hold?: number;
}

/** A count a step moves on, for a state that changes after it is drawn. */
export interface Counter {
  read: () => number;
  subscribe: (listener: () => void) => () => void;
  next: () => void;
}

export function counter(): Counter {
  let at = 0;
  const listeners = new Set<() => void>();
  return {
    read: () => at,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    next: () => {
      at += 1;
      for (const listener of listeners) listener();
    },
  };
}

/** Where `counter` has got to, as a render reads it. */
export function useCount(count: Counter): number {
  return useSyncExternalStore(count.subscribe, count.read);
}

function Sequence({ views, count }: { views: ReactElement[]; count: Counter }) {
  const at = useCount(count);
  return views[Math.min(at, views.length - 1)];
}

/**
 * The views in turn, one a step. The same component in the same place is
 * updated rather than remounted, so this is how a glyph is shown changing:
 * a roll, a ring completing, a code dissolving.
 */
export function sequence(...views: ReactElement[]): Take {
  const count = counter();
  return {
    view: createElement(Sequence, { views, count }),
    steps: views.slice(1).map(() => count.next),
  };
}
