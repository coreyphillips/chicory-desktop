import { useEffect, useLayoutEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';
import { haptics } from '../design/haptics';
import type { Phase } from './phase';
import { newestFirst, useStage } from './StageContext';
import type { Responder } from './StageContext';

/** Asks each answer, newest first, until one takes the press. */
const answered = (registry: Set<Responder<() => boolean>>) =>
  newestFirst(registry).some(handler => handler());

/**
 * Android's back button, answered by the stage (REDESIGN.md 2.2), in this
 * order:
 *
 * 1. A pane still on its way swallows the press, as a tap would be, rather
 *    than sending the canvas back from somewhere it has not reached.
 * 2. A locked app answers nothing.
 * 3. The innermost scene's own step goes back first (`useSceneBack`), such
 *    as Send's review returning to compose.
 * 4. A payment or a new wallet in flight holds the user where they are, so
 *    the press is swallowed and felt rather than obeyed.
 * 5. An overlay closes, then a scene returns to the one under it.
 * 6. A shell phase closes what it opened (`usePhaseBack`), such as a panel
 *    or an editor.
 * 7. With nothing left to close, the system has the press, which leaves
 *    the app.
 *
 * The scene stack only means something while the canvas is showing. Outside
 * the wallet it can still hold the Settings a network switch will return to,
 * and a press there must not move a canvas nobody can see.
 */
export function useBackHandler(phase: Phase['kind']) {
  const { state, dispatch, panes, responders } = useStage();
  // Read at press time, so the listener is added once rather than on every
  // change of scene.
  const current = useRef({ state, phase });
  useLayoutEffect(() => {
    current.current = { state, phase };
  }, [state, phase]);
  useEffect(() => {
    const handleBack = () => {
        const { state: now, phase: shown } = current.current;
        if (panes.current?.moving()) return true;
        if (shown === 'locked') return false;
        if (answered(responders.sceneBack)) return true;
        if (now.busy) {
          haptics.warning();
          return true;
        }
        if (now.overlay || (shown === 'wallet' && now.stack.length > 0)) {
          dispatch({ type: 'back' });
          return true;
        }
        return answered(responders.phaseBack);
      };
    const subscription = Platform.OS === 'web' ? null : BackHandler.addEventListener('hardwareBackPress', handleBack);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
      if (handleBack()) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('keydown', escape);
    return () => { subscription?.remove(); window.removeEventListener('keydown', escape); };
  }, [dispatch, panes, responders]);
}
