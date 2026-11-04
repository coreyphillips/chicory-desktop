import type { Network, WalletClientInterface } from '@beignet/wallet-core';

/** The browser has no device seed vault and never reads one for network setup. */
export async function seedSourceNetwork(): Promise<Network | null> { return null; }
export async function clearSeedSource(): Promise<void> {}
export function withDeviceSeedSource(..._args: unknown[]): never {
  throw new Error('Wallet seeds are managed by the local wallet service.');
}

/** The wallet a new one on another network can share a recovery phrase with. */
export interface SeedSourceWallet { walletId: string; network: Network; name: string }

/**
 * On desktop, the open wallet. A new wallet on another network reuses its
 * recovery phrase inside the local wallet service, unless the owner chooses a
 * separate wallet. Only this reference reaches the service; the page never
 * holds the phrase.
 */
export async function seedSourceWallet(client: WalletClientInterface): Promise<SeedSourceWallet | null> {
  if (typeof window === 'undefined' || !(window as { chicoryDesktop?: unknown }).chicoryDesktop) return null;
  const id = (client as { connection?: { walletId?: string } }).connection?.walletId;
  if (!id) return null;
  const wallet = (await client.listWallets()).find(item => item.id === id);
  return wallet ? { walletId: wallet.id, network: wallet.network as Network, name: wallet.name } : null;
}
