import { createContext, useContext } from 'react';
import type { ScanRequest } from '../../stage/useScanReceiver';
import type { Revealable } from './reveal';

/**
 * What the Settings scene does for the page it holds, which the page cannot
 * do from inside its scroll view: answer Android back through the stage,
 * ask the stage's scan overlay for a code on behalf of a field, and scroll
 * the page to a row that opens.
 *
 * Outside the scene, as when a suite renders `SettingsScreen` alone, back is
 * never asked, so it does nothing, and there is no overlay to ask: a field
 * draws the scanner in its own place instead (`useFieldScan`). Nor is there
 * a page to scroll, so a row that opens stays where it is.
 */
export interface SettingsHost {
  /**
   * A hook: answers Android back while `active` (REDESIGN.md 2.2), the way
   * `useSceneBack` does. The scene passes `useSceneBack` itself.
   */
  useBack: (handler: () => boolean, active: boolean) => void;
  /** Opens the scan overlay for a field (`useScanRequest`). */
  scan?: (request: ScanRequest) => void;
  /**
   * Scrolls the page so the row whose frame is `node` shows, as it opens or
   * grows (`useReveal`).
   */
  reveal?: (node: Revealable | null) => void;
}

const nothing: SettingsHost = { useBack: () => {} };

export const SettingsHostContext = createContext<SettingsHost>(nothing);

export const useSettingsHost = () => useContext(SettingsHostContext);
