import type { Activity } from '@beignet/wallet-core';
import { copy } from '../../design/copy';
import { activityStatus } from '../activity/model';
import { ringFlags, ringVisual } from '../activity/visual';

/**
 * The sentence a payment's outcome gets, the one its detail used to show in a
 * notice and its ring now carries for a screen reader and a Whisper.
 */
export function statusSentence(item: Activity): string {
  switch (item.status) {
    case 'completed':
      return copy.detail.completed;
    case 'uncertain':
      return copy.detail.uncertain;
    case 'pending':
      return item.kind === 'request'
        ? copy.detail.awaiting
        : item.kind === 'received'
        ? copy.detail.detected
        : copy.detail.inProgress;
    case 'expired':
      return item.receiveRequest?.legacy
        ? copy.detail.legacyExpired
        : copy.detail.expired;
    default:
      return copy.detail.failed;
  }
}

/**
 * What the detail's ring says (REDESIGN.md 6, Detail). A payment with a
 * receipt says where the money has got to, since the receipt tells the rest.
 * Anything the ring's badge or glyph adds follows, and a status that could
 * not be read says the result shown is the last one known.
 *
 * `safety` marks the states a screen reader must hear at once: an unknown
 * outcome, which must never be paid again, and a reused address.
 */
export function ringWords(item: Activity): {
  label: string;
  value: string;
  safety: boolean;
} {
  const visual = ringVisual(item);
  const receipt =
    !!item.receiveStatus && item.receiveStatus.phase !== 'waiting';
  const flags = ringFlags(visual).filter(
    flag => flag !== copy.activity.unavailable,
  );
  const unavailable =
    item.receiveStatusUnavailable &&
    item.receiveRequest?.bitcoinTracking !== 'ambiguous';
  const label = [
    receipt ? activityStatus(item) : statusSentence(item),
    ...flags,
    unavailable ? copy.detail.unavailable : '',
  ]
    .filter(Boolean)
    .map(part => (part.endsWith('.') ? part : `${part}.`))
    .join(' ');
  return {
    label,
    value: copy.detail.status(activityStatus(item)),
    safety: visual.pattern === 'held' || visual.glyph === 'twin',
  };
}

/**
 * Whether a payment's detail has a fee line. Money sent or moved always
 * does, known or not. Money that came in only does when the engine says it
 * cost something, as a channel made for it just in time does.
 */
export function feeShown(
  item: Pick<Activity, 'kind' | 'feeSats' | 'feeKnown'>,
): boolean {
  if (item.kind === 'sent' || item.kind === 'transfer') return true;
  return item.feeKnown !== false && item.feeSats > 0;
}
