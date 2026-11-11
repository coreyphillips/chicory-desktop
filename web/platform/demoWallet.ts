import { DemoWalletClient } from '@beignet/wallet-core';
import type { WalletRecord } from '@beignet/wallet-core';
import type { PaymentNote, PaymentNoteStore } from '../chicory/src/services/paymentNotes.ts';

/** The explicit sample wallet holds notes only for this demo session. */
export class DesktopDemoWallet extends DemoWalletClient {
  private readonly notes = new Map<string, Map<string, PaymentNote>>();

  openPaymentNotes(wallet: Pick<WalletRecord, 'id' | 'network'>): PaymentNoteStore {
    const scope = JSON.stringify([wallet.network, wallet.id]);
    const entries = this.notes.get(scope) ?? new Map<string, PaymentNote>();
    this.notes.set(scope, entries);
    return {
      read: async () => new Map(entries),
      save: async (key, note) => {
        if (note.text) entries.set(key, note);
        else entries.delete(key);
        return new Map(entries);
      },
      move: async moves => {
        for (const [from, to] of moves) {
          const note = entries.get(from);
          if (!note || entries.has(to)) continue;
          entries.set(to, note);
          entries.delete(from);
        }
        return new Map(entries);
      },
    };
  }
}
