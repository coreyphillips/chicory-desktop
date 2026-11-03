import * as Keychain from 'react-native-keychain';
import type { Network } from '@beignet/wallet-core';
import { isNetwork } from './networks';

export interface WalletSession {
  /** Kept on the record so an existing saved session still validates. */
  mode: 'device';
  network: Network;
  walletId?: string;
  locked: boolean;
  prepared?: boolean;
  backupPending?: boolean;
}
const SERVICE = 'com.beignet.wallet.last-session';
/** Where a build that could connect to a wallet host kept its credential. */
const LEGACY_CONNECTION_SERVICE = 'com.beignet.wallet.connection';
function validate(value: WalletSession) {
  if (
    !value ||
    value.mode !== 'device' ||
    !isNetwork(value.network) ||
    (value.walletId !== undefined &&
      (typeof value.walletId !== 'string' || !value.walletId)) ||
    typeof value.locked !== 'boolean' ||
    (value.prepared !== undefined && typeof value.prepared !== 'boolean') ||
    (value.backupPending !== undefined &&
      typeof value.backupPending !== 'boolean')
  )
    throw new Error(
      'Saved wallet selection is invalid. Your wallet data was not changed.',
    );
}

/**
 * An earlier build could point this app at a wallet host. There is no host to
 * return to, so its bearer token has no use and should not sit in the keychain
 * for the life of the install. Clearing it unconditionally also covers the
 * install that saved credentials but never saved a session.
 */
async function forgetHostRemnants() {
  await Keychain.resetGenericPassword({
    service: LEGACY_CONNECTION_SERVICE,
  }).catch(() => false);
}

export async function loadWalletSession(): Promise<WalletSession | null> {
  const saved = await Keychain.getGenericPassword({ service: SERVICE });
  if (!saved) {
    await forgetHostRemnants();
    return null;
  }
  const value = JSON.parse(saved.password) as WalletSession;
  // A session saved against a wallet host is discarded rather than reported as
  // damage. Reporting it would greet an upgrade with "your saved wallet could
  // not be restored" for a wallet that is sitting on the phone, intact.
  if (value?.mode !== 'device') {
    await clearWalletSession().catch(() => {});
    await forgetHostRemnants();
    return null;
  }
  validate(value);
  return value;
}
export async function saveWalletSession(value: WalletSession) {
  validate(value);
  const result = await Keychain.setGenericPassword(
    'beignet-session',
    JSON.stringify(value),
    {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!result)
    throw new Error('Could not save your wallet selection securely.');
}
/** Service names only: no seed, encryption key or database is read or created. */
export async function hasSavedDeviceHint(): Promise<boolean> {
  const services = await Keychain.getAllGenericPasswordServices();
  return services.some(
    service =>
      service === 'com.beignet.wallet.embedded.settings' ||
      service === 'com.beignet.wallet.embedded.database-key' ||
      ['mainnet', 'testnet', 'regtest'].some(
        network =>
          service === `com.beignet.wallet.embedded.database-key.${network}`,
      ),
  );
}

export async function clearWalletSession() {
  const result = await Keychain.resetGenericPassword({ service: SERVICE });
  if (!result) throw new Error('Could not clear the saved wallet selection.');
}
