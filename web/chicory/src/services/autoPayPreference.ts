import { useSyncExternalStore } from 'react';
import * as Keychain from 'react-native-keychain';

/**
 * Settings > Auto-pay (REDESIGN.md rule 5). Off unless the owner turns it
 * on. On, a Lightning code read by the camera whose total is within `share`
 * percent of the available balance pays as soon as it is priced, with no
 * hold (`autoPays` in `src/scenes/send/autoPay`).
 *
 * Kept in the secure store beside the haptics preference, the same way: one
 * entry, here a small JSON object holding whether it is on and the share, so
 * the share is kept while it is off. Like Haptics it belongs to this phone,
 * not a wallet, and a build without it installed over this one never reads
 * it.
 *
 * One value serves every reader. Send reads it as it decides, without
 * waiting, so it is read once at launch (`loadAutoPayPreference` in
 * App.tsx) and until that answers it reads as off, which pays nothing on
 * its own.
 */
const PREFERENCE = 'com.beignet.wallet.auto-pay';

export interface AutoPay {
  on: boolean;
  /** Percent of the available balance, 0 to 100 in steps of `SHARE_STEP`. */
  share: number;
}

/** The slider's detent, and the step a screen reader moves it by. */
export const SHARE_STEP = 5;
/** Where the share starts the first time Auto-pay is switched on. */
export const SHARE_DEFAULT = 50;

export const AUTO_PAY_OFF: AutoPay = Object.freeze({
  on: false,
  share: SHARE_DEFAULT,
});

/** A share held to 0 to 100 and to its detent. Anything else is the default. */
export function snapShare(share: unknown): number {
  if (typeof share !== 'number' || !Number.isFinite(share)) {
    return SHARE_DEFAULT;
  }
  const clamped = Math.min(100, Math.max(0, share));
  return Math.round(clamped / SHARE_STEP) * SHARE_STEP;
}

/** What the store holds, read leniently: anything unreadable is off at 50%. */
export function parseAutoPay(saved: string | null | undefined): AutoPay {
  if (!saved) return AUTO_PAY_OFF;
  try {
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object') return AUTO_PAY_OFF;
    const { on, share } = value as { on?: unknown; share?: unknown };
    return { on: on === true, share: snapShare(share) };
  } catch {
    return AUTO_PAY_OFF;
  }
}

let current: AutoPay = AUTO_PAY_OFF;
const listeners = new Set<() => void>();

/** The preference as last read or saved; off until the store has answered. */
export const autoPayNow = () => current;

function publish(next: AutoPay) {
  if (next.on === current.on && next.share === current.share) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads the saved preference and makes it the one every reader sees. */
export async function loadAutoPayPreference(): Promise<AutoPay> {
  let read = AUTO_PAY_OFF;
  try {
    const saved = await Keychain.getGenericPassword({ service: PREFERENCE });
    read = parseAutoPay(saved ? saved.password : null);
  } catch {
    // An unreadable store pays nothing on its own.
  }
  publish(read);
  return read;
}

/** Saves the choice, then applies it. A save that fails changes nothing. */
export async function setAutoPayPreference(next: AutoPay): Promise<void> {
  const value: AutoPay = { on: next.on === true, share: snapShare(next.share) };
  const saved = await Keychain.setGenericPassword(
    'beignet-auto-pay',
    JSON.stringify(value),
    {
      service: PREFERENCE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!saved) throw new Error('Could not save the auto-pay setting.');
  publish(value);
}

/** The preference every reader shares, kept current as it is saved. */
export function useAutoPay(): AutoPay {
  return useSyncExternalStore(subscribe, autoPayNow);
}
