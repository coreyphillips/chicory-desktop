import { createContext, useContext } from 'react';
import { SLOT_PADDING } from '../../stage/layout';

/**
 * What the Receive scene does for the screen it holds, which the screen
 * cannot do from inside its scroll view: answer Android back through the
 * stage, and say how much room its slot has. The ground's tint is the
 * stage's (`useHoldTint`).
 *
 * Outside the scene, as when a suite renders the screen alone, back is
 * never asked, so it does nothing, and there is no room to fit: each step
 * takes the height it needs.
 */
export interface ReceiveHost {
  /**
   * A hook: answers Android back while `active` (REDESIGN.md 2.2), the way
   * `useSceneBack` does. The scene passes `useSceneBack` itself.
   */
  useBack: (handler: () => boolean, active: boolean) => void;
  /**
   * How tall a step can be and still end above the bottom inset, in points,
   * once the scene has measured its slot (`slotRoom`). The amount step pins
   * its way on to the bottom of it, so the control never sinks under the
   * system bar on a short phone.
   */
  room?: number;
}

const nothing: ReceiveHost = { useBack: () => {} };

export const ReceiveHostContext = createContext<ReceiveHost>(nothing);

export const useReceiveHost = () => useContext(ReceiveHostContext);

/**
 * The room a step has in a slot `height` points tall over a bottom inset of
 * `bottom`: what is left inside the slot's own padding and clear of the
 * system bar (REDESIGN.md 11, Bottom inset), in whole points so the slot
 * never scrolls by a fraction.
 */
export function slotRoom(height: number, bottom: number): number {
  return Math.max(
    0,
    Math.floor(height - SLOT_PADDING.top - SLOT_PADDING.bottom - bottom),
  );
}
