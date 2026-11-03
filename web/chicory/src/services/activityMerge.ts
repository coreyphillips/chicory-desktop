import type { Activity, WalletSnapshot } from '@beignet/wallet-core';

/**
 * A wallet never shows less than it already knew. A read that answers with
 * fewer rows than the app has, or that shows a settled payment as something
 * less, has lost a record, not learned something: completed payments do not
 * disappear and a settled Lightning payment does not reverse. So each read
 * is merged into what the app knew for that wallet instead of replacing it.
 *
 * Only what a read lost is put back. Every real change a read brings is
 * taken as it is: a new row, a pending payment that completes or fails, a
 * request that gets paid or expires. A row the read includes again gives way
 * to the read's version, so the merge holds nothing back once the engine's
 * own ledger answers in full.
 */

/**
 * A Lightning payment that settled: a payment hash and no transaction. The
 * engine builds a saved request's row under the same id whether it is paid,
 * still open or expired, so a read that lost the payment shows this id as a
 * request, expired, pending, or a partial on-chain receive.
 */
export const settledLightning = (row: Activity): boolean =>
  row.status === 'completed' && !!row.paymentHash && !row.txid;

/**
 * `read`, plus every completed row of `known` that `read` leaves out, with a
 * settled Lightning payment kept over a read that shows its id as anything
 * less than completed. A kept row that another row carries the transaction
 * of is dropped, so an on-chain receive the engine moved onto its request
 * shows once. Newest first, as the engine orders its own rows.
 */
export function mergeActivity(
  known: readonly Activity[],
  read: readonly Activity[],
): Activity[] {
  const byId = new Map(read.map(row => [row.id, row]));
  const before = new Map(known.map(row => [row.id, row]));
  const out: Activity[] = read.map(row => {
    const was = before.get(row.id);
    if (was?.drain && row.drain)
      return was.drain.revision > row.drain.revision ? was : row;
    return was && settledLightning(was) && row.status !== 'completed'
      ? was
      : row;
  });
  const kept = known.filter(
    row => (row.status === 'completed' || row.drain) && !byId.has(row.id),
  );
  const merged = [...out, ...kept];
  const drainTxids = new Set(merged.flatMap(row => row.drain?.txids ?? []));
  // Which rows were put back rather than read, and which rows carry each
  // transaction, both by the row itself, so the same row listed twice is
  // still one row. Looked up rather than searched for: this runs on every
  // read, over a history that only grows.
  const putBack = new Set(kept);
  const carriers = carriersOf(kept.length ? merged : []);
  const shown = merged.filter(
    row =>
      (row.drain || !row.txid || !drainTxids.has(row.txid)) &&
      (row.drain ||
        !putBack.has(row) ||
        !row.txid ||
        !carriedElsewhere(carriers, row)),
  );
  return kept.length ? shown.sort((a, b) => b.timestamp - a.timestamp) : shown;
}

/** Each transaction id among `rows`, with the rows that carry it. */
function carriersOf(rows: readonly Activity[]): Map<string, Set<Activity>> {
  const carriers = new Map<string, Set<Activity>>();
  for (const row of rows) {
    if (!row.txid) continue;
    const holding = carriers.get(row.txid);
    if (holding) holding.add(row);
    else carriers.set(row.txid, new Set([row]));
  }
  return carriers;
}

/** Whether a row other than `row` carries `row`'s transaction. */
function carriedElsewhere(
  carriers: Map<string, Set<Activity>>,
  row: Activity,
): boolean {
  const holding = row.txid ? carriers.get(row.txid) : undefined;
  return !!holding && (holding.size > 1 || !holding.has(row));
}

/**
 * `read` with its history merged into what the app knew. The balance, the
 * primary's state, the notes and the read's time are the read's own: the
 * page keeps following the engine while its history is kept whole.
 */
export function mergeSnapshot(
  known: WalletSnapshot | null,
  read: WalletSnapshot,
): WalletSnapshot {
  if (!known) return read;
  return { ...read, activity: mergeActivity(known.activity, read.activity) };
}
