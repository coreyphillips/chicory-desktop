import React, {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type { PropsWithChildren } from 'react';
import type { Activity, WalletRecord } from '@beignet/wallet-core';
import { noteMoves, paymentNoteKeys } from '../../services/paymentNotes';
import type { NoteMap } from '../../services/paymentNotes';
import type { WalletAdapter } from '../../services/wallet';

const EMPTY: NoteMap = new Map();
interface WalletNotes {
  keys: ReadonlyMap<string, string>;
  entries: NoteMap;
  save?: (item: Activity, text: string) => Promise<void>;
}
const Context = createContext<WalletNotes>({ keys: new Map(), entries: EMPTY });
export const useWalletNotes = () => useContext(Context);

export function WalletNotesProvider({
  wallet: { id, network }, activity, client, children,
}: PropsWithChildren<{
  wallet: Pick<WalletRecord, 'id' | 'network'>;
  activity: readonly Activity[];
  client: WalletAdapter;
}>) {
  const keys = useMemo(() => paymentNoteKeys(activity), [activity]);
  // Each wallet selection gets its own queue. A read, reconciliation and
  // user edit must observe all earlier writes before publishing their result.
  const connection = client.connection;
  const session = useMemo(() => {
    const store = connection.walletId === id ? client.openPaymentNotes?.({ id, network }) : undefined;
    let tail = Promise.resolve();
    return {
      store,
      entries: null as NoteMap | null,
      enqueue(task: () => Promise<void>) {
        const result = tail.then(task);
        tail = result.catch(() => {});
        return result;
      },
    };
  }, [client, connection, id, network]);
  const [loaded, setLoaded] = useState<{ session: typeof session; entries: NoteMap } | null>(null);
  const latest = useRef<{ session: typeof session; keys: typeof keys } | null>(null);
  useLayoutEffect(() => {
    latest.current = { session, keys };
    return () => { latest.current = null; };
  }, [session, keys]);

  const publish = useCallback((entries: NoteMap) => {
    if (session.entries === entries) return;
    session.entries = entries;
    if (latest.current?.session === session) setLoaded({ session, entries });
  }, [session]);

  useEffect(() => {
    const store = session.store;
    if (!store) return;
    let active = true;
    void session.enqueue(async () => {
      if (!active) return;
      const notes = session.entries ?? await store.read();
      if (!active) return;
      publish(notes);
      const moves = noteMoves(activity, notes);
      if (moves.size) publish(await store.move(moves));
    }).catch(() => { /* Retry on the next wallet snapshot. */ });
    return () => { active = false; };
  }, [activity, session, publish]);

  const save = useCallback((item: Activity, text: string) => {
    const key = keys.get(item.id);
    return session.enqueue(async () => {
      const current = latest.current;
      if (!session.store || !key || current?.session !== session || current.keys.get(item.id) !== key)
        throw new Error('Payment note unavailable.');
      publish(await session.store.save(key, {
        text: text.trim(),
        address: item.address ?? session.entries?.get(key)?.address,
      }));
    });
  }, [session, keys, publish]);

  const value = useMemo(() => ({
    keys,
    entries: loaded?.session === session ? loaded.entries : EMPTY,
    save: loaded?.session === session ? save : undefined,
  }), [keys, loaded, save, session]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
