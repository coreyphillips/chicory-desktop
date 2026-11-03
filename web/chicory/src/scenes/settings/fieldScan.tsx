import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentRef, ReactNode, RefObject } from 'react';
import { Keyboard, View } from 'react-native';
import { Scanner } from '../../components/Scanner';
import type { ScanPurpose } from '../../stage/scene';
import { useSettingsHost } from './host';

/**
 * Where a screen reader lands once a field's scan has closed: on the field
 * a code filled, back on the scan button after a close, or nowhere yet.
 */
export type ScanLanding = 'field' | 'control' | null;

/** A field's scan, as `useFieldScan` hands it to the field that asks. */
export interface FieldScan {
  /** Opens the scan for the field: the overlay, or the scanner in place. */
  open: () => void;
  /** For the view around the scan button, which the disc grows out of. */
  from: RefObject<ComponentRef<typeof View> | null>;
  /** For the view around the field, which a code read collapses into. */
  into: RefObject<ComponentRef<typeof View> | null>;
  /**
   * Where focus lands now, for the field's `focus` (`'field'`) and the scan
   * button's (`'control'`).
   */
  landOn: ScanLanding;
  /**
   * Lands focus on the field or the scan button, as an editor opening on
   * its field does, or on neither.
   */
  land: (to: ScanLanding) => void;
  /**
   * The scanner, drawn in the field's own place while it is open, when there
   * is no overlay to ask, as when a suite draws Settings alone. Null on the
   * canvas, where the overlay draws it.
   */
  camera: ReactNode;
}

/**
 * A Settings field that a scanned code can fill, as the primary node's
 * address and the Bitcoin address an emptied wallet goes to are.
 *
 * On the canvas the scan is the stage's overlay, as Home's and Send's are
 * (REDESIGN.md 2.3 and 5): its disc grows out of the field's scan button
 * and, once a code is read and passes the field's own check (`validate`),
 * collapses into the field as `onCode` fills it in. Settings stays drawn
 * beneath it, out of use, so nothing on the page moves or is drawn again.
 * Opening it puts the keyboard away first, since the camera wants the
 * whole screen.
 *
 * As it closes, a screen reader lands on the field a code filled, or back on
 * the scan button after a close, rather than on Settings' header (`landOn`,
 * which the field and the button take as `focus`).
 *
 * Without the overlay, as when a suite draws Settings on its own, the
 * scanner is drawn in the field's place instead (`camera`), as Send draws
 * its own when it is rendered alone. There is no modal anywhere.
 */
export function useFieldScan({
  purpose,
  validate,
  onCode,
  test = false,
}: {
  purpose: ScanPurpose;
  validate: (value: string) => string;
  onCode: (value: string) => void;
  /** A test network, where the scanner draws in slate. */
  test?: boolean;
}): FieldScan {
  const host = useSettingsHost();
  const from = useRef<ComponentRef<typeof View>>(null);
  const into = useRef<ComponentRef<typeof View>>(null);
  const [landOn, land] = useState<ScanLanding>(null);
  const [inPlace, setInPlace] = useState(false);
  // The field's latest check and taker, for a code read after it has drawn
  // again since the scan opened.
  const latest = useRef({ validate, onCode });
  useLayoutEffect(() => {
    latest.current = { validate, onCode };
  });
  const check = useCallback(
    (value: string) => latest.current.validate(value),
    [],
  );
  const take = useCallback((value: string) => latest.current.onCode(value), []);

  const open = () => {
    Keyboard.dismiss();
    land(null);
    if (!host.scan) {
      setInPlace(true);
      return;
    }
    host.scan({
      purpose,
      validate: check,
      onCode: take,
      onClose: read => land(read ? 'field' : 'control'),
      from,
      into,
    });
  };

  const camera = inPlace ? (
    <Scanner
      purpose={purpose}
      validate={check}
      test={test}
      onDetected={value => {
        setInPlace(false);
        take(value);
        land('field');
      }}
      onCancel={() => {
        setInPlace(false);
        land('control');
      }}
    />
  ) : null;

  return { open, from, into, landOn, land, camera };
}
