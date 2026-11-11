import type { Activity } from '@beignet/wallet-core';

export interface PaymentNote {
  text: string;
  /** The raw on-chain row's address, when known, to prove a later match. */
  address?: string;
}
export type NoteMap = ReadonlyMap<string, PaymentNote>;

/** Each operation returns the entries committed to this wallet's local vault. */
export interface PaymentNoteStore {
  read(): Promise<NoteMap>;
  save(key: string, note: PaymentNote): Promise<NoteMap>;
  move(moves: ReadonlyMap<string, string>): Promise<NoteMap>;
}

export function canAnnotate(item: Activity) {
  return (
    item.status === 'completed' &&
    (item.kind === 'sent' || item.kind === 'received') &&
    (!item.receiveStatus || item.receiveStatus.phase === 'completed')
  );
}

// A raw transaction row can later shrink to its unassigned outputs. Its
// previous note must not quietly label the smaller, different payment.
const incomingKey = (txid: string, amount: number, assigned: string[] = []) =>
  JSON.stringify([txid, amount, ...assigned]);

export function paymentNoteKey(item: Activity, assigned?: string[]) {
  return item.kind === 'received' &&
    item.txid &&
    item.id === `transaction:${item.txid}`
    ? incomingKey(item.txid, item.amountSats, assigned)
    : `activity:${item.id}`;
}

/** A batch can leave the same amount unassigned to different requests. Keep
 * the identities of its assigned outputs in the remaining raw row's key. */
export function paymentNoteKeys(activity: readonly Activity[]) {
  const assigned = new Map<string, string[]>();
  for (const row of activity) {
    if (row.receiveStatus?.method !== 'bitcoin') continue;
    for (const tx of row.receiveStatus.transactions ?? []) {
      const outputs = assigned.get(tx.txid) ?? [];
      outputs.push(JSON.stringify([row.id, tx.amountSats]));
      assigned.set(tx.txid, outputs);
    }
  }
  const keys = new Map<string, string>();
  for (const row of activity) {
    if (canAnnotate(row)) {
      const outputs = row.txid ? assigned.get(row.txid)?.sort() : undefined;
      keys.set(row.id, paymentNoteKey(row, outputs));
    }
  }
  return keys;
}

/**
 * Carry a raw receive's note only when a unique address received its entire
 * confirmed amount from one transaction. Other requests paid by that batch,
 * a remaining raw output or missing evidence leave the note on its source.
 */
export function noteMoves(activity: readonly Activity[], notes: NoteMap) {
  const moves = new Map<string, string>();
  if (!notes.size) return moves;
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const item of activity) {
    const ids = new Set(item.receiveStatus?.txids);
    for (const tx of item.receiveStatus?.transactions ?? []) ids.add(tx.txid);
    if (item.txid) ids.add(item.txid);
    for (const txid of ids) {
      if (seen.has(txid)) shared.add(txid);
      seen.add(txid);
    }
  }
  for (const item of activity) {
    const request = item.receiveRequest;
    const receipt = item.receiveStatus;
    const tx = receipt?.transactions?.[0];
    if (
      !canAnnotate(item) ||
      item.kind !== 'received' ||
      item.receiveStatusUnavailable ||
      request?.bitcoinTracking !== 'unique' ||
      !request.address ||
      receipt?.method !== 'bitcoin' ||
      receipt.transactions?.length !== 1 ||
      !tx?.confirmed ||
      receipt.txids.length !== 1 ||
      receipt.txids[0] !== tx.txid ||
      tx.amountSats !== item.amountSats ||
      shared.has(tx.txid)
    )
      continue;
    const from = incomingKey(tx.txid, tx.amountSats);
    const to = paymentNoteKey(item);
    const raw = notes.get(from);
    if (
      raw &&
      (!raw.address || raw.address === request.address) &&
      !notes.has(to)
    )
      moves.set(from, to);
  }
  return moves;
}
