import type { WalletClientInterface } from '@beignet/wallet-core';

// Both the in-process engine and authenticated host implement this contract.
export type WalletAdapter = WalletClientInterface;
