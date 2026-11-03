/**
 * Compatibility for the native UI's public preferences.
 * This is browser storage, with no secure-store guarantees. Wallet seeds,
 * database keys, access tokens and protected entries are never accepted.
 */
type Options = {
  service?: string;
  accessible?: unknown;
  accessControl?: unknown;
  authenticationPrompt?: unknown;
};
type Entry = { username: string; password: string; service: string };
const PREFIX = 'chicory:public-preference:';
const memory = new Map<string, Entry>();
const NAME = 'com.beignet.wallet.';
const durable = new Set([
  `${NAME}haptics`,
  `${NAME}balance-face`,
  `${NAME}auto-pay`,
  `${NAME}network-profiles`,
  `${NAME}last-session`,
]);
const offlinePrefix = `${NAME}offline-request.`;
const snapshotPrefix = `${NAME}last-snapshot`;

export const ACCESSIBLE = Object.freeze({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'browser-public-preference',
});
export const ACCESS_CONTROL = Object.freeze({
  BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'unavailable',
});

function isAllowed(service: string): boolean {
  return durable.has(service) || service.startsWith(offlinePrefix) ||
    service === snapshotPrefix || service.startsWith(`${snapshotPrefix}.`);
}
function isDurable(service: string): boolean {
  return durable.has(service) || service.startsWith(offlinePrefix);
}
function publicValue(service: string, password: string): void {
  if (service === `${NAME}haptics` && !['on', 'off'].includes(password))
    throw new Error('Invalid haptics preference.');
  if (service === `${NAME}balance-face` && !['sats', 'symbol', 'btc'].includes(password))
    throw new Error('Invalid balance display preference.');
  if (service === `${NAME}haptics` || service === `${NAME}balance-face`) return;
  const value = JSON.parse(password);
  const only = (item: unknown, keys: string[]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !keys.includes(key)))
      throw new Error('Invalid public browser preference.');
  };
  if (service === `${NAME}auto-pay`) {
    only(value, ['on', 'share']);
    if (typeof value.on !== 'boolean' || typeof value.share !== 'number' ||
        !Number.isFinite(value.share) || value.share < 0 || value.share > 100)
      throw new Error('Invalid auto-pay preference.');
  }
  if (service === `${NAME}last-session`) {
    only(value, ['mode', 'network', 'walletId', 'locked', 'prepared', 'backupPending']);
    if (value.mode !== 'device' || !['mainnet', 'testnet', 'regtest'].includes(value.network) ||
        typeof value.locked !== 'boolean' ||
        (value.walletId !== undefined && typeof value.walletId !== 'string'))
      throw new Error('Invalid wallet selection.');
  }
  if (service.startsWith(offlinePrefix)) {
    only(value, ['id', 'amountSats', 'description']);
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{16,160}$/.test(value.id) ||
        !Number.isSafeInteger(value.amountSats) || value.amountSats <= 0 ||
        typeof value.description !== 'string')
      throw new Error('Invalid saved payment request.');
  }
  if (service === `${NAME}network-profiles`) {
    only(value, ['version', 'selectedNetwork', 'legacyNetwork', 'profiles']);
    only(value.profiles, ['mainnet', 'testnet', 'regtest']);
    for (const network of ['mainnet', 'testnet', 'regtest']) {
      const profile = value.profiles[network];
      only(profile, ['network', 'electrum', 'primaryUri', 'transport', 'relayUrl', 'relayToken']);
      only(profile.electrum, ['host', 'port', 'tls']);
      if (profile.relayToken !== '' || profile.relayUrl !== '' || profile.transport !== 'native')
        throw new Error('Connection credentials and relays are managed by the local wallet service.');
    }
  }
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/^(mnemonic|seed|privateKey|secret|password|token|apiToken|accessToken|encryptionKey|databaseKey)$/i.test(key))
        throw new Error('Secret wallet data cannot be saved in browser preferences.');
      if (/token$/i.test(key) && child !== '' && child !== undefined && child !== null)
        throw new Error('Access tokens cannot be saved in browser preferences.');
      visit(child);
    }
  };
  visit(value);
}

export async function setGenericPassword(username: string, password: string, options: Options = {}): Promise<true> {
  const service = options.service ?? '';
  if (!isAllowed(service) || options.accessControl || options.authenticationPrompt)
    throw new Error('Secure device storage is unavailable in the browser.');
  publicValue(service, password);
  const entry = { username, password, service };
  if (isDurable(service)) {
    // Failure propagates so a payment preference never claims to be saved.
    globalThis.localStorage.setItem(PREFIX + service, JSON.stringify(entry));
  }
  memory.set(service, entry);
  return true;
}

export async function getGenericPassword(options: Options = {}): Promise<Entry | false> {
  const service = options.service ?? '';
  if (!isAllowed(service) || options.authenticationPrompt) return false;
  const cached = memory.get(service);
  if (cached) return { ...cached };
  if (!isDurable(service)) return false;
  const raw = globalThis.localStorage.getItem(PREFIX + service);
  if (!raw) return false;
  const entry = JSON.parse(raw) as Entry;
  if (entry.service !== service || typeof entry.password !== 'string' || typeof entry.username !== 'string') return false;
  publicValue(service, entry.password);
  return { ...entry };
}

export async function resetGenericPassword(options: Options = {}): Promise<true> {
  const service = options.service ?? '';
  memory.delete(service);
  if (isAllowed(service)) globalThis.localStorage.removeItem(PREFIX + service);
  return true;
}

export async function getAllGenericPasswordServices(): Promise<string[]> {
  const services = new Set(memory.keys());
  for (let i = 0; i < globalThis.localStorage.length; i++) {
    const key = globalThis.localStorage.key(i);
    if (key?.startsWith(PREFIX) && isAllowed(key.slice(PREFIX.length)))
      services.add(key.slice(PREFIX.length));
  }
  return [...services];
}

export async function getSupportedBiometryType(): Promise<null> { return null; }
