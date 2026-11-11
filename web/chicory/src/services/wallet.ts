import type { WalletClientInterface, WalletRecord } from '@beignet/wallet-core';
import type { PaymentNoteStore } from './paymentNotes';

// Both the in-process engine and authenticated host implement this contract.
export type WalletAdapter = WalletClientInterface & {
  /** Open the local note store for this selected wallet. */
  openPaymentNotes?: (wallet: Pick<WalletRecord, 'id' | 'network'>) => PaymentNoteStore;
};
