import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Point, ScanPurpose } from './scene';
import { useResponder, useStage } from './StageContext';

/**
 * Takes the codes the scan overlay reads for the Send already open, or for
 * the Settings field that asked, while `active` (REDESIGN.md 2.3).
 *
 * Pass `useIsCurrentScene(sceneKey)` as `active`, with the key the canvas
 * gives the Send scene, not `usePaneActive()`. The overlay covers the Send's
 * pane while it is open, so the pane is out of use exactly when a code
 * arrives, and a receiver keyed to it would already be gone.
 *
 * A scan started inside Send has its target set to `send`, and one started
 * inside Settings `settings`: the overlay hands the code to the receiver that
 * became active last, and the reducer closes the overlay over the same scene.
 * With no receiver, the overlay only closes over that scene, and the code
 * goes nowhere. A scan from home never reaches a receiver: the reducer opens
 * a fresh Send prefilled with the code.
 *
 * `validate`, when given, is the check the scanner holds a code to before it
 * takes one, as a Settings field checks for a node or a Bitcoin address. It
 * is read from the receiver as each code is read, never kept in the stage's
 * state, so the scanner always asks the receiver that is armed. Without one
 * the scanner checks for a payment request, as Send's scan does.
 */
export function useScanReceiver(
  receiver: (value: string) => void,
  active: boolean,
  validate?: (value: string) => string,
) {
  useResponder(
    useStage().responders.scan,
    { receive: receiver, validate },
    active,
  );
}

/** Anything drawn that can say where it is in the window. */
export interface Measurable {
  measureInWindow: (
    callback: (x: number, y: number, width: number, height: number) => void,
  ) => void;
}

/**
 * The centre in the window of the view `ref` holds, or null when it cannot
 * say at once. On Fabric `measureInWindow` answers before it returns, so a
 * handler measures and opens the overlay in one tick with whatever answered,
 * as Send's scan button does. One that answers later, as a suite's mock that
 * never does, leaves the disc to grow from the bottom centre, and a code
 * read to close it back where it grew.
 */
export function centreOf(ref?: RefObject<Measurable | null>): Point | null {
  const found: { at: Point | null } = { at: null };
  ref?.current?.measureInWindow((x, y, width, height) => {
    found.at = { x: x + width / 2, y: y + height / 2 };
  });
  return found.at;
}

/** One scan a Settings field asks the overlay for (`useScanRequest`). */
export interface ScanRequest {
  /** What the scan is for, which the scanner's words follow. */
  purpose: ScanPurpose;
  /**
   * The field's own check of a code: what it fills in, or a throw with the
   * reason the scanner says as it refuses the code.
   */
  validate: (value: string) => string;
  /** A code read and checked, for the field. */
  onCode: (value: string) => void;
  /**
   * The overlay has closed: `read` once a code came through, and false for a
   * close however it came, by its close control, Android back, a tap refused
   * while the panes moved, or the session moving the wallet under it.
   */
  onClose?: (read: boolean) => void;
  /** The scan button, which the disc grows out of. */
  from?: RefObject<Measurable | null>;
  /** The field a code fills, which the disc collapses into once one is read. */
  into?: RefObject<Measurable | null>;
}

/**
 * Asks the scan overlay for a code on behalf of a field in Settings, as
 * Send's own scan button does for its request (REDESIGN.md 2.3), and returns
 * the ask.
 *
 * Asking keeps the request and arms one receiver for it, then opens the
 * overlay in the same handler, its disc growing from the request's scan
 * button and set to collapse into its field once a code is read. The
 * receiver registers in the commit that opens the overlay, which is after
 * the overlay has drawn its scanner: so what the scan is for goes with the
 * overlay itself, while the field's check, a function the stage never
 * keeps, is read from the receiver each time a code is read.
 *
 * However the overlay closes, the receiver disarms and the request hears it
 * (`onClose`), with whether a code came through, so the field or its scan
 * button can take a screen reader back. The same holds when the overlay
 * never opened, as when the tap was refused while a pane moved, and when
 * the session closed it. Only a scan this hook asked for reaches the field:
 * one opened any other way finds no receiver armed, and its code goes
 * nowhere.
 */
export function useScanRequest(): (request: ScanRequest) => void {
  const { state, actions } = useStage();
  // The request being answered, and whether a code came through for it.
  const pending = useRef<ScanRequest | null>(null);
  const read = useRef(false);
  const [armed, setArmed] = useState(false);
  const receive = useCallback((value: string) => {
    const request = pending.current;
    if (!request) return;
    read.current = true;
    request.onCode(value);
  }, []);
  const validate = useCallback(
    (value: string) =>
      pending.current ? pending.current.validate(value) : value,
    [],
  );
  useScanReceiver(receive, armed, validate);

  // Armed with no scan open: the overlay has closed, or never opened.
  const scanning = state.overlay?.name === 'scan';
  useEffect(() => {
    if (!armed || scanning) return;
    const request = pending.current;
    const came = read.current;
    pending.current = null;
    read.current = false;
    setArmed(false);
    request?.onClose?.(came);
  }, [armed, scanning]);

  return useCallback(
    (request: ScanRequest) => {
      pending.current = request;
      read.current = false;
      setArmed(true);
      actions.openScan(centreOf(request.from), {
        purpose: request.purpose,
        into: centreOf(request.into),
      });
    },
    [actions],
  );
}
