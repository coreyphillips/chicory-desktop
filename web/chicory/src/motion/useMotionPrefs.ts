import { useMemo } from 'react';
import { useReducedMotion } from '../services/motion';

/**
 * What this device has asked of motion, kept current as the setting changes.
 *
 * It reads through services/motion rather than subscribing again, so the flag
 * that `motionReduced()` and the layout presets consult is updated by the same
 * event that re-renders the caller, and the two can never disagree.
 */
export function useMotionPrefs(): { reduced: boolean } {
  const reduced = useReducedMotion();
  return useMemo(() => ({ reduced }), [reduced]);
}
