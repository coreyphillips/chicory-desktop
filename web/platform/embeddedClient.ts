import { loadNetworkPreferences, validateProfile } from '../chicory/src/services/networks';
import type { NetworkPreferences, NetworkProfile } from '../chicory/src/services/networks';

export type DeviceSettings = NetworkProfile;
export function loadDevicePreferences(): Promise<NetworkPreferences> { return loadNetworkPreferences(); }
export async function loadDeviceSettings(): Promise<DeviceSettings> {
  const value = await loadDevicePreferences();
  return value.profiles[value.selectedNetwork];
}
export function validateDeviceSettings(value: DeviceSettings): void {
  validateProfile(value, true);
  if (value.transport !== 'native' || value.relayUrl || value.relayToken)
    throw new Error('Networking and Tor are managed by the local wallet service. Renderer relays are unavailable.');
}
export async function openDeviceWallet(..._args: unknown[]): Promise<never> {
  throw new Error('Wallets must be opened through the authenticated local wallet service.');
}
