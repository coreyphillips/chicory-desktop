import * as Keychain from 'react-native-keychain';
import { DEFAULT_PRIMARY_URI } from '@beignet/wallet-core';
import type { Network } from '@beignet/wallet-core';

export const NETWORKS: Network[] = ['mainnet', 'testnet', 'regtest'];
/** Regtest always requires an explicitly configured local server. */
export const DEFAULT_REGTEST_ELECTRUM = Object.freeze({
  host: '',
  port: 60401,
  tls: false,
});
export interface NetworkProfile {
  network: Network;
  electrum: { host: string; port: number; tls: boolean };
  primaryUri: string;
  transport: 'native' | 'relay';
  relayUrl: string;
  relayToken: string;
}
export interface NetworkPreferences {
  version: 1;
  selectedNetwork: Network;
  /** undefined means not inspected; null means no legacy wallet exists. */
  legacyNetwork?: Network | null;
  profiles: Record<Network, NetworkProfile>;
}
const SERVICE = 'com.beignet.wallet.network-profiles';
export function isNetwork(value: unknown): value is Network {
  return NETWORKS.includes(value as Network);
}
export function defaultProfile(network: Network): NetworkProfile {
  return {
    network,
    electrum:
      network === 'mainnet'
        ? { host: 'bitkit.to', port: 9999, tls: true }
        : network === 'regtest'
        ? { ...DEFAULT_REGTEST_ELECTRUM }
        : { host: '', port: 50002, tls: true },
    // Desktop has no bundled Tor daemon. New wallets choose a reachable
    // primary explicitly; saved profiles keep the node their owner selected.
    primaryUri: network === 'mainnet' && !(typeof window !== 'undefined' && window.chicoryDesktop)
      ? DEFAULT_PRIMARY_URI : '',
    // The local service owns native TCP and optional configured Tor transport.
    transport: 'native',
    relayUrl: '',
    relayToken: '',
  };
}
export function defaultPreferences(): NetworkPreferences {
  return {
    version: 1,
    selectedNetwork: 'mainnet',
    profiles: {
      mainnet: defaultProfile('mainnet'),
      testnet: defaultProfile('testnet'),
      regtest: defaultProfile('regtest'),
    },
  };
}
export function validateProfile(
  profile: NetworkProfile,
  requireConnection = false,
) {
  if (
    !profile ||
    !isNetwork(profile.network) ||
    !profile.electrum ||
    typeof profile.electrum.host !== 'string' ||
    !Number.isInteger(profile.electrum.port) ||
    profile.electrum.port < 1 ||
    profile.electrum.port > 65535 ||
    typeof profile.electrum.tls !== 'boolean' ||
    typeof profile.primaryUri !== 'string' ||
    !['native', 'relay'].includes(profile.transport) ||
    typeof profile.relayUrl !== 'string' ||
    typeof profile.relayToken !== 'string'
  )
    throw new Error('Network settings are invalid.');
  if (requireConnection && !profile.electrum.host.trim())
    throw new Error(`Add an Electrum server for ${profile.network}.`);
}
export async function loadNetworkPreferences(): Promise<NetworkPreferences> {
  const saved = await Keychain.getGenericPassword({ service: SERVICE });
  if (!saved) return defaultPreferences();
  const value = JSON.parse(saved.password) as NetworkPreferences;
  if (
    value.version !== 1 ||
    !isNetwork(value.selectedNetwork) ||
    !value.profiles ||
    (value.legacyNetwork !== undefined &&
      value.legacyNetwork !== null &&
      !isNetwork(value.legacyNetwork))
  )
    throw new Error('Saved network settings are invalid.');
  for (const network of NETWORKS) {
    validateProfile(value.profiles[network]);
    if (value.profiles[network].network !== network)
      throw new Error('Network profile does not match its storage slot.');
  }
  // A regtest profile that was never given a server adopts the one this build
  // ships with. A blank host is not a setting anyone chose: the wallet refuses
  // to open on it. A server that was actually typed is never replaced, and
  // nothing is written back from here, because a loader with a side effect is
  // a trap. The first save persists it.
  if (!value.profiles.regtest.electrum.host.trim())
    value.profiles.regtest.electrum = { ...DEFAULT_REGTEST_ELECTRUM };
  return value;
}
export async function saveNetworkPreferences(value: NetworkPreferences) {
  for (const network of NETWORKS) {
    validateProfile(value.profiles[network]);
    if (value.profiles[network].network !== network)
      throw new Error('Network profile does not match its storage slot.');
  }
  if (!isNetwork(value.selectedNetwork))
    throw new Error('Select a supported network.');
  const saved = await Keychain.setGenericPassword(
    'beignet-networks',
    JSON.stringify(value),
    {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!saved) throw new Error('Could not save network settings securely.');
}
export function storageNamespace(
  network: Network,
  legacyNetwork?: Network | null,
): Network | 'legacy' {
  if (!isNetwork(network)) throw new Error('Select a supported network.');
  return network === legacyNetwork ? 'legacy' : network;
}
export function assertWalletNetwork(
  wallets: { network: string }[],
  network: Network,
) {
  if (wallets.some(wallet => wallet.network !== network))
    throw new Error(
      'Wallet storage belongs to another network. Its funds and state were preserved.',
    );
}
