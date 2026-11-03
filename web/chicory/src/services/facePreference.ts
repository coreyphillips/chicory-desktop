import * as Keychain from 'react-native-keychain';
import type { Unit } from '../theme';

/**
 * The face the balance is drawn in, kept from one launch to the next: sats as
 * `2,000 sats`, sats after the bitcoin sign as `₿2,000` (BIP 177), or BTC.
 * A new wallet opens on `₿`.
 *
 * Kept in the secure store beside the haptics preference, the same way: one
 * entry holding "sats", "symbol" or "btc". A build that never reads it simply
 * opens on its own default.
 */
const PREFERENCE = 'com.beignet.wallet.balance-face';

export interface Face {
  unit: Unit;
  symbol: boolean;
}

/** What the balance opens in when nothing is saved: `₿2,000`. */
export const DEFAULT_FACE: Face = { unit: 'sats', symbol: true };

const NAMES: Record<string, Face> = {
  sats: { unit: 'sats', symbol: false },
  symbol: { unit: 'sats', symbol: true },
  btc: { unit: 'btc', symbol: false },
};

const nameOf = (face: Face) =>
  face.unit === 'btc' ? 'btc' : face.symbol ? 'symbol' : 'sats';

/** The saved face. Nothing saved, or an unreadable store, means `₿`. */
export async function loadFacePreference(): Promise<Face> {
  try {
    const saved = await Keychain.getGenericPassword({ service: PREFERENCE });
    return (saved && NAMES[saved.password]) || DEFAULT_FACE;
  } catch {
    return DEFAULT_FACE;
  }
}

/**
 * Saves the face. A save that fails is let go: the balance is still drawn in
 * the face tapped to, and the next launch opens on the last one saved.
 */
export async function saveFacePreference(face: Face): Promise<void> {
  try {
    await Keychain.setGenericPassword('beignet-balance-face', nameOf(face), {
      service: PREFERENCE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    // Nothing to undo; see above.
  }
}
