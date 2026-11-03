import type { ComponentRef, RefObject } from 'react';
import type { View } from 'react-native';
import type { Rect } from '../../stage/scene';

/** A drawn view, as a ref to a `View` holds it. */
export type RowNode = ComponentRef<typeof View>;

/**
 * Where each row of the Activity list is on screen, so a payment's detail can
 * grow out of its row and fold back into it (REDESIGN.md 7, T4). Rows in the
 * list register while they are mounted; a row the list has virtualized away,
 * or a payment no longer listed, has none, and the detail fades instead.
 */
const rows = new Map<string, RefObject<RowNode | null>>();

/** Registers the row for payment `id`; the returned function removes it. */
export function registerRow(id: string, ref: RefObject<RowNode | null>) {
  rows.set(id, ref);
  return () => {
    // A row remounted under the same id has already taken the slot.
    if (rows.get(id) === ref) rows.delete(id);
  };
}

/**
 * Where `node` is in window coordinates, or null when that cannot be told at
 * once. The new architecture measures synchronously, so a tapped row opens
 * its detail in the same tick; a measurement that does not answer then is not
 * waited for, and the detail fades in instead.
 */
export function measureNode(node: RowNode | null): Rect | null {
  let rect: Rect | null = null;
  node?.measureInWindow((x, y, width, height) => {
    if (width > 0 && height > 0) rect = { x, y, width, height };
  });
  return rect;
}

/** Where the row for payment `id` is now, or null when it is not drawn. */
export function measureRow(id: string): Rect | null {
  return measureNode(rows.get(id)?.current ?? null);
}
