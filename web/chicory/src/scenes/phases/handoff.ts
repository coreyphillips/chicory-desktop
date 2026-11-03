import type { Rect } from '../../stage/scene';

/**
 * Where the chosen wallet's mark sat in the picker, so the loading page can
 * fly its own mark in from there (R-2). The stage swaps one phase for the
 * other and passes nothing between them, so the picker leaves the rect here
 * as the finger lands and the loading page takes it as it mounts.
 *
 * A hand-off is taken once. One older than HANDOFF_MS belongs to an earlier
 * choice, such as one that failed, so a loading page that opens on its own,
 * at launch or after a retry, never flies in from a row that is not there.
 */
const HANDOFF_MS = 1500;

let left: { rect: Rect; at: number } | null = null;

export function handOff(rect: Rect) {
  left = { rect, at: Date.now() };
}

export function takeHandOff(): Rect | null {
  const taken = left;
  left = null;
  return taken && Date.now() - taken.at <= HANDOFF_MS ? taken.rect : null;
}
