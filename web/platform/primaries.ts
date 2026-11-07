import type { WalletSnapshot } from '@beignet/wallet-core';

/**
 * How a wallet's ranked primary nodes stand (coreyphillips/beignet#1924), read
 * off the snapshot the shared client builds. A wallet whose engine keeps one
 * primary has no list, and every answer here is then what `snapshot.primary`
 * says, so nothing changes for it.
 */
type Reading = WalletSnapshot | null | undefined;

const ranked = (snapshot: Reading) =>
  Array.isArray(snapshot?.primaries) && snapshot.primaries.length > 0 ? snapshot.primaries : null;

/** Any primary node is connected: enough to send, and for a start to count as linked. */
export function anyPrimaryConnected(snapshot: Reading): boolean {
  if (!snapshot) return false;
  const list = ranked(snapshot);
  return list ? list.some(entry => entry.connected) : snapshot.primary.connected;
}

/** The node the next receive goes to is connected: what the shell's dot shows. */
export function receiveTargetConnected(snapshot: Reading): boolean {
  if (!snapshot) return false;
  const list = ranked(snapshot);
  if (!list) return snapshot.primary.connected;
  return (list.find(entry => entry.isReceiveTarget) ?? list[0]).connected;
}

/** How many of the ranked nodes answer; zero of zero without a list. */
export function primariesConnected(snapshot: Reading): { connected: number; total: number } {
  const list = ranked(snapshot);
  if (!list) return { connected: 0, total: 0 };
  return { connected: list.filter(entry => entry.connected).length, total: list.length };
}
