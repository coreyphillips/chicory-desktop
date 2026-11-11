/**
 * The gallery keeps to itself. vite.gallery.config.ts aliases the secure
 * store, clipboard and camera to the stand-ins beside this file, which
 * answer at once and remember only for the life of the page. This module is
 * imported first so the renderer guards are in place before any scene
 * module runs, and it refuses to start inside the production window.
 */
import { seal } from './breaches';
import { forget, setSupportedBiometry } from './keychain';
import { setHapticsPreference } from '../chicory/src/services/hapticsPreference';
import { AUTO_PAY_OFF, setAutoPayPreference } from '../chicory/src/services/autoPayPreference';
import type { AutoPay } from '../chicory/src/services/autoPayPreference';
import { defaultPreferences, saveNetworkPreferences } from '../chicory/src/services/networks';

seal();

/**
 * Forgets the balance face and mask a state chose, so the next opens shown
 * on `₿` and a state that hides the balance does not reveal it instead.
 */
export function forgetFace() {
  forget('com.beignet.wallet.balance-face');
  forget('com.beignet.wallet.balance-visibility');
}

/**
 * Settings > Auto-pay as a state needs it: off unless the state says
 * otherwise, so one that turns it on never pays a later state's scan.
 */
export function setAutoPay(next: AutoPay = AUTO_PAY_OFF) {
  setAutoPayPreference(next).catch(() => {});
}

/**
 * The biometry the gallery's store reports. The desktop lock reads none
 * (web/platform/lock.ts), so biometric states draw the desktop lock.
 */
export function setBiometry(kind: string | null) {
  setSupportedBiometry(kind);
}

// Network profiles already inspected for an older vault, so opening the
// network editor reads them here and never goes looking for one.
saveNetworkPreferences({ ...defaultPreferences(), legacyNetwork: null });
setHapticsPreference(false);
