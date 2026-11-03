import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { Activity, WalletSnapshot } from '@beignet/wallet-core';
import { haptics } from '../design/haptics';

/**
 * What a history held when it was last read: each payment's kind and
 * status, by id. A request that is paid becomes a received payment under the
 * same id, so the kind is part of what changes.
 */
export type Seen = ReadonlyMap<string, string>;

const stateOf = (item: Activity) => `${item.kind}:${item.status}`;
const ARRIVED = 'received:completed';

export function seenIn(activity: readonly Activity[]): Seen {
  return new Map(activity.map(item => [item.id, stateOf(item)]));
}

/**
 * The payments in `activity` that finished arriving since `before` was read:
 * received and complete now, and not then. One that was not there at all
 * counts too, since a Lightning payment can appear already complete.
 */
export function arrivals(
  before: Seen,
  activity: readonly Activity[],
): Activity[] {
  return activity.filter(
    item => stateOf(item) === ARRIVED && before.get(item.id) !== ARRIVED,
  );
}

/**
 * Money arriving while the app is open (REDESIGN.md 5, Received
 * celebration): a received payment that completes between one read of the
 * wallet and the next. Returns a count that goes up by one with each read
 * that brings any, for a caller to key its flash or its roll on, and plays
 * the incoming haptic once for them. The canvas calls it once and hands the
 * count to every region, so each arrival is counted and felt once.
 *
 * An ordinary poll that brings nothing new counts nothing. Neither does the
 * first read of a wallet, which sets what is already there, nor the first
 * read after the app comes back from the background, since what completed
 * in between arrived while nobody was looking.
 */
export function useIncoming(snapshot: WalletSnapshot): number {
  const last = useRef<{ wallet: string; seen: Seen } | null>(null);
  const away = useRef(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') away.current = true;
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const before = last.current;
    last.current = {
      wallet: snapshot.wallet.id,
      seen: seenIn(snapshot.activity),
    };
    const rebase =
      !before || before.wallet !== snapshot.wallet.id || away.current;
    away.current = false;
    if (rebase || AppState.currentState === 'background') return;
    if (!arrivals(before.seen, snapshot.activity).length) return;
    haptics.incoming();
    setCount(value => value + 1);
  }, [snapshot]);

  return count;
}
