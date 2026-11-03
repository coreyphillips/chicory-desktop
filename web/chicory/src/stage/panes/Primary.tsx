import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { PropsWithChildren, RefObject } from 'react';
import type { HostInstance } from 'react-native';
import { focusAfterTransition } from '../../motion/focus';
import type { Overlay, Scene } from '../scene';

/**
 * Where a screen reader lands as the canvas arrives at a scene (REDESIGN.md
 * 9). Each region names its scene's primary element with `usePrimary`: the
 * SceneSlot header where the scene has one, else its first control. The
 * canvas moves focus there once the move that brought the scene has
 * settled, so focus is never left on a control that went away with the
 * scene before.
 */
export type Primaries = Map<Scene['name'], RefObject<HostInstance | null>>;

const PrimaryContext = createContext<{
  primaries: Primaries;
  scene: Scene['name'];
} | null>(null);

/** Names `scene` as the scene of whatever region is drawn in `children`. */
export function PrimaryFor({
  primaries,
  scene,
  children,
}: PropsWithChildren<{ primaries: Primaries; scene: Scene['name'] }>) {
  const value = useMemo(() => ({ primaries, scene }), [primaries, scene]);
  return (
    <PrimaryContext.Provider value={value}>{children}</PrimaryContext.Provider>
  );
}

/**
 * A ref for the primary element of the scene this is drawn in. The first
 * element to claim a scene keeps it while it is drawn. Outside the canvas it
 * is a plain ref.
 */
export function usePrimary<
  T extends HostInstance = HostInstance,
>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  const at = useContext(PrimaryContext);
  useLayoutEffect(() => {
    if (!at || at.primaries.has(at.scene)) return;
    at.primaries.set(at.scene, ref);
    return () => {
      at.primaries.delete(at.scene);
    };
  }, [at]);
  return ref;
}

/**
 * Moves a screen reader to the primary element of `scene` each time the
 * stage arrives at a scene, and again as an overlay over it closes, once
 * nothing is moving. While an overlay is open it moves nothing: the overlay
 * holds the screen. A safety message the scene raised as it arrived waits
 * for this move (`motion/speech`), so the move never cuts it short.
 *
 * A scan a Settings field asked for is the one overlay whose close lands
 * elsewhere: on the field a code filled, or back on the scan button that
 * opened it, which the field does itself (`useScanRequest`). So when such a
 * scan closes over the same scene, this moves nothing, rather than taking a
 * screen reader to Settings' header, away from what it was doing. It is
 * kept to the scene's key: a link that closes the scan and opens Send still
 * lands on Send.
 */
export function usePrimaryFocus(
  primaries: Primaries,
  scene: Scene,
  overlay: Overlay,
) {
  const { key, name } = scene;
  const overlaid = !!overlay;
  // The scene a Settings field's scan opened over, while it is open.
  const fieldScan = useRef<number | null>(null);
  useEffect(() => {
    if (overlay?.name === 'scan' && overlay.target === 'settings') {
      fieldScan.current = key;
    }
  }, [overlay, key]);
  useEffect(() => {
    if (overlaid) return;
    const over = fieldScan.current;
    fieldScan.current = null;
    if (over === key) return;
    return focusAfterTransition(() => primaries.get(name)?.current);
  }, [primaries, key, name, overlaid]);
}
