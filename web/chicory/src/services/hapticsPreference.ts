import { useCallback, useEffect, useState } from 'react';
import * as Keychain from 'react-native-keychain';
import { setHapticsEnabled } from './haptics';

/**
 * Settings > Haptics (REDESIGN.md rule 7). Outside Settings a haptic often
 * carries part of what a word used to, so they are on unless the owner turns
 * them off here. Reduce Motion never does.
 *
 * Kept in the secure store beside the lock preference, the same way: one
 * entry holding "on" or "off". It is the one service the redesign adds, and a
 * build of main installed over this one simply never reads it.
 */
const PREFERENCE = 'com.beignet.wallet.haptics';

/** Whether haptics are on. Nothing saved, or an unreadable store, means on. */
export async function loadHapticsPreference(): Promise<boolean> {
  try {
    const saved = await Keychain.getGenericPassword({ service: PREFERENCE });
    return !saved || saved.password !== 'off';
  } catch {
    return true;
  }
}

/** Saves the choice, then applies it. A save that fails changes nothing. */
export async function setHapticsPreference(on: boolean): Promise<void> {
  const saved = await Keychain.setGenericPassword(
    'beignet-haptics',
    on ? 'on' : 'off',
    {
      service: PREFERENCE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!saved) throw new Error('Could not save the haptics setting.');
  setHapticsEnabled(on);
}

/**
 * The saved preference, applied as soon as it is read, and a setter that
 * saves and applies a change. It reads as on until the store answers, which
 * is what the app does anyway before it knows.
 */
export function useHapticsPreference(): {
  on: boolean;
  set: (on: boolean) => Promise<void>;
} {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let active = true;
    loadHapticsPreference().then(value => {
      setHapticsEnabled(value);
      if (active) setOn(value);
    });
    return () => {
      active = false;
    };
  }, []);
  const set = useCallback(async (next: boolean) => {
    await setHapticsPreference(next);
    setOn(next);
  }, []);
  return { on, set };
}
