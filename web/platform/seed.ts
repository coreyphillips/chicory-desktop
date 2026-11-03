import type { Network } from '@beignet/wallet-core';
/** The browser has no device seed vault and never reads one for network setup. */
export async function seedSourceNetwork(): Promise<Network | null> { return null; }
export async function clearSeedSource(): Promise<void> {}
export function withDeviceSeedSource(..._args: unknown[]): never {
  throw new Error('Wallet seeds are managed by the local wallet service.');
}
